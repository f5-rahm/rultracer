'use strict';

// Zero-dependency test harness for the Phase 7 opcode reference seam
// (opcodes.js → window.RPOpcodes). Run from the repo root:  node test/phase7.js
// — or on-box from the package dir (e.g. node test.js); resolveBase() below
// finds presentation/ either way.
// (Node 6.9.1-safe — opcodes.js is ES5 so it runs on the BIG-IP too).
//
// opcodes.js is PURE (no DOM). It is the single source of truth for opcode
// meanings shared by the collapsed "Bytecode reference" panel (rendered by
// app.js) and the bytecode-tick hover tooltips in the sequence diagram
// (seqdiagram.js _tick → window.RPOpcodes.tip). Those DOM-bound consumers are
// exercised only on-box, per the Phase 2–6 lesson; here we test the pure map +
// lookup, then load seqdiagram.js for syntax coverage, and finally assert that
// index.html no longer hardcodes the opcode rows (so the single source holds).

var assert = require('assert');
var path = require('path');
var fs = require('fs');

global.window = {};
global.document = {
  createElement: function () { return {}; },
  createElementNS: function () { return { setAttribute: function () {}, appendChild: function () {} }; },
  createTextNode: function (s) { return { nodeValue: s }; }
};

// Locate presentation/ regardless of where this file is run from: the repo
// layout has test/ as a sibling of presentation/ (so ../presentation), but
// on-box the file may be dropped straight into the package root next to
// presentation/ (so ./presentation). Try both.
function resolveBase() {
  var cands = [path.join(__dirname, '..'), __dirname];
  for (var i = 0; i < cands.length; i++) {
    if (fs.existsSync(path.join(cands[i], 'presentation', 'js', 'opcodes.js'))) { return cands[i]; }
  }
  return cands[0];
}
var BASE = resolveBase();
var JS_DIR = path.join(BASE, 'presentation', 'js');
var INDEX_HTML = path.join(BASE, 'presentation', 'index.html');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function load(m) { eval(fs.readFileSync(path.join(JS_DIR, m + '.js'), 'utf8')); }

load('opcodes');
var RPOpcodes = window.RPOpcodes;

// ---- module shape ---------------------------------------------------------
test('opcodes.js exposes window.RPOpcodes with table/meaning/tip', function () {
  assert.ok(RPOpcodes, 'RPOpcodes present');
  assert.ok(Array.isArray(RPOpcodes.table), 'table is an array');
  assert.strictEqual(typeof RPOpcodes.meaning, 'function', 'meaning() is a function');
  assert.strictEqual(typeof RPOpcodes.tip, 'function', 'tip() is a function');
});

test('table: every row has a non-empty op and meaning', function () {
  assert.ok(RPOpcodes.table.length >= 7, 'at least the 7 known opcodes');
  RPOpcodes.table.forEach(function (r) {
    assert.ok(r.op && typeof r.op === 'string', 'op string: ' + JSON.stringify(r));
    assert.ok(r.meaning && typeof r.meaning === 'string', 'meaning string: ' + JSON.stringify(r));
  });
});

// ---- meaning(): exact lookup, tag stripping, unknowns ---------------------
test('meaning(): exact opcode returns plain-text meaning', function () {
  assert.strictEqual(RPOpcodes.meaning('push1'), 'push a literal/constant onto the stack');
});

test('meaning(): inline <code> tags are stripped for the tooltip', function () {
  assert.strictEqual(RPOpcodes.meaning('storeScalarStk'),
    'store into a scalar variable (surfaces as VAR_MOD)');
  assert.strictEqual(RPOpcodes.meaning('eq'), 'equality comparison (==)');
});

test('meaning(): unknown / null / undefined return null', function () {
  assert.strictEqual(RPOpcodes.meaning('nosuchOpcode'), null);
  assert.strictEqual(RPOpcodes.meaning(null), null);
  assert.strictEqual(RPOpcodes.meaning(undefined), null);
});

test('meaning(): falls back to the leading token when an operand is appended', function () {
  // rule-profiler does not emit operands today, but the lookup tolerates it.
  assert.strictEqual(RPOpcodes.meaning('push1 5'), RPOpcodes.meaning('push1'));
});

// ---- tip(): "opcode — meaning" or null ------------------------------------
test('tip(): formats "opcode — meaning" for known opcodes', function () {
  assert.strictEqual(RPOpcodes.tip('push1'), 'push1 — push a literal/constant onto the stack');
});

test('tip(): returns null for unknown opcodes (no <title> rendered)', function () {
  assert.strictEqual(RPOpcodes.tip('nosuchOpcode'), null);
});

// ---- consumer syntax coverage --------------------------------------------
test('seqdiagram.js loads without error (tick tooltip wiring)', function () {
  load('seqdiagram');
  assert.ok(window.SeqDiagram, 'SeqDiagram namespace present after load');
});

// ---- single source of truth ----------------------------------------------
test('index.html renders the opcode table from the map (no hardcoded rows)', function () {
  var html = fs.readFileSync(INDEX_HTML, 'utf8');
  assert.ok(html.indexOf('id="bc-table-body"') !== -1, 'bc-table-body placeholder present');
  RPOpcodes.table.forEach(function (r) {
    assert.strictEqual(html.indexOf('<td>' + r.op + '</td>'), -1,
      'opcode "' + r.op + '" must not be hardcoded in index.html');
  });
});

var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log('  ok   ' + t.name); }
  catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + e.message); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');

process.exit(failed ? 1 : 0);
