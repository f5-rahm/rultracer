// rultracer Tcl bytecode opcode reference. Browser-side, but kept strictly
// Node-6.9.1-safe (ES5: var / function only, no arrow / const / template
// literals) so test/phase8.js can exercise it under the on-box restnoded Node
// as well as headless JavaScriptCore.
//
// Single source of truth for opcode meanings, shared by THREE consumers:
//   1. the "Bytecode reference & disassembler" panel table (rendered by app.js),
//   2. the hover tooltips on the bytecode ticks in the sequence diagram
//      (seqdiagram.js), and
//   3. the structured-table view of the Phase 8 disassembler (disasmview.js),
//      which cross-links each opcode mnemonic back to its meaning here.
//
// rule-profiler emits only the instruction mnemonic for a CMD_BYTECODE
// occurrence (no operand/value), so `value` is the bare opcode (e.g. 'push1').
// `meaning` carries light inline HTML (<code>...</code>) for the panel cell;
// the tooltip path strips tags to plain text.
//
// Two Tcl versions are in play (load-bearing — see PLAN Phase 8): the box's
// standalone `tclsh` is Tcl 8.5.13 (what the disassembler runs), but the iRule
// engine that produces the live trace is Tcl 8.4.6. A few opcodes only exist in
// 8.5 — they appear in the disassembler output but NEVER in the live trace.
// Those carry `v85: true` so the disassembler table can flag them; the trace's
// `streq` vs the disassembler's same `streq` mostly overlap, but the table
// covers both vocabularies.
(function () {
  'use strict';

  // v85: true marks a Tcl 8.5-only opcode that the 8.4.6 iRule engine never
  // emits (so it shows in the disassembler but is absent from the live trace).
  var TABLE = [
    // --- stack / literals ---
    { op: 'push1', meaning: 'push a literal/constant onto the stack (1-byte operand index)' },
    { op: 'push4', meaning: 'push a literal/constant onto the stack (4-byte operand index)' },
    { op: 'pop', meaning: 'discard the value on top of the stack' },
    { op: 'dup', meaning: 'duplicate the value on top of the stack' },
    { op: 'concat1', meaning: 'concatenate the top N stack values into one string' },
    { op: 'nop', meaning: 'no operation' },
    { op: 'done', meaning: 'end of the script’s byte code' },

    // --- command invocation ---
    { op: 'invokeStk1', meaning: 'invoke a command with N args (the following <code>CMD_VM</code> names it; 1-byte count)' },
    { op: 'invokeStk4', meaning: 'invoke a command with N args (4-byte count)' },
    { op: 'startCommand', meaning: 'command-boundary marker emitted before a command', v85: true },

    // --- variables (surface as VAR_MOD when they store) ---
    { op: 'loadScalarStk', meaning: 'load a scalar variable’s value (name taken from the stack)' },
    { op: 'loadScalar1', meaning: 'load a scalar variable’s value by compiled slot (1-byte index)' },
    { op: 'storeScalarStk', meaning: 'store into a scalar variable, name from the stack (surfaces as <code>VAR_MOD</code>)' },
    { op: 'storeScalar1', meaning: 'store into a scalar variable by compiled slot (surfaces as <code>VAR_MOD</code>)' },
    { op: 'incrScalarStk', meaning: 'increment a scalar variable by a popped amount' },
    { op: 'incrScalarStkImm', meaning: 'increment a scalar variable by an immediate amount', v85: true },
    { op: 'appendStk', meaning: 'append to a variable (the <code>append</code> command)' },
    { op: 'lappendStk', meaning: 'append a list element to a variable (the <code>lappend</code> command)' },

    // --- expressions / lists ---
    { op: 'exprStk', meaning: 'evaluate an expression string on the stack' },
    { op: 'tryCvtToNumeric', meaning: 'try to convert the top value to a number (expression evaluation)' },
    { op: 'listIndex', meaning: 'index into a list (the <code>lindex</code> command)' },

    // --- branches ---
    { op: 'jump1', meaning: 'unconditional branch (1-byte offset)' },
    { op: 'jump4', meaning: 'unconditional branch (4-byte offset)' },
    { op: 'jumpTrue1', meaning: 'branch if the top value is true (1-byte offset)' },
    { op: 'jumpTrue4', meaning: 'branch if the top value is true (4-byte offset)' },
    { op: 'jumpFalse1', meaning: 'branch if the top value is false (1-byte offset)' },
    { op: 'jumpFalse4', meaning: 'branch if the top value is false (4-byte offset)' },

    // --- comparisons (numeric vs string) ---
    { op: 'eq', meaning: 'numeric equality comparison (<code>==</code>)' },
    { op: 'neq', meaning: 'numeric inequality comparison (<code>!=</code>)' },
    { op: 'lt', meaning: 'numeric less-than comparison (<code>&lt;</code>)' },
    { op: 'gt', meaning: 'numeric greater-than comparison (<code>&gt;</code>)' },
    { op: 'le', meaning: 'numeric less-than-or-equal comparison (<code>&lt;=</code>)' },
    { op: 'ge', meaning: 'numeric greater-than-or-equal comparison (<code>&gt;=</code>)' },
    { op: 'streq', meaning: 'string equality comparison (the <code>eq</code> operator)' },
    { op: 'strneq', meaning: 'string inequality comparison (the <code>ne</code> operator)' }
  ];

  var BY_OP = {};
  for (var i = 0; i < TABLE.length; i++) { BY_OP[TABLE[i].op] = TABLE[i]; }

  function stripTags(s) { return s.replace(/<[^>]+>/g, ''); }

  // Resolve an opcode value to its table row, or null. Exact match first; if the
  // value ever carries a trailing operand, fall back to the leading token.
  function rowFor(value) {
    if (value === null || value === undefined) { return null; }
    var v = String(value);
    var r = BY_OP[v];
    if (r === undefined) { r = BY_OP[v.split(/\s+/)[0]]; }
    return r === undefined ? null : r;
  }

  // Plain-text meaning for an opcode value, or null if unknown.
  function meaning(value) {
    var r = rowFor(value);
    return r === null ? null : stripTags(r.meaning);
  }

  // Tooltip text for a bytecode tick: "opcode — meaning", or null when the
  // opcode is not in the table (caller then renders no <title>).
  function tip(value) {
    var m = meaning(value);
    return m === null ? null : String(value) + ' — ' + m;
  }

  // True when the opcode exists only in Tcl 8.5 (so it appears in the 8.5.13
  // disassembler but never in the 8.4.6 live trace). Unknown opcodes -> false.
  function is85(value) {
    var r = rowFor(value);
    return r !== null && r.v85 === true;
  }

  window.RPOpcodes = { table: TABLE, meaning: meaning, tip: tip, is85: is85 };
})();
