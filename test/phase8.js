'use strict';

// Zero-dependency test harness for Phase 8 (bytecode disassembler). Run from the
// repo root:  node test/phase8.js  — or on-box from the package dir.
// (Node 6.9.1-safe — opcodes.js / disasm.js are ES5 so this runs on the BIG-IP.)
//
// Covers the two PURE seams that drive the disassembler UI:
//   - opcodes.js (window.RPOpcodes): the expanded ~30-opcode dictionary + is85()
//   - disasm.js  (window.RPDisasm):  when-block extraction + raw-output parsing
// The DOM views (disasmview.js, app.js panel) and the tclsh round-trip
// (DisasmWorker) are exercised only on-box, per the Phase 2–7 lesson; here we
// load disasmview.js for syntax coverage and assert the pure logic.

var assert = require('assert');
var path = require('path');
var fs = require('fs');

global.window = {};
global.document = {
  createElement: function () {
    return { style: {}, classList: { add: function () {}, remove: function () {} },
             setAttribute: function () {}, appendChild: function () {},
             addEventListener: function () {} };
  },
  createElementNS: function () { return { setAttribute: function () {}, appendChild: function () {} }; },
  createTextNode: function (s) { return { nodeValue: s }; }
};

function resolveBase() {
  var cands = [path.join(__dirname, '..'), __dirname];
  for (var i = 0; i < cands.length; i++) {
    if (fs.existsSync(path.join(cands[i], 'presentation', 'js', 'disasm.js'))) { return cands[i]; }
  }
  return cands[0];
}
var BASE = resolveBase();
var JS_DIR = path.join(BASE, 'presentation', 'js');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function load(m) { eval(fs.readFileSync(path.join(JS_DIR, m + '.js'), 'utf8')); }

load('opcodes');
load('disasm');
var RPOpcodes = window.RPOpcodes;
var RPDisasm = window.RPDisasm;

// ===== opcodes.js: expanded dictionary ====================================
test('opcodes: dictionary expanded to a common subset (>= 25)', function () {
  assert.ok(RPOpcodes.table.length >= 25, 'expanded table, got ' + RPOpcodes.table.length);
});

test('opcodes: seed-list ops present with meanings', function () {
  var want = ['push1', 'push4', 'pop', 'dup', 'concat1', 'done', 'invokeStk1',
    'loadScalarStk', 'storeScalarStk', 'loadScalar1', 'storeScalar1',
    'appendStk', 'lappendStk', 'exprStk', 'listIndex', 'tryCvtToNumeric',
    'jump1', 'jump4', 'jumpTrue1', 'jumpFalse1', 'jumpFalse4',
    'eq', 'neq', 'lt', 'gt', 'le', 'ge', 'streq', 'strneq',
    'startCommand', 'incrScalarStk', 'incrScalarStkImm', 'nop'];
  for (var i = 0; i < want.length; i++) {
    assert.ok(RPOpcodes.meaning(want[i]) !== null, 'missing opcode: ' + want[i]);
  }
});

test('opcodes: streq vs eq distinguished (string vs numeric)', function () {
  // The 8.4.6 trace and 8.5.13 disassembler both use streq for the `eq`
  // operator; `eq` is the numeric == op. Both must resolve, distinctly.
  assert.notStrictEqual(RPOpcodes.meaning('streq'), RPOpcodes.meaning('eq'));
  assert.ok(/string/.test(RPOpcodes.meaning('streq')));
});

test('opcodes: is85() flags 8.5-only opcodes, false otherwise', function () {
  assert.strictEqual(RPOpcodes.is85('startCommand'), true);
  assert.strictEqual(RPOpcodes.is85('incrScalarStkImm'), true);
  assert.strictEqual(RPOpcodes.is85('push1'), false);
  assert.strictEqual(RPOpcodes.is85('nosuchOp'), false);
});

// ===== disasm.js: when-block extraction ===================================
test('extractHandlers: no `when` -> whole snippet, not wrapped', function () {
  var r = RPDisasm.extractHandlers('set x 1\nincr x');
  assert.strictEqual(r.wrapped, false);
  assert.strictEqual(r.bodies.length, 1);
  assert.strictEqual(r.bodies[0].label, null);
  assert.strictEqual(r.bodies[0].body, 'set x 1\nincr x');
  assert.deepStrictEqual(r.warnings, []);
});

