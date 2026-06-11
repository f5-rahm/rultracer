'use strict';

// Zero-dependency test harness for the Phase 3 flamegraph seam (flame.js).
// Run from the repo root:  node test/phase3.js  (Node 6.9.1-safe — flame.js
// avoids optional chaining / nullish so it runs on the BIG-IP too).
//
// flame.js is pure (no DOM, no d3); flamegraph.js is the d3 view and is loaded
// only for syntax coverage (its d3 calls live inside methods we never invoke
// here — DOM/visual bugs need on-box eyes, per the Phase 2 lesson).

var assert = require('assert');
var path = require('path');
var fs = require('fs');

global.window = {};
function stubNode() {
  return {
    style: {}, dataset: {}, children: [], firstChild: null,
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    appendChild: function (c) { this.children.push(c); return c; },
    removeChild: function () {}, setAttribute: function () {}, addEventListener: function () {},
    set textContent(v) {}, get textContent() { return ''; }
  };
}
global.document = {
  createElement: stubNode, createElementNS: stubNode,
  createTextNode: function (s) { return { nodeValue: s }; },
  getElementById: function () { return null; }, querySelector: function () { return null; }
};

var JS_DIR = path.join(__dirname, '..', 'presentation', 'js');
var FIXTURE = path.join(__dirname, '..', 'background info', 'example-logs.txt');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function load(m) { eval(fs.readFileSync(path.join(JS_DIR, m + '.js'), 'utf8')); }

// Build a minimal RP_ trace from compact rows: [ts, occType, value].
function lines(rows) {
  return rows.map(function (r) {
    return r[0] + ',' + r[1] + ',/Common/v,' + r[2] + ',1,' + (r[3] || '0xaa') +
      ',10.1.1.1,1,0,10.1.1.2,80,0';
  }).join('\n');
}
// One event: EVENT>RULE>RULE_VM>CMD_VM>CMD, command `cmd`, occupying [t0, t0+span].
// cmdSelf controls the leaf CMD self time. Returns the row array.
function eventRows(t0, evName, cmd, cmdSelf, flow) {
  flow = flow || '0xaa';
  var rows = [
    [t0 + 0, 'RP_EVENT_ENTRY', evName, flow],
    [t0 + 1, 'RP_RULE_ENTRY', '/Common/r', flow],
    [t0 + 2, 'RP_RULE_VM_ENTRY', '/Common/r', flow],
    [t0 + 3, 'RP_CMD_VM_ENTRY', cmd, flow],
    [t0 + 4, 'RP_CMD_ENTRY', cmd, flow],
    [t0 + 4 + cmdSelf, 'RP_CMD_EXIT', cmd, flow],
    [t0 + 5 + cmdSelf, 'RP_CMD_VM_EXIT', cmd, flow],
    [t0 + 6 + cmdSelf, 'RP_RULE_VM_EXIT', '/Common/r', flow],
    [t0 + 7 + cmdSelf, 'RP_RULE_EXIT', '/Common/r', flow],
    [t0 + 8 + cmdSelf, 'RP_EVENT_EXIT', evName, flow]
  ];
  return rows;
}
function modelOf(rows) { return window.RPModel.build(window.RPParser.parse(lines(rows)).records); }

// Sum self time over a forest (== sum of root raws): the folded invariant.
function sumSelf(nodes) {
  var s = 0;
  for (var i = 0; i < nodes.length; i++) { s += (nodes[i].realExecTime || 0) + sumSelf(nodes[i].children); }
  return s;
}
function eachNode(node, fn) { fn(node); for (var i = 0; i < node.children.length; i++) { eachNode(node.children[i], fn); } }

// --- load -----------------------------------------------------------------
test('flame.js + flamegraph.js load; RPFlame + FlameView present', function () {
  ['parser', 'model', 'flame', 'flamegraph'].forEach(load);
  assert.ok(window.RPFlame, 'RPFlame namespace');
  assert.ok(window.FlameView, 'FlameView constructor');
  ['toFlameUnit', 'toFlameAgg', 'aggregate', 'toFolded', 'diffMerge',
    'rootsWhole', 'rootsByEvent', 'rootsByFlow'].forEach(function (k) {
    assert.strictEqual(typeof window.RPFlame[k], 'function', 'RPFlame.' + k);
  });
});

// --- literal (icicle of one unit), bytecode pruning -----------------------
test('toFlameUnit mirrors the NestNode tree; value = inclusive raw; bytecodes pruned', function () {
  var m = window.RPModel.build(window.RPParser.parse(fs.readFileSync(FIXTURE, 'utf8')).records);
  var flow = m.flows[0];
  var unit = { roots: flow.roots, label: 'flow' };
  var f = window.RPFlame.toFlameUnit(unit);

  var rootSum = flow.roots.reduce(function (s, r) { return s + r.raw; }, 0);
  assert.strictEqual(f.value, rootSum, 'root value = sum of event raws');
  assert.strictEqual(f.children.length, 2, 'two event frames');
  assert.strictEqual(f.children[0].name, 'CLIENT_ACCEPTED');
  assert.strictEqual(f.children[0].value, flow.roots[0].raw, 'event frame value = its raw');

  // No frame is a bytecode/var-mod (they are points, not children).
  eachNode(f, function (n) {
    assert.ok(n._base !== 'CMD_BYTECODE' && n._base !== 'VAR_MOD', 'no singleton frames');
  });
  // The RULE_VM frame surfaces the 6 points as counts instead.
  var ruleVm = f.children[0].children[0].children[0];
  assert.strictEqual(ruleVm._base, 'RULE_VM');
  assert.strictEqual(ruleVm._bytecode + ruleVm._varmod, 6, 'point counts surfaced on RULE_VM');
});

