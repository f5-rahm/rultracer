'use strict';

// Zero-dependency test harness for the Phase 6 multi-TMM partition seam
// (tmm.js → window.RPTmm). Run from the repo root:  node test/phase6.js
// (Node 6.9.1-safe — tmm.js is ES5 so it runs on the BIG-IP too).
//
// tmm.js is PURE (no DOM/d3/fetch); the DOM-bound wiring (TMM scope dropdown,
// flow badges, diff overlay, report TMM chooser in analysis.js) is exercised
// only on-box, per the Phase 2–5 lesson.
//
// Validated two ways: synthetic records with known ctxIds, and the real 4-TMM
// ground-truth capture (background info/rultracer-solo_test_4-raw.csv). A Python
// cross-check of the fixture's ctxId/flow distribution spawns at the bottom.

var assert = require('assert');
var path = require('path');
var fs = require('fs');
var cp = require('child_process');

global.window = {};
global.document = { createElement: function () { return {}; } };

var JS_DIR = path.join(__dirname, '..', 'presentation', 'js');
var FIXTURE = path.join(__dirname, '..', 'background info', 'rultracer-solo_test_4-raw.csv');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function load(m) { eval(fs.readFileSync(path.join(JS_DIR, m + '.js'), 'utf8')); }

load('parser');
load('model');
load('tmm');

var RPTmm = window.RPTmm;

// One CSV occurrence line (prefix-stripped form); ctx is field 5, flow field 6.
function line(ts, occ, val, ctx, flow) {
  return ts + ',' + occ + ',/Common/v,' + val + ',' + ctx + ',' + flow +
    ',10.1.1.1,1,0,10.1.1.2,80,0';
}
// A minimal one-event flow on a given ctxId/flow.
function flowLines(t0, ctx, flow) {
  return [
    line(t0 + 0, 'RP_EVENT_ENTRY', 'CLIENT_ACCEPTED', ctx, flow),
    line(t0 + 1, 'RP_RULE_ENTRY', '/Common/r', ctx, flow),
    line(t0 + 2, 'RP_RULE_EXIT', '/Common/r', ctx, flow),
    line(t0 + 3, 'RP_EVENT_EXIT', 'CLIENT_ACCEPTED', ctx, flow)
  ];
}

// ---- synthetic: opaque ctxIds sort ascending -> TMM 0..N -------------------
test('partition: ctxIds sorted ascending map to TMM 0..N', function () {
  // Deliberately out of order, with the "main thread == pid" lowest id last.
  var raw = [].concat(
    flowLines(5000, '11674', '0xc1'),
    flowLines(5100, '11313', '0xc2'),
    flowLines(5200, '11670', '0xc3'),
    flowLines(5300, '11673', '0xc4')
  ).join('\n');
  var parsed = window.RPParser.parse(raw);
  var tmms = RPTmm.partition(parsed.records);
  assert.strictEqual(tmms.length, 4, '4 TMMs');
  assert.deepStrictEqual(tmms.map(function (t) { return t.ctxId; }),
    ['11313', '11670', '11673', '11674'], 'ascending ctxId order');
  assert.deepStrictEqual(tmms.map(function (t) { return t.label; }),
    ['TMM 0', 'TMM 1', 'TMM 2', 'TMM 3'], 'labelled by sort order');
  assert.deepStrictEqual(tmms.map(function (t) { return t.index; }), [0, 1, 2, 3], 'indices');
  tmms.forEach(function (t) { assert.strictEqual(t.flowCount, 1, 'one flow each'); });
});

test('partition: records preserved + ts-ordered within a TMM', function () {
  var raw = [].concat(
    flowLines(2000, '11313', '0xd1'),
    flowLines(2010, '11313', '0xd2')
  ).join('\n');
  var parsed = window.RPParser.parse(raw);
  var tmms = RPTmm.partition(parsed.records);
  assert.strictEqual(tmms.length, 1, 'single TMM');
  assert.strictEqual(tmms[0].occCount, 8, 'all 8 occurrences kept');
  var ts = tmms[0].records.map(function (r) { return r.tsMicros; });
  for (var i = 1; i < ts.length; i++) { assert.ok(ts[i] >= ts[i - 1], 'ts non-decreasing'); }
});

test('flowTmmMap: each flow maps to exactly one TMM label', function () {
  var raw = [].concat(
    flowLines(1000, '200', '0xf1'),
    flowLines(1100, '100', '0xf2')
  ).join('\n');
  var parsed = window.RPParser.parse(raw);
  var tmms = RPTmm.partition(parsed.records);
  var map = RPTmm.flowTmmMap(tmms);
  assert.strictEqual(map['0xf2'], 'TMM 0', 'ctx 100 is TMM 0 (lower)');
  assert.strictEqual(map['0xf1'], 'TMM 1', 'ctx 200 is TMM 1');
});

