'use strict';

// rultracer Phase 8 — Tcl bytecode disassembler endpoint.
//
//   GET  /mgmt/shared/rultracer/disasm            -> { ok, enabled }
//   POST /mgmt/shared/rultracer/disasm { script } -> { ok, output, warnings[] }
//                                                     (or { ok, compileError })
//   POST /mgmt/shared/rultracer/disasm { action: 'enable'|'disable' }
//                                                  -> { ok, enabled }
//
// Opt-in: the `disasmEnabled` settings flag defaults OFF; a disassemble request
// is refused unless it is on. The flag is flipped via the action POST above (the
// panel's "Enable disassembler" control), so there is no global Settings view.
//
// Safety (see PLAN Phase 8 + proto/disasm-proto.js, proven on-box):
//   - runs `tclsh` via child_process.execFile as the uid-198 worker, NOT the
//     util/bash root channel. tclsh has no history-file write problem, so plain
//     execFile works and keeps this off root.
//   - the user body travels in an ENV VAR (data), fed to a FIXED wrapper on
//     stdin that does `tcl::unsupported::disassemble script $body`. The body is
//     never spliced into the command's braces, so there is no `} ; exec ; {`
//     breakout, and `disassemble` COMPILES without executing (injection probe
//     proven: `exec touch …` compiled but did not run).
//   - timeout + input/output size caps.
//
// ES5 syntax only (restnoded Node 6.9.1): var/function, no arrow/const/let/
// template literals, decimal file modes, Promises ok.

var execFile = require('child_process').execFile;
var settings = require('./settings');
var restutil = require('./restutil');
var logger = require('./logger');

var TCLSH = '/usr/bin/tclsh';
var TIMEOUT_MS = 5000;
var MAX_OUTPUT = 1 << 20;      // 1 MiB output cap (maxBuffer)
var MAX_INPUT = 256 * 1024;    // 256 KiB input cap (a scratchpad, not a file)
var ENV_KEY = 'RULTRACER_DISASM_BODY';

// Fixed wrapper. No user text is interpolated; the body comes from the
// environment as data. `catch` turns a Tcl compile error (or a missing
// tcl::unsupported namespace) into a clean DISASM_ERROR stderr line.
var WRAPPER = [
    'set body $env(' + ENV_KEY + ')',
    'if {[catch {tcl::unsupported::disassemble script $body} result]} {',
    '    puts stderr "DISASM_ERROR: $result"',
    '    exit 1',
    '}',
    'puts $result'
].join('\n');

function DisasmWorker() {}
DisasmWorker.prototype.WORKER_URI_PATH = 'shared/rultracer/disasm';
DisasmWorker.prototype.isPublic = true;

DisasmWorker.prototype.onStart = function (success) {
    this.dataDir = restutil.dataDir();
    success();
};

DisasmWorker.prototype.onGet = function (restOperation) {
    var self = this;
    settings.load(this.dataDir).then(function (cfg) {
        restutil.ok(self, restOperation, { enabled: cfg.disasmEnabled === true });
    }).catch(function (err) { restutil.fail(self, restOperation, err); });
};

DisasmWorker.prototype.onPost = function (restOperation) {
    var self = this;
    var body = restOperation.getBody() || {};

    // Flip the opt-in flag (the panel's enable/disable control).
    if (body.action === 'enable' || body.action === 'disable') {
        var on = body.action === 'enable';
        settings.save(this.dataDir, { disasmEnabled: on }).then(function () {
            restutil.ok(self, restOperation, { enabled: on });
        }).catch(function (err) { restutil.fail(self, restOperation, err); });
        return;
    }

    // Otherwise, a disassemble request — gated on the flag.
    var script = body.script;
    if (typeof script !== 'string') {
        return restutil.fail(self, restOperation, new Error('missing "script" string'));
    }
    if (script.length > MAX_INPUT) {
        return restutil.fail(self, restOperation, new Error('script too large (max ' + MAX_INPUT + ' bytes)'));
    }

    settings.load(this.dataDir).then(function (cfg) {
        if (cfg.disasmEnabled !== true) {
            // Backstop: the UI gates on GET enabled, but refuse here too.
            restOperation.setStatusCode(200);
            restOperation.setBody({ ok: false, enabled: false,
                error: 'disassembler is disabled — enable it in the panel first' });
            self.completeRestOperation(restOperation);
            return;
        }
        disassemble(script, function (res) {
            if (res.err && res.err.killed) {
                return restutil.fail(self, restOperation, new Error('disassembly timed out (' + TIMEOUT_MS + ' ms)'));
            }
            // Tcl compile error (or missing namespace) — surface it verbatim;
            // ok:true so the browser shows it as feedback, not a transport error.
            if (res.stderr && res.stderr.indexOf('DISASM_ERROR:') !== -1) {
                var msg = res.stderr.replace(/^[\s\S]*?DISASM_ERROR:\s*/, '').replace(/\s+$/, '');
                return restutil.ok(self, restOperation, { output: '', compileError: msg, warnings: [] });
            }
            if (res.err) {
                var code = res.err.code;
                if (code === 'ENOENT') {
                    return restutil.fail(self, restOperation, new Error('tclsh not found at ' + TCLSH));
                }
                return restutil.fail(self, restOperation, new Error('tclsh failed' + (code ? ' (' + code + ')' : '') + (res.stderr ? ': ' + res.stderr : '')));
            }
            restutil.ok(self, restOperation, { output: res.stdout.replace(/\s+$/, ''), warnings: [] });
        });
    }).catch(function (err) { restutil.fail(self, restOperation, err); });
};

// Run the fixed wrapper through tclsh with the body in an env var. Calls back
// with { stdout, stderr, err }. Lifted from proto/disasm-proto.js.
function disassemble(bodyText, cb) {
    var env = {};
    for (var k in process.env) {
        if (Object.prototype.hasOwnProperty.call(process.env, k)) { env[k] = process.env[k]; }
    }
    env[ENV_KEY] = bodyText;
    var child = execFile(TCLSH, [], { env: env, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT },
        function (err, stdout, stderr) {
            cb({ stdout: stdout || '', stderr: stderr || '', err: err || null });
        });
    // Swallow stream errors (e.g. EPIPE if tclsh is missing) so they surface via
    // the execFile callback instead of crashing restnoded.
    if (child.stdin) {
        child.stdin.on('error', function () {});
        try { child.stdin.write(WRAPPER); child.stdin.end(); } catch (e) { logger.warning('disasm stdin write failed:', e); }
    }
}

module.exports = DisasmWorker;
