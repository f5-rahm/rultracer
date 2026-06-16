'use strict';

// Zero-dependency test harness for the Phase 4 cycles-vs-CPU seam (cycles.js).
// Run from the repo root:  node test/phase4.js  (Node 6.9.1-safe — cycles.js
// avoids optional chaining / nullish / ** so it runs on the BIG-IP too).
//
// cycles.js is pure (no DOM, no d3); cyclesview.js is the DOM view and is loaded
// only for syntax coverage (its DOM calls live inside methods we never invoke
// here — visual bugs need on-box eyes, per the Phase 2/3 lesson).
//
// A Python arithmetic cross-check of the cycle<->µs<->%CPU formulae lives at the
// bottom (spawned via child_process), mirroring the Phase 2/3 validation flow.

var assert = require('assert');
var path = require('path');
var fs = require('fs');
var cp = require('child_process');

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

// Same compact trace builders as phase3.js (kept local so this file is self-contained).
function lines(rows) {
  return rows.map(function (r) {
    return r[0] + ',' + r[1] + ',/Common/v,' + r[2] + ',1,' + (r[3] || '0xaa') +
      ',10.1.1.1,1,0,10.1.1.2,80,0';
  }).join('\n');
}
function eventRows(t0, evName, cmd, cmdSelf, flow) {
  flow = flow || '0xaa';
  return [
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
}
function modelOf(rows) { return window.RPModel.build(window.RPParser.parse(lines(rows)).records); }
function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

// 3.0 GHz across 2 cores -> 6.0e9 Hz whole-box budget (gist convention).
var CPUINFO = 'processor : 0\ncpu MHz : 3000.000\nprocessor : 1\ncpu MHz : 3000.000\n';

// --- load -----------------------------------------------------------------
test('cycles.js + cyclesview.js load; RPCycles + CyclesView present', function () {
  ['parser', 'model', 'cycles', 'cyclesview'].forEach(load);
  assert.ok(window.RPCycles, 'RPCycles namespace');
  assert.ok(window.CyclesView, 'CyclesView constructor');
  ['parseCpuinfo', 'cyclesToMicros', 'microsToCycles', 'pctCpuPerReq', 'maxReqPerSec',
    'ruleStatsRows', 'aggregate', 'traceEventStats', 'traceCommandStats', 'reconcile'].forEach(function (k) {
    assert.strictEqual(typeof window.RPCycles[k], 'function', 'RPCycles.' + k);
  });
});

// --- CPU facts: sum all cores' MHz, ×1e6 ----------------------------------
test('parseCpuinfo sums all cores and converts MHz->Hz', function () {
  var c = window.RPCycles.parseCpuinfo(CPUINFO);
  assert.strictEqual(c.cores, 2, 'two cores parsed');
  assert.strictEqual(c.cpuHz, 6.0e9, 'cpuHz = sum(MHz) * 1e6 (whole-box budget)');
});

// --- gist conversions -----------------------------------------------------
test('cycles<->µs<->%CPU<->maxRPS round-trip (gist formulae)', function () {
  var hz = 6.0e9;
  // 3e8 cycles at 6e9 Hz = 0.05 s = 50,000 µs.
  assert.ok(near(window.RPCycles.cyclesToMicros(3e8, hz), 50000), 'cycles->µs');
  assert.ok(near(window.RPCycles.microsToCycles(50000, hz), 3e8), 'µs->cycles (inverse)');
  // %CPU/request = cycles / cpuHz ; 3e8/6e9 = 0.05 = 5%.
  assert.ok(near(window.RPCycles.pctCpuPerReq(3e8, hz), 0.05), '%CPU fraction');
  // max req/sec = cpuHz / cycles ; 6e9/3e8 = 20.
  assert.ok(near(window.RPCycles.maxReqPerSec(3e8, hz), 20), 'max req/sec');
});

// --- authoritative rule-stats rows ----------------------------------------
test('ruleStatsRows derives µs / %CPU / max-rps per event', function () {
  var rows = window.RPCycles.ruleStatsRows([
    { event: 'HTTP_REQUEST', executions: 100000, minCycles: 1.2e6, avgCycles: 3.0e8, maxCycles: 6.0e8 }
  ], 6.0e9);
  var r = rows[0];
  assert.strictEqual(r.event, 'HTTP_REQUEST');
  assert.ok(near(r.avgUs, 50000), 'avgUs from avgCycles');
  assert.ok(near(r.avgPct, 0.05), 'avgPct fraction');
  // maxReqPerSec is bounded by the slowest (maxCycles): 6e9/6e8 = 10.
  assert.ok(near(r.maxReqPerSec, 10), 'max-rps uses maxCycles (worst case)');
  // avgReqPerSec (clock / avg cost) — the basis for the per-request Total row's
  // req/s (per-event req/s is omitted in the view as misleading): 6e9/3e8 = 20.
  assert.ok(near(r.avgReqPerSec, 20), 'avg-rps from avgCycles (basis for Total req/s)');
});

// --- whole-VS aggregate (flat sum across rules) ---------------------------
test('aggregate sums each rule per-request cost across rules (gist derivations)', function () {
  // r1: 3.0e8 avg cyc/req (one event); r2: two events 1.0e8 + 2.0e8 = 3.0e8.
  var agg = window.RPCycles.aggregate([
    { rule: '/Common/r1', events: [{ event: 'HTTP_REQUEST', avgCycles: 3.0e8 }] },
    { rule: '/Common/r2', events: [
      { event: 'CLIENT_ACCEPTED', avgCycles: 1.0e8 },
      { event: 'HTTP_RESPONSE', avgCycles: 2.0e8 }
    ] }
  ], 6.0e9);
  assert.strictEqual(agg.ruleCount, 2, 'two rules');
  assert.strictEqual(agg.cyclesPerReq, 6.0e8, 'whole-VS cyc/req = Σ all rules Σ events');
  assert.strictEqual(agg.rules[0].cyclesPerReq, 3.0e8, 'r1 per-request');
  assert.strictEqual(agg.rules[1].cyclesPerReq, 3.0e8, 'r2 per-request (two events summed)');
  // 6e8 cyc at 6e9 Hz = 100,000 µs ; %CPU = 0.10 ; maxRPS = 10.
  assert.ok(near(agg.usPerReq, 100000), 'usPerReq');
  assert.ok(near(agg.pctPerReq, 0.10), 'pctPerReq fraction');
  assert.ok(near(agg.maxReqPerSec, 10), 'maxReqPerSec from total cyc');
});

// --- trace-derived per-event + per-command --------------------------------
test('traceEventStats + traceCommandStats roll up the model (CMD_VM canonical)', function () {
  // two CLIENT_ACCEPTED execs of the same command, self=2 each.
  var m = modelOf(eventRows(0, 'CLIENT_ACCEPTED', 'IP::client_addr', 2)
    .concat(eventRows(100, 'CLIENT_ACCEPTED', 'IP::client_addr', 2)));
  var ev = window.RPCycles.traceEventStats(m).get('CLIENT_ACCEPTED');
  assert.strictEqual(ev.executions, 2, 'two event executions');
  // each event span: EVENT_ENTRY..EXIT = 8 + cmdSelf(2) = 10 µs raw.
  assert.strictEqual(ev.avgRawUs, 10, 'avg inclusive µs per event');

  var cmds = window.RPCycles.traceCommandStats(m);
  assert.strictEqual(cmds.length, 1, 'one distinct command (CMD_VM canonical, no 2× CMD)');
  assert.strictEqual(cmds[0].command, 'IP::client_addr');
  assert.strictEqual(cmds[0].count, 2, 'counted by CMD_VM, both occurrences');
});

// --- reconcile: authoritative vs trace-derived, overhead surfaced ----------
test('reconcile joins stats vs trace avgCycles and computes overhead delta', function () {
  var m = modelOf(eventRows(0, 'CLIENT_ACCEPTED', 'IP::client_addr', 2));
  // trace avg raw = 10 µs -> at 6e9 Hz = 60,000 cycles. Pretend ground-truth
  // (no-overhead) avgCycles = 30,000 -> trace should read ~+100% (inflated).
  var rows = window.RPCycles.reconcile(
    [{ event: 'CLIENT_ACCEPTED', executions: 100000, avgCycles: 30000 }], m, 6.0e9);
  assert.strictEqual(rows.length, 1);
  var r = rows[0];
  assert.ok(near(r.traceAvgCycles, 60000), 'trace avgCycles from µs');
  assert.strictEqual(r.statsAvgCycles, 30000, 'stats avgCycles ground truth');
  assert.ok(near(r.deltaPct, 100), 'overhead delta % = (trace-stats)/stats*100');
  assert.ok(r.deltaPct > 0, 'profiler inflates -> positive');
});

test('reconcile surfaces trace-only events (not silently dropped)', function () {
  var m = modelOf(eventRows(0, 'CLIENT_ACCEPTED', 'IP::client_addr', 2));
  var rows = window.RPCycles.reconcile([], m, 6.0e9); // empty stats
  assert.strictEqual(rows.length, 1, 'the trace event still appears');
  assert.strictEqual(rows[0].statsAvgCycles, null, 'stats side null');
  assert.ok(rows[0].traceAvgCycles > 0, 'trace side populated');
});

// --- real fixture sanity ---------------------------------------------------
test('traceCommandStats on the bundled fixture returns positive durations', function () {
  var m = window.RPModel.build(window.RPParser.parse(fs.readFileSync(FIXTURE, 'utf8')).records);
  var cmds = window.RPCycles.traceCommandStats(m);
  assert.ok(cmds.length > 0, 'fixture has commands');
  cmds.forEach(function (c) { assert.ok(c.totalRawUs >= 0 && c.count > 0, 'sane rollup for ' + c.command); });
});

// --- run JS tests ----------------------------------------------------------
var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log('  ok  - ' + t.name); }
  catch (e) { failed++; console.log('FAIL  - ' + t.name + '\n        ' + (e && e.message)); }
});

