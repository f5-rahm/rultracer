// rultracer Tcl bytecode opcode reference. Browser-side, but kept strictly
// Node-6.9.1-safe (ES5: var / function only, no arrow / const / template
// literals) so test/phase7.js can exercise it under the on-box restnoded Node
// as well as headless JavaScriptCore.
//
// Single source of truth for opcode meanings: BOTH the collapsed "Bytecode
// reference" panel table (rendered by app.js) AND the hover tooltips on the
// bytecode ticks in the sequence diagram (seqdiagram.js) come from TABLE here.
//
// rule-profiler emits only the instruction mnemonic for a CMD_BYTECODE
// occurrence (no operand/value), so `value` is the bare opcode (e.g. 'push1').
// `meaning` carries light inline HTML (<code>...</code>) for the panel cell;
// the tooltip path strips tags to plain text.
(function () {
  'use strict';

  var TABLE = [
    { op: 'push1', meaning: 'push a literal/constant onto the stack' },
    { op: 'loadScalarStk', meaning: 'load a scalar variable’s value' },
    { op: 'storeScalarStk', meaning: 'store into a scalar variable (surfaces as <code>VAR_MOD</code>)' },
    { op: 'invokeStk1', meaning: 'invoke a command (the following <code>CMD_VM</code> names it)' },
    { op: 'concat1', meaning: 'concatenate strings on the stack' },
    { op: 'eq', meaning: 'equality comparison (<code>==</code>)' },
    { op: 'done', meaning: 'end of the script’s byte code' }
  ];

  var BY_OP = {};
  for (var i = 0; i < TABLE.length; i++) { BY_OP[TABLE[i].op] = TABLE[i].meaning; }

  function stripTags(s) { return s.replace(/<[^>]+>/g, ''); }

  // Plain-text meaning for an opcode value, or null if unknown. Exact match
  // first; if the value ever carries a trailing operand (it does not today),
  // fall back to the leading whitespace-delimited token.
  function meaning(value) {
    if (value === null || value === undefined) { return null; }
    var v = String(value);
    var m = BY_OP[v];
    if (m === undefined) { m = BY_OP[v.split(/\s+/)[0]]; }
    return m === undefined ? null : stripTags(m);
  }

  // Tooltip text for a bytecode tick: "opcode — meaning", or null when the
  // opcode is not in the table (caller then renders no <title>).
  function tip(value) {
    var m = meaning(value);
    return m === null ? null : String(value) + ' — ' + m;
  }

  window.RPOpcodes = { table: TABLE, meaning: meaning, tip: tip };
})();
