// rultracer Phase 8 — Tcl bytecode disassembler client seam (window.RPDisasm).
//
// PURE: no DOM, no fetch, no d3. Strict ES5 / Node-6.9.1-safe (var/function
// only, no arrow / const / let / template literals / optional chaining) so
// test/phase8.js exercises it under the on-box restnoded Node as well as
// headless JavaScriptCore. The DisasmWorker runs `tclsh`; this seam only
// (a) extracts the disassemblable body from an iRule `when {}` wrapper, and
// (b) parses the raw tclsh disassembly text into structured rows for the
// "structured table" view. Both are exercised against fixtures in test/phase8.js.
//
// Why the when-strip lives here (not in the worker): `when` is itself an iRule
// command, so tclsh treats it as an unknown command and compiles the body as a
// bare string literal (`push1 N  # " set x 1 "`). To disassemble the body you
// must extract it first. Handlers allow modifiers between the event name and the
// body brace (`when CLIENT_ACCEPTED priority 300 timing on { ... }`), so we
// capture to the FIRST `{` after the `when` header, then brace-count to its
// match. See PLAN "`when`-block extraction (precise rule)".
(function () {
  'use strict';

  // Matches a handler header: `when`, an EVENT name, then any modifiers
  // (priority N, timing on|off — none contain a brace), then the body's opening
  // `{`. The match END is the position just past that `{`.
  var WHEN_RE = /\bwhen\s+[A-Z][A-Z0-9_]*\b[^{]*\{/g;

  // Brace-count from `src[open]` (which must be `{`) to its matching `}`.
  // Skips backslash-escaped braces. Returns the index of the matching `}`, or
  // -1 if the braces never balance (unterminated body).
  function matchBrace(src, open) {
    var depth = 0;
    for (var i = open; i < src.length; i++) {
      var ch = src.charAt(i);
      if (ch === '\\') { i++; continue; } // skip the escaped char
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) { return i; }
      }
    }
    return -1;
  }

  // Extract the disassemblable body/bodies from a pasted snippet.
  //
  // Returns { bodies: [{label, body}], wrapped: bool, warnings: [string] }.
  //   - No `when` header  -> one body, label null, wrapped false, no warnings
  //     (the whole snippet is compiled as-is).
  //   - One or more `when` headers -> one entry per handler, label = the header
  //     text without the `when` keyword and the trailing `{`
  //     (e.g. "CLIENT_ACCEPTED priority 300"), body = the brace-counted body.
  //     wrapped true; warnings describe what was stripped / any anomalies.
  // Text outside any handler's braces (e.g. a leading `timing off`) is discarded
  // with a warning.
  function extractHandlers(src) {
    src = (src === null || src === undefined) ? '' : String(src);
    var warnings = [];
    var bodies = [];
    WHEN_RE.lastIndex = 0;

    var matches = [];
    var m;
    while ((m = WHEN_RE.exec(src)) !== null) {
      matches.push({ index: m.index, end: WHEN_RE.lastIndex, text: m[0] });
      if (m.index === WHEN_RE.lastIndex) { WHEN_RE.lastIndex++; } // guard against zero-length
    }

    if (matches.length === 0) {
      return { bodies: [{ label: null, body: src }], wrapped: false, warnings: warnings };
    }

    // Header text -> label: drop the leading `when`, drop the trailing `{`, trim.
    function labelOf(headerText) {
      var lbl = headerText.replace(/\{\s*$/, '');           // trailing brace
      lbl = lbl.replace(/^\s*when\s+/, '');                 // leading `when`
      return lbl.replace(/\s+/g, ' ').replace(/\s+$/, '').replace(/^\s+/, '');
    }

    var prevEnd = 0;
    var sawGap = false;
    for (var i = 0; i < matches.length; i++) {
      var hdr = matches[i];
      // Anything non-whitespace between the previous handler's close and this
      // header is outside a handler -> discard with a warning (once).
      var gap = src.slice(prevEnd, hdr.index);
      if (/\S/.test(gap)) { sawGap = true; }

      var open = hdr.end - 1;            // the `{` the regex stopped on
      var close = matchBrace(src, open);
      var label = labelOf(hdr.text);
      if (close === -1) {
        warnings.push('Handler "' + label + '" has unbalanced braces — no matching "}"; disassembling to end of input.');
        bodies.push({ label: label, body: src.slice(open + 1) });
        prevEnd = src.length;
        break;
      }
      bodies.push({ label: label, body: src.slice(open + 1, close) });
      prevEnd = close + 1;
    }

    // Trailing text after the last handler.
    if (/\S/.test(src.slice(prevEnd))) { sawGap = true; }

    warnings.push('Stripped the iRule handler wrapper(s); disassembling only the handler body — `when` itself is an iRule command tclsh cannot compile.');
    if (matches.length > 1) {
      warnings.push('Found ' + matches.length + ' handlers; each body is disassembled separately, labeled by its header.');
    }
    if (sawGap) {
      warnings.push('Discarded text outside the handler brace(s) (e.g. a top-level `timing` directive) — only handler bodies are compiled.');
    }

    return { bodies: bodies, wrapped: true, warnings: warnings };
  }

  // --- raw disassembly parsing ---------------------------------------------

  var CMD_RE = /^\s*Command\s+(\d+):\s*(.*)$/;
  var INST_RE = /^\s*\((\d+)\)\s+(\S+)(.*)$/;
  var META_CMDS = /\bCmds\s+(\d+)/;
  var META_INST = /\binst\s+(\d+)/;
  var META_LIT = /\blitObjs\s+(\d+)/;
  var META_STK = /\bstkDepth\s+(\d+)/;

  // Strip one layer of surrounding double quotes from a Command's src string.
  function unquote(s) {
    s = s.replace(/\s+$/, '');
    if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
      return s.slice(1, s.length - 1);
    }
    return s;
  }

  // Split an instruction's trailing text into { operands, comment }. The `#`
  // comment carries the recovered operand literal (`# "3"`) or a pc note
  // (`# pc 39`) — the whole point of the disassembler. Operand text has no `#`.
  function splitOperands(rest) {
    var m = /^([\s\S]*?)\s*#\s?([\s\S]*)$/.exec(rest);
    if (m) {
      return { operands: m[1].replace(/\s+$/, '').replace(/^\s+/, ''),
               comment: m[2].replace(/\s+$/, '') };
    }
    return { operands: rest.replace(/\s+$/, '').replace(/^\s+/, ''), comment: null };
  }

  // Parse raw tclsh disassembly text into { meta, commands, warnings }.
  //   meta     = { cmds, inst, litObjs, stkDepth } (numbers, or null if absent)
  //   commands = [{ index, src, instructions: [{ pc, opcode, operands, comment }] }]
  // Tolerates: the truncated `Source "…"` header (ignored — use per-Command
  // src), the `Commands N:` index, `Exception ranges` blocks (skipped), and
  // empty/container Command blocks (header with no instruction rows).
  function parse(rawText) {
    rawText = (rawText === null || rawText === undefined) ? '' : String(rawText);
    var lines = rawText.split('\n');
    var meta = { cmds: null, inst: null, litObjs: null, stkDepth: null };
    var commands = [];
    var warnings = [];
    var cur = null;        // current Command block
    var inExc = false;     // inside an `Exception ranges` block

    function num(re, line) { var m = re.exec(line); return m ? parseInt(m[1], 10) : null; }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!/\S/.test(line)) { continue; }

      // Cost summary line: "Cmds N, ... inst N, ... litObjs N, ... stkDepth N".
      if (META_CMDS.test(line) && META_INST.test(line)) {
        var c = num(META_CMDS, line); if (c !== null) { meta.cmds = c; }
        var n = num(META_INST, line); if (n !== null) { meta.inst = n; }
        var l = num(META_LIT, line); if (l !== null) { meta.litObjs = l; }
        var s = num(META_STK, line); if (s !== null) { meta.stkDepth = s; }
        continue;
      }

      // Exception ranges block: skip its header and entries until the next
      // Command/instruction line resumes real content.
      if (/^\s*Exception ranges\b/.test(line)) { inExc = true; continue; }

      var cm = CMD_RE.exec(line);
      if (cm) {
        inExc = false;
        cur = { index: parseInt(cm[1], 10), src: unquote(cm[2]), instructions: [] };
        commands.push(cur);
        continue;
      }

      var im = INST_RE.exec(line);
      if (im) {
        inExc = false;
        var parts = splitOperands(im[3]);
        var row = { pc: parseInt(im[1], 10), opcode: im[2],
                    operands: parts.operands, comment: parts.comment };
        if (cur) { cur.instructions.push(row); }
        else {
          // Instructions before any Command header (shouldn't happen) — park
          // them in an implicit block so nothing is lost.
          cur = { index: 0, src: '', instructions: [row] };
          commands.push(cur);
        }
        continue;
      }
      // Everything else (ByteCode header, Source "...", Commands index,
      // exception-range entries, blank lines) is intentionally ignored.
    }

    if (commands.length === 0 && /\S/.test(rawText)) {
      warnings.push('No Command blocks found in the disassembly output.');
    }
    return { meta: meta, commands: commands, warnings: warnings };
  }

  window.RPDisasm = {
    extractHandlers: extractHandlers,
    matchBrace: matchBrace,
    parse: parse
  };
})();