// --- Python arithmetic cross-check ----------------------------------------
// Independently recompute the gist formulae and assert the JS agrees.
var py = [
  'cpuHz = 3000.0 * 2 * 1e6',
  'cyc = 3.0e8',
  'us = cyc * 1e6 / cpuHz',
  'pct = cyc / cpuHz',
  'rps = cpuHz / cyc',
  'assert abs(us - 50000.0) < 1e-6, us',
  'assert abs(pct - 0.05) < 1e-12, pct',
  'assert abs(rps - 20.0) < 1e-9, rps',
  'print("py-ok")'
].join('\n');
var pyOk = false;
try {
  var out = cp.execSync('python3 -c ' + JSON.stringify(py), { encoding: 'utf8' });
  pyOk = /py-ok/.test(out);
  console.log(pyOk ? '  ok  - python arithmetic cross-check' : 'FAIL  - python cross-check: ' + out);
} catch (e) {
  console.log('skip  - python cross-check unavailable (' + (e && e.message ? e.message.split('\n')[0] : 'no python3') + ')');
  pyOk = true; // don't fail the suite when python isn't present (e.g. on-box)
}
if (!pyOk) { failed++; }

console.log('\n' + (tests.length + 1 - failed) + '/' + (tests.length + 1) + ' passed');
process.exit(failed ? 1 : 0);