test('extractHandlers: single handler -> body extracted, labeled by event', function () {
  var r = RPDisasm.extractHandlers('when HTTP_REQUEST { set x 1 }');
  assert.strictEqual(r.wrapped, true);
  assert.strictEqual(r.bodies.length, 1);
  assert.strictEqual(r.bodies[0].label, 'HTTP_REQUEST');
  assert.strictEqual(r.bodies[0].body, ' set x 1 ');
  assert.ok(r.warnings.length >= 1, 'warns about the strip');
});

test('extractHandlers: modifiers between event and brace captured in label', function () {
  var r = RPDisasm.extractHandlers('when CLIENT_ACCEPTED priority 300 timing on {\n  log local0. "hi"\n}');
  assert.strictEqual(r.bodies.length, 1);
  assert.strictEqual(r.bodies[0].label, 'CLIENT_ACCEPTED priority 300 timing on');
  assert.ok(/log local0\./.test(r.bodies[0].body));
});

test('extractHandlers: nested braces in the body are balanced correctly', function () {
  var r = RPDisasm.extractHandlers('when HTTP_REQUEST { if {$x} { set y 1 } }');
  assert.strictEqual(r.bodies.length, 1);
  assert.strictEqual(r.bodies[0].body, ' if {$x} { set y 1 } ');
});

test('extractHandlers: multiple handlers -> one body each, warns', function () {
  var src = 'when CLIENT_ACCEPTED priority 300 {\n set a 1\n}\nwhen HTTP_REQUEST {\n set b 2\n}';
  var r = RPDisasm.extractHandlers(src);
  assert.strictEqual(r.bodies.length, 2);
  assert.strictEqual(r.bodies[0].label, 'CLIENT_ACCEPTED priority 300');
  assert.strictEqual(r.bodies[1].label, 'HTTP_REQUEST');
  assert.ok(/set a 1/.test(r.bodies[0].body) && /set b 2/.test(r.bodies[1].body));
  var multi = false;
  for (var i = 0; i < r.warnings.length; i++) { if (/2 handlers/.test(r.warnings[i])) { multi = true; } }
  assert.ok(multi, 'warns about multiple handlers');
});

test('extractHandlers: top-level directive outside a handler is discarded + warned', function () {
  var r = RPDisasm.extractHandlers('timing off\nwhen HTTP_REQUEST { set x 1 }');
  assert.strictEqual(r.bodies.length, 1);
  assert.strictEqual(r.bodies[0].body, ' set x 1 ');
  var discarded = false;
  for (var i = 0; i < r.warnings.length; i++) { if (/Discarded text outside/.test(r.warnings[i])) { discarded = true; } }
  assert.ok(discarded, 'warns about discarded outside text');
});

test('extractHandlers: unbalanced braces -> warn, body to end of input', function () {
  var r = RPDisasm.extractHandlers('when HTTP_REQUEST { set x 1');
  assert.strictEqual(r.bodies.length, 1);
  assert.strictEqual(r.bodies[0].body, ' set x 1');
  var unb = false;
  for (var i = 0; i < r.warnings.length; i++) { if (/unbalanced/.test(r.warnings[i])) { unb = true; } }
  assert.ok(unb, 'warns about unbalanced braces');
});

test('matchBrace: returns index of the matching close brace, -1 if none', function () {
  assert.strictEqual(RPDisasm.matchBrace('{ a {b} c }', 0), 10);
  assert.strictEqual(RPDisasm.matchBrace('{ a {b} c', 0), -1);
});

