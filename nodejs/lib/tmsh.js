'use strict';

// Runs tmsh by POSTing to /mgmt/tm/util/bash on the localhost:8100 trusted
// channel. This endpoint runs the bash command as ROOT, which sidesteps the
// fatal `framework/CmdHistoryFile.cpp:92 "Permission denied"` failure that
// hits child_process.execFile -- the restnoded worker runs as uid 198 and
// tmsh on TMOS 21.x ignores $HOME, so it can neither traverse /root nor
// write /root/.tmsh-history-root. Diagnosed via the worker's own runtime log
// ("tmsh-runtime uid=198 gid=198") and reproduced on the live VE box.
//
// This matches rulbased's Phase-8.5 lesson learned (see its PLANNING.md):
//   "tmsh load sys config merge file ... invoked via POST /mgmt/tm/util/bash
//    instead of child_process -- which runs as root and avoids the history-
//    file problem entirely."
//
// Quoting layers (single string per call, no surprises):
//   1. JSON encodes the utilCmdArgs value, escaping `"` as `\"`.
//   2. utilCmdArgs is bash's full argv: `-c "tmsh -c '<TMSH_CMD>'"`.
//   3. Inside bash, the inner tmsh command is single-quoted so braces,
//      spaces, and dollar signs pass through unmolested.
//   4. tmsh -c parses the inner command literally.
// Object names are validated upstream to reject single quotes, so the inner
// single-quoting can never be broken by user input. ES5 syntax only.

var iremote = require('./iremote');
var logger = require('./logger');

// Match tmsh's structured error markers. Adopted from rulbased's bigipClient
// _parseTmshError so wording is consistent.
var ERROR_PATTERNS = [
    /^[0-9a-f]{6,8}:[0-9]+:/i,           // mcpd / tmsh hex error code prefix
    /^exception:/i,                       // tmsh runtime exception
    /\bSyntax Error\b/i,                  // tmsh parser
    /:\s*[0-9]+:\s*error:/i               // file:line:error:
];

function looksLikeError(text) {
    if (!text) { return false; }
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        for (var p = 0; p < ERROR_PATTERNS.length; p++) {
            if (ERROR_PATTERNS[p].test(lines[i])) { return true; }
        }
    }
    return false;
}

// Strip the mcpd error-code prefix and "Rule [/p/n] error:" wrapper so the
// surfaced message reads cleanly.
function cleanError(text) {
    return String(text).split(/\r?\n/).map(function (ln) {
        return ln
            .replace(/^[0-9a-f]{6,8}:[0-9]+:\s*/i, '')
            .replace(/^Rule\s+\[\/[^\]]+\]\s+error:\s*/i, '')
            .trim();
    }).filter(function (ln) { return ln.length > 0; }).join('\n');
}

function buildUtilCmdArgs(tmshCmd) {
    if (tmshCmd.indexOf("'") !== -1) {
        // validate.assertName already rejects names with quotes; this is a
        // defense-in-depth check for the assembled command string itself.
        throw new Error('tmsh command may not contain a single quote');
    }
    return '-c "tmsh -c \'' + tmshCmd + '\'"';
}

// Run a single tmsh command string (e.g. "create ltm rule-profiler rt1 ...").
// Resolves { stdout, stderr } (stderr always empty -- bash util returns one
// commandResult blob); rejects with an Error whose message has the cleaned
// tmsh error text.
function run(cmd, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
        var utilCmdArgs;
        try { utilCmdArgs = buildUtilCmdArgs(cmd); }
        catch (e) { reject(e); return; }
        var body = { command: 'run', utilCmdArgs: utilCmdArgs };
        logger.fine('util/bash tmsh -c', cmd);
        iremote.post('/mgmt/tm/util/bash', body).then(function (result) {
            var commandResult = (result && result.commandResult) || '';
            if (looksLikeError(commandResult)) {
                var e = new Error('tmsh failed: ' + cmd + ' :: ' + cleanError(commandResult));
                e.cmd = cmd;
                e.stdout = commandResult;
                reject(e);
                return;
            }
            resolve({ stdout: commandResult, stderr: '' });
        }, function (err) {
            var e = new Error('tmsh failed: ' + cmd + ' :: ' + err.message);
            e.cmd = cmd;
            e.cause = err;
            reject(e);
        });
    });
}

// Run a command but never reject -- resolves { ok, stdout, stderr, error }.
function runSafe(cmd, opts) {
    return run(cmd, opts).then(
        function (res) { return { ok: true, stdout: res.stdout, stderr: res.stderr }; },
        function (err) { return { ok: false, stdout: err.stdout || '', stderr: '', error: err.message }; }
    );
}

// Run a plain bash command via /mgmt/tm/util/bash (also as root). Resolves the
// raw commandResult as stdout; does NOT parse for tmsh-style errors (bash
// commands can legitimately exit non-zero, e.g. grep when no matches). Used to
// run prebuilt /var/tmp/*.sh scripts so we don't have to inline-quote complex
// shell.
//
// SECURITY CONTRACT: bashCmd is dropped verbatim inside `bash -c "<bashCmd>"`
// and runs as ROOT — it performs NO escaping. Callers MUST pass only literal
// commands or values they have already validated/quoted (e.g. capture.js
// guards filePath and single-quotes its temp paths). Never pass unvalidated
// request input here.
function runBash(bashCmd) {
    return new Promise(function (resolve, reject) {
        var body = { command: 'run', utilCmdArgs: '-c "' + bashCmd + '"' };
        logger.fine('util/bash:', bashCmd);
        iremote.post('/mgmt/tm/util/bash', body).then(function (result) {
            resolve({ stdout: (result && result.commandResult) || '', stderr: '' });
        }, function (err) {
            reject(new Error('bash failed: ' + bashCmd + ' :: ' + err.message));
        });
    });
}

module.exports = {
    run: run,
    runSafe: runSafe,
    runBash: runBash,
    // exposed for tests
    _buildUtilCmdArgs: buildUtilCmdArgs,
    _looksLikeError: looksLikeError,
    _cleanError: cleanError
};