test('toFlameNode: a single event span becomes its own root frame (for stacked literal)', function () {
  var m = window.RPModel.build(window.RPParser.parse(fs.readFileSync(FIXTURE, 'utf8')).records);
  var ev0 = m.flows[0].roots[0];
  var node = window.RPFlame.toFlameNode(ev0);
  assert.strictEqual(node.name, 'CLIENT_ACCEPTED', 'event is the top frame (no synthetic ROOT)');
  assert.strictEqual(node._base, 'EVENT');
  assert.strictEqual(node.value, ev0.raw, 'value = the event raw');
});

// --- aggregation (merge identical call paths) -----------------------------
test('toFlameAgg merges identical call paths and sums value + count', function () {
  // Two identical CLIENT_ACCEPTED executions of IP::client_addr (cmdSelf=2).
  var rows = eventRows(0, 'CLIENT_ACCEPTED', 'IP::client_addr', 2)
    .concat(eventRows(100, 'CLIENT_ACCEPTED', 'IP::client_addr', 2));
  var m = modelOf(rows);
  var agg = window.RPFlame.toFlameAgg(window.RPFlame.rootsWhole(m), 'whole');

  assert.strictEqual(agg.children.length, 1, 'one merged event type');
  var ev = agg.children[0];
  assert.strictEqual(ev.name, 'CLIENT_ACCEPTED');
  assert.strictEqual(ev._count, 2, 'two occurrences merged');
  assert.strictEqual(ev.value, m.flows[0].roots[0].raw + m.flows[0].roots[1].raw, 'value summed');

  // Descend to the merged leaf command.
  var cmd = ev.children[0].children[0].children[0].children[0];
  assert.strictEqual(cmd.name, 'IP::client_addr');
  assert.strictEqual(cmd._base, 'CMD');
  assert.strictEqual(cmd._count, 2, 'leaf merged across both events');

  // d3-flame-graph nesting invariant: parent.value >= sum(children.value).
  eachNode(agg, function (n) {
    var cs = n.children.reduce(function (s, c) { return s + c.value; }, 0);
    assert.ok(n.value >= cs, 'parent value >= sum children at ' + n.name);
  });
});

// --- folded stacks (Phase 5 seam) -----------------------------------------
test('toFolded is loss-free: sum of per-frame self = sum of root raws', function () {
  var rows = eventRows(0, 'CLIENT_ACCEPTED', 'IP::client_addr', 2)
    .concat(eventRows(100, 'HTTP_REQUEST', 'HTTP::respond', 5));
  var m = modelOf(rows);
  var roots = window.RPFlame.rootsWhole(m);
  var folded = window.RPFlame.toFolded(roots);
  var total = folded.split('\n').filter(Boolean).reduce(function (s, ln) {
    return s + parseInt(ln.slice(ln.lastIndexOf(' ') + 1), 10);
  }, 0);
  assert.strictEqual(total, sumSelf(roots), 'folded self total matches model self total');
  // path labels strip the /Common/ partition prefix on rule frames.
  assert.ok(/CLIENT_ACCEPTED;r;r;/.test(folded), 'rule prefix stripped in folded path');
});

// --- diff merge -----------------------------------------------------------
test('diffMerge sizes by B and computes self-time delta (B - A)', function () {
  var aggA = window.RPFlame.toFlameAgg(window.RPFlame.rootsWhole(
    modelOf(eventRows(0, 'CLIENT_ACCEPTED', 'IP::client_addr', 2))), 'A');
  var aggB = window.RPFlame.toFlameAgg(window.RPFlame.rootsWhole(
    modelOf(eventRows(0, 'CLIENT_ACCEPTED', 'IP::client_addr', 8))), 'B'); // slower command

  var d = window.RPFlame.diffMerge(aggA, aggB);
  assert.strictEqual(d.value, aggB.value, 'diff root sized by B');
  // leaf command: slower in B -> positive self delta, value = B value.
  var cmd = d.children[0].children[0].children[0].children[0].children[0];
  assert.strictEqual(cmd.name, 'IP::client_addr');
  assert.ok(cmd.delta > 0, 'positive delta (slower in B)');
  assert.strictEqual(cmd._valB, cmd.value, 'value tracks B');
  assert.ok(cmd._valB > cmd._valA, 'B inclusive > A inclusive');

  var mx = window.RPFlame.maxAbsDelta(d);
  assert.ok(mx >= cmd.delta, 'maxAbsDelta covers the leaf');
});

// --- run ------------------------------------------------------------------
var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log('  ok  - ' + t.name); }
  catch (e) { failed++; console.log('FAIL  - ' + t.name + '\n        ' + (e && e.message)); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