// ===== disasm.js: raw disassembly parsing =================================
// Representative tclsh 8.5.13 `tcl::unsupported::disassemble` output, in the
// format the prototype confirmed on-box (PLAN "Disassembly format"):
//   - ByteCode/Source headers + Commands index ignored
//   - Cmds/inst/litObjs/stkDepth cost summary parsed
//   - Exception ranges block skipped
//   - per-Command blocks with `(pc) opcode operands # comment` rows
//   - an empty/container Command block (header only)
//   - operands with and without a `# ...` comment; tab separators
var SAMPLE = [
  'ByteCode 0x0x556, refCt 1, epoch 16, interp 0x556 (epoch 16)',
  '  Source "set x foo..."',
  '  Cmds 3, src 40, inst 17, litObjs 5, aux 0, stkDepth 3, code/src 1.50',
  '  Commands 3:',
  '      1: pc 0-3, src 0-9',
  '      2: pc 4-20, src 10-39',
  '  Exception ranges 1, depth 1:',
  '      0: level 0, pc 4-18, continue -1, break -1',
  '  Command 1: "set x foo"',
  '    (0) push1 0 \t# "foo"',
  '    (2) storeScalarStk \t# var "x"',
  '    (4) pop ',
  '  Command 2: "if {$x eq "bar"} { set y 1 }"',
  '    (5) loadScalarStk \t# var "x"',
  '    (7) push1 1 \t# "bar"',
  '    (9) streq ',
  '   (10) jumpFalse1 +8 \t# pc 18',
  '   (12) push1 2 \t# "1"',
  '   (14) storeScalarStk \t# var "y"',
  '   (16) pop ',
  '   (18) done ',
  '  Command 3: "[HTTP::host]"'
].join('\n');

test('parse: cost summary (Cmds/inst/litObjs/stkDepth) extracted', function () {
  var r = RPDisasm.parse(SAMPLE);
  assert.strictEqual(r.meta.cmds, 3);
  assert.strictEqual(r.meta.inst, 17);
  assert.strictEqual(r.meta.litObjs, 5);
  assert.strictEqual(r.meta.stkDepth, 3);
});

test('parse: one block per Command, src unquoted (incl. nested quotes)', function () {
  var r = RPDisasm.parse(SAMPLE);
  assert.strictEqual(r.commands.length, 3);
  assert.strictEqual(r.commands[0].src, 'set x foo');
  assert.strictEqual(r.commands[1].src, 'if {$x eq "bar"} { set y 1 }');
  assert.strictEqual(r.commands[2].src, '[HTTP::host]');
});

test('parse: instruction rows carry pc, opcode, operands, recovered comment', function () {
  var r = RPDisasm.parse(SAMPLE);
  assert.deepStrictEqual(r.commands[0].instructions[0],
    { pc: 0, opcode: 'push1', operands: '0', comment: '"foo"' });
  assert.deepStrictEqual(r.commands[0].instructions[1],
    { pc: 2, opcode: 'storeScalarStk', operands: '', comment: 'var "x"' });
});

test('parse: comment-less operand -> comment null', function () {
  var r = RPDisasm.parse(SAMPLE);
  // (4) pop  -> no operands, no comment
  assert.deepStrictEqual(r.commands[0].instructions[2],
    { pc: 4, opcode: 'pop', operands: '', comment: null });
});

test('parse: operand + pc-note comment (jumpFalse1 +8 # pc 18)', function () {
  var r = RPDisasm.parse(SAMPLE);
  var jf = r.commands[1].instructions[3];
  assert.strictEqual(jf.opcode, 'jumpFalse1');
  assert.strictEqual(jf.operands, '+8');
  assert.strictEqual(jf.comment, 'pc 18');
});

test('parse: empty/container Command block tolerated (header, no rows)', function () {
  var r = RPDisasm.parse(SAMPLE);
  assert.strictEqual(r.commands[2].instructions.length, 0);
});

test('parse: Exception ranges + Commands index lines are not mistaken for rows', function () {
  var r = RPDisasm.parse(SAMPLE);
  // Command 1 has exactly its 3 real instructions despite the exc/index lines.
  assert.strictEqual(r.commands[0].instructions.length, 3);
  assert.strictEqual(r.commands[1].instructions.length, 8);
});

test('parse: opcodes resolve against the dictionary for tooltips', function () {
  var r = RPDisasm.parse(SAMPLE);
  // streq must be a known opcode so the table view can cross-link it.
  assert.ok(RPOpcodes.meaning(r.commands[1].instructions[2].opcode) !== null);
});

// ===== consumer syntax coverage ===========================================
test('disasmview.js loads without error', function () {
  load('disasmview');
  assert.ok(window.DisasmView, 'DisasmView namespace present after load');
});

var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log('  ok   ' + t.name); }
  catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + e.message); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');

process.exit(failed ? 1 : 0);
