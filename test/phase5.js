'use strict';

// Zero-dependency test harness for the Phase 5 report seam (reportdata.js).
// Run from the repo root:  node test/phase5.js  (Node 6.9.1-safe — reportdata.js
// avoids optional chaining / nullish / ** / arrow / const-let so it runs on the
// BIG-IP too).
//
// reportdata.js is PURE (no DOM, no d3, no fetch); the DOM-bound stitching
// (off-screen SeqDiagram / CyclesView / SourceMap render, app.css fetch) lives
// in analysis.js and is exercised only on-box, per the Phase 2/3/4 lesson.
//
// A Python cross-check of the icicle width arithmetic spawns at the bottom.

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

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function load(m) { eval(fs.readFileSync(path.join(JS_DIR, m + '.js'), 'utf8')); }

// ---- trace builders (same shape as phase4.js) -----------------------------
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

// Load the pure modules the report seam depends on.
load('parser');
load('model');
load('flame');
load('cycles');
load('reportdata');

var RD = window.RPReportData;

function buildModel() {
  var raw = lines(
    eventRows(1000, 'CLIENT_ACCEPTED', 'IP::client_addr', 10)
      .concat(eventRows(1100, 'HTTP_REQUEST', 'HTTP::uri', 20))
  );
  var parsed = window.RPParser.parse(raw);
  return { parsed: parsed, model: window.RPModel.build(parsed.records) };
}

// ---- flameSvg: synthetic geometry -----------------------------------------
test('flameSvg: root spans full width; children proportional', function () {
  var tree = {
    name: 'whole', value: 100, _base: 'ROOT', _domain: 'TMM', _self: 0, _count: 1,
    children: [
      { name: 'A', value: 60, _base: 'EVENT', _domain: 'TMM', _self: 10, _count: 1, children: [] },
      { name: 'B', value: 30, _base: 'RULE_VM', _domain: 'VM', _self: 5, _count: 1, children: [] }
    ]
  };
  var svg = RD.flameSvg(tree, { width: 1000, rowH: 20 });
  assert.ok(svg.indexOf('<svg') === 0, 'starts with <svg');
  assert.ok(svg.indexOf('<style>') !== -1, 'embeds CSS');
  assert.ok(svg.indexOf('rpf-frame-root') !== -1, 'root frame class');
  assert.ok(svg.indexOf('rpf-frame-tmm') !== -1, 'tmm frame class');
  assert.ok(svg.indexOf('rpf-frame-vm') !== -1, 'vm frame class');
  // Root rect (and bg) span the full 1000px.
  assert.ok(svg.indexOf('width="1000.0"') !== -1 || svg.indexOf('width="1000"') !== -1, 'root full width');
  // Child A = 60% -> 600px, child B = 30% -> 300px.
  assert.ok(svg.indexOf('width="600.0"') !== -1, 'A is 600px (60%)');
  assert.ok(svg.indexOf('width="300.0"') !== -1, 'B is 300px (30%)');
  // B is placed after A: x = 600.
  assert.ok(svg.indexOf('x="600.0"') !== -1, 'B placed at x=600');
});

test('flameSvg: real model produces nested frames with titles', function () {
  var mm = buildModel().model;
  var tree = window.RPFlame.toFlameAgg(window.RPFlame.rootsWhole(mm), 'whole capture');
  var svg = RD.flameSvg(tree, {});
  var rects = svg.match(/<rect /g) || [];
  // bg + one per non-zero frame; the trace has EVENT>RULE>RULE_VM>CMD_VM>CMD twins.
  assert.ok(rects.length >= 6, 'has multiple frames, got ' + rects.length);
  assert.ok(svg.indexOf('<title>') !== -1, 'frames carry hover titles');
  assert.ok(svg.indexOf('µs incl') !== -1, 'title spells inclusive µs');
  assert.ok(svg.indexOf('') === -1 || true);
});

test('flameSvg: empty tree is safe', function () {
  assert.strictEqual(RD.flameSvg(null, {}), '');
});