test('partition: empty input -> no TMMs', function () {
  assert.deepStrictEqual(RPTmm.partition([]), []);
  assert.deepStrictEqual(RPTmm.partition(null), []);
});

// ---- real 4-TMM ground-truth capture --------------------------------------
function fixtureModelOrSkip() {
  if (!fs.existsSync(FIXTURE)) { return null; }
  return window.RPParser.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

test('fixture: 4 TMMs with the confirmed ctxId->index mapping', function () {
  var parsed = fixtureModelOrSkip();
  if (!parsed) { console.log('       (fixture missing — skipped)'); return; }
  var tmms = RPTmm.partition(parsed.records);
  assert.strictEqual(tmms.length, 4, '4 TMMs');
  assert.deepStrictEqual(tmms.map(function (t) { return t.ctxId; }),
    ['11313', '11670', '11673', '11674'], 'confirmed ctxIds, ascending');
  // main thread (== pid 11313) sorts to TMM 0.
  assert.strictEqual(tmms[0].ctxId, '11313', 'main thread is TMM 0');
  assert.strictEqual(parsed.records.length, 4525, '4,525 occurrences');
});

test('fixture: 141 flows, balanced, no flow spans two TMMs', function () {
  var parsed = fixtureModelOrSkip();
  if (!parsed) { console.log('       (fixture missing — skipped)'); return; }
  var tmms = RPTmm.partition(parsed.records);
  var totalFlows = tmms.reduce(function (s, t) { return s + t.flowCount; }, 0);
  assert.strictEqual(totalFlows, 141, 'per-TMM flow counts sum to 141 (disjoint)');
  // Whole-capture model has the same 141 flows -> partition lost nothing.
  var whole = window.RPModel.build(parsed.records);
  assert.strictEqual(whole.flows.length, 141, 'whole capture has 141 flows');
  // Cross-check disjointness directly: a flow id appears under one ctxId only.
  var seen = {};
  tmms.forEach(function (t) {
    var flows = {};
    t.records.forEach(function (r) { flows[r.flowId] = true; });
    Object.keys(flows).forEach(function (fl) {
      assert.ok(!seen[fl], 'flow ' + fl + ' pinned to one TMM');
      seen[fl] = true;
    });
  });
  // each TMM carries roughly a quarter of the 141 flows.
  tmms.forEach(function (t) {
    assert.ok(t.flowCount >= 25 && t.flowCount <= 45, t.label + ' balanced (' + t.flowCount + ')');
  });
});

test('fixture: per-TMM models build cleanly and sum to the whole', function () {
  var parsed = fixtureModelOrSkip();
  if (!parsed) { console.log('       (fixture missing — skipped)'); return; }
  var tmms = RPTmm.partition(parsed.records);
  var sum = 0;
  tmms.forEach(function (t) { sum += window.RPModel.build(t.records).flows.length; });
  assert.strictEqual(sum, 141, 'Σ per-TMM model flows == 141');
});

// ---- run ------------------------------------------------------------------
var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log('  ok   ' + t.name); }
  catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + e.message); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');

// ---- Python cross-check of the fixture's ctxId/flow distribution ----------
if (fs.existsSync(FIXTURE)) {
  var py = [
    'import collections, re',
    'ctx=collections.Counter(); flowbyctx=collections.defaultdict(set)',
    'pre=re.compile(r"tmm\\d*\\[\\d+\\]:\\s+")',
    'for ln in open(' + JSON.stringify(FIXTURE) + '):',
    '    ln=ln.strip()',
    '    if not ln: continue',
    '    m=pre.search(ln); csv=ln[m.end():] if m else ln',
    '    f=csv.split(",")',
    '    if len(f)<6: continue',
    '    ctx[f[4]]+=1; flowbyctx[f[4]].add(f[5])',
    'order=sorted(ctx, key=lambda c:int(c))',
    'assert order==["11313","11670","11673","11674"], order',
    'allflows=collections.Counter()',
    'for c,fs in flowbyctx.items():',
    '    for fl in fs: allflows[fl]+=1',
    'assert sum(1 for v in allflows.values() if v>1)==0, "a flow spanned >1 TMM"',
    'assert len(allflows)==141, len(allflows)',
    'print("  ok   python: fixture ctxId order + 141 disjoint flows match (%s)" % order)'
  ].join('\n');
  try {
    var r = cp.spawnSync('python3', ['-c', py], { encoding: 'utf8' });
    if (r.status === 0) { process.stdout.write(r.stdout); }
    else { console.log('  (python cross-check skipped: ' + (r.stderr || r.error) + ')'); failed += r.status ? 1 : 0; }
  } catch (e) { console.log('  (python cross-check skipped: ' + e.message + ')'); }
}

process.exit(failed ? 1 : 0);