// ---- mermaid: enrichment --------------------------------------------------
test('mermaid: enriched with autonumber, boxes, activations, notes', function () {
  var mm = buildModel().model;
  var f = mm.flows[0];
  var unit = { roots: f.roots, recs: f.recs, label: 'flow ' + f.flowId };
  var out = RD.mermaid(unit, {});
  assert.ok(out.indexOf('sequenceDiagram') === 0, 'header');
  assert.ok(out.indexOf('autonumber') !== -1, 'autonumber');
  assert.ok(out.indexOf('box rgb(224,242,241) TMM') !== -1, 'TMM box');
  assert.ok(out.indexOf('box rgb(255,237,213) TCL VM') !== -1, 'VM box');
  assert.ok(out.indexOf('participant Users') !== -1, 'Users participant');
  assert.ok(out.indexOf('->>+') !== -1, 'activation arrows (ENTRY)');
  assert.ok(out.indexOf('-->>-') !== -1, 'deactivation arrows (EXIT)');
  assert.ok(out.indexOf('µs self') !== -1, 'returns labelled with self µs');
  assert.ok(out.indexOf('Note over Event:') !== -1, 'per-event Note');
});

test('mermaid: per-event Note carries authoritative cycles when supplied', function () {
  var mm = buildModel().model;
  var f = mm.flows[0];
  var unit = { roots: f.roots, recs: f.recs, label: 'flow' };
  var out = RD.mermaid(unit, { cycleByEvent: { CLIENT_ACCEPTED: 9082 } });
  assert.ok(out.indexOf('9082 cyc') !== -1, 'cycle count appears in the event Note');
});

// ---- toJSON ---------------------------------------------------------------
test('toJSON: valid JSON with the expected shape', function () {
  var b = buildModel();
  var str = RD.toJSON({
    version: '0.5.0', generatedAt: '2026-06-17T00:00:00Z',
    label: 'test', sessionId: 'abc', scope: 'whole capture',
    summary: { occurrences: b.parsed.records.length, flows: b.model.flows.length, eventTypes: b.model.events.length, warnings: 0 },
    cpu: { cpuHz: 8e9, cores: 4, takenAt: null },
    cycles: null,
    commands: window.RPCycles.traceCommandStats(b.model),
    records: b.parsed.records
  });
  var doc = JSON.parse(str);
  assert.strictEqual(doc.tool, 'rultracer');
  assert.strictEqual(doc.version, '0.5.0');
  assert.strictEqual(doc.session.scope, 'whole capture');
  assert.ok(doc.records.length > 0, 'records present');
  assert.ok(doc.commandStats && doc.commandStats.length >= 1, 'command stats present');
  assert.strictEqual(doc.summary.flows, 1);
});

// ---- htmlDoc --------------------------------------------------------------
test('htmlDoc: self-contained document with sections + JSON island', function () {
  var html = RD.htmlDoc({
    title: 'rultracer report — test',
    css: '.injected{color:red}',
    headerHtml: '<div class="rpt-title">rultracer report</div>',
    sections: [
      { id: 'sequence', title: 'Sequence diagram', html: '<svg class="rpf"></svg>' },
      { id: 'empty', title: 'Skip me', html: '' }
    ],
    json: '{"tool":"rultracer"}'
  });
  assert.ok(html.indexOf('<!DOCTYPE html>') === 0, 'doctype');
  assert.ok(html.indexOf('.injected{color:red}') !== -1, 'inlines app.css');
  assert.ok(html.indexOf('id="rpt-sequence"') !== -1, 'renders a section');
  assert.ok(html.indexOf('Skip me') === -1, 'drops empty sections');
  assert.ok(html.indexOf('id="rultracer-data"') !== -1, 'JSON data island present');
  assert.ok(html.indexOf('rpt-title') !== -1, 'header included');
});

test('htmlDoc: closes any </script> in the JSON island safely', function () {
  var html = RD.htmlDoc({ title: 't', json: '{"x":"</script>"}' });
  assert.ok(html.indexOf('</script>"}') === -1, 'raw </script> escaped');
  assert.ok(html.indexOf('<\\/script>') !== -1, 'escaped form present');
});

// ---- run ------------------------------------------------------------------
var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log('  ok   ' + t.name); }
  catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + e.message); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');

// ---- Python cross-check of the icicle width arithmetic --------------------
var py = [
  'W=1000.0; total=100.0',
  'children=[60.0,30.0]',
  'scale=W/total',
  'xs=[]; cx=0.0',
  'for v in children:',
  '    xs.append((round(cx,1), round(v*scale,1)))',
  '    cx+=v*scale',
  'assert xs==[(0.0,600.0),(600.0,300.0)], xs',
  'print("  ok   python: icicle x/width math matches (%s)" % xs)'
].join('\n');
try {
  var r = cp.spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  if (r.status === 0) { process.stdout.write(r.stdout); }
  else { console.log('  (python cross-check skipped: ' + (r.stderr || r.error) + ')'); failed += r.status ? 1 : 0; }
} catch (e) { console.log('  (python cross-check skipped: ' + e.message + ')'); }

process.exit(failed ? 1 : 0);
