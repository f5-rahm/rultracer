'use strict';

// Zero-dependency browser-logic test harness for the Phase 2 analysis pipeline.
// Run from the repo root:  node test/phase2.js  (works on the BIG-IP's Node
// 6.9.1 too — the clientside modules use ES6 that 6.9.1 supports).
//
// The presentation modules are browser IIFEs that attach to `window`; we provide
// `window` + a minimal `document` stub so they load (catching syntax errors),
// then exercise the pure logic — parser, model pairing/durations, source map —
// against the real VE capture fixture. DOM rendering (seqdiagram/stepthrough)
// is loaded for syntax coverage but not driven here.

var assert = require('assert');
var path = require('path');
var fs = require('fs');

// --- browser environment stubs --------------------------------------------
global.window = {};
function stubNode() {
  return {
    style: {}, dataset: {}, children: [],
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    appendChild: function (c) { this.children.push(c); return c; },
    setAttribute: function () {}, addEventListener: function () {},
    set textContent(v) {}, get textContent() { return ''; }
  };
}
global.document = {
  createElement: stubNode, createElementNS: stubNode,
  createTextNode: function (s) { return { nodeValue: s }; },
  getElementById: function () { return null; },
  querySelector: function () { return null; }
};

var JS_DIR = path.join(__dirname, '..', 'presentation', 'js');
var FIXTURE = path.join(__dirname, '..', 'background info', 'example-logs.txt');
var IRULE = path.join(__dirname, '..', 'presentation', 'fixtures', 'example-irule.txt');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// --- module load (syntax coverage for all six) ----------------------------
test('all Phase 2 modules load without error', function () {
  ['parser', 'model', 'seqdiagram', 'stepthrough', 'sourcemap', 'analysis'].forEach(function (m) {
    var code = fs.readFileSync(path.join(JS_DIR, m + '.js'), 'utf8');
    eval(code); // attaches to global.window
  });
  assert.ok(window.RPParser && window.RPModel && window.SourceMap, 'core namespaces present');
  assert.ok(window.SeqDiagram && window.StepThrough && window.Analysis, 'view namespaces present');
});

// --- parser ---------------------------------------------------------------
test('parser handles the prefixed fixture: 40 occurrences, 12 fields, classified', function () {
  var p = window.RPParser.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.strictEqual(p.records.length, 40, 'parsed 40 records');
  assert.strictEqual(p.errors.length, 0, 'no parse errors');
  assert.deepEqual(p.meta.events.sort(), ['CLIENT_ACCEPTED', 'HTTP_REQUEST']);
  assert.strictEqual(p.meta.flowIds.length, 1, 'single flow');
  var ev = p.records[0];
  assert.strictEqual(ev.base, 'EVENT'); assert.strictEqual(ev.kind, 'ENTRY');
  assert.strictEqual(ev.domain, 'TMM'); assert.strictEqual(ev.lifeline, 'Event');
  var vm = p.records.filter(function (r) { return r.base === 'VAR_MOD'; })[0];
  assert.strictEqual(vm.varName, 'cip'); assert.strictEqual(vm.varValue, '10.1.10.6');
});

test('parser also handles prefix-stripped raw.csv lines', function () {
  var stripped = '1780079189187194,RP_EVENT_ENTRY,/Common/v,CLIENT_ACCEPTED,1,0xabc,10.1.1.1,1,0,10.1.1.2,80,0';
  var p = window.RPParser.parse(stripped);
  assert.strictEqual(p.records.length, 1);
  assert.strictEqual(p.records[0].value, 'CLIENT_ACCEPTED');
});

// --- model ----------------------------------------------------------------
test('model pairs spans, nests CMD in CMD_VM, computes self time', function () {
  var p = window.RPParser.parse(fs.readFileSync(FIXTURE, 'utf8'));
  var m = window.RPModel.build(p.records);
  assert.strictEqual(m.flows.length, 1);
  assert.strictEqual(m.warnings.length, 0, 'clean pairing, no warnings');
  var flow = m.flows[0];
  assert.strictEqual(flow.roots.length, 2, 'two event spans');
  var clientAccepted = flow.roots[0];
  assert.strictEqual(clientAccepted.base, 'EVENT');
  assert.strictEqual(clientAccepted.raw, 163);
  assert.strictEqual(clientAccepted.sumChildren + clientAccepted.realExecTime, clientAccepted.raw);
  // EVENT > RULE > RULE_VM > CMD_VM > CMD
  var rule = clientAccepted.children[0];
  var ruleVm = rule.children[0];
  var cmdVm = ruleVm.children[0];
  var cmd = cmdVm.children[0];
  assert.strictEqual(rule.base, 'RULE');
  assert.strictEqual(ruleVm.base, 'RULE_VM');
  assert.strictEqual(cmdVm.base, 'CMD_VM');
  assert.strictEqual(cmd.base, 'CMD');
  assert.strictEqual(cmd.value, 'IP::client_addr');
  assert.ok(ruleVm.points.length === 6, 'RULE_VM carries 6 bytecode/var points');
});

test('model tolerates real multi-flow captures and flags unmatched spans', function () {
  // synthesize a truncated trace: an EVENT_ENTRY with no EXIT
  var raw = [
    '100,RP_EVENT_ENTRY,/Common/v,HTTP_REQUEST,1,0xaa,10.1.1.1,1,0,10.1.1.2,80,0',
    '110,RP_RULE_ENTRY,/Common/v,/Common/r,1,0xaa,10.1.1.1,1,0,10.1.1.2,80,0',
    '120,RP_RULE_EXIT,/Common/v,/Common/r,1,0xaa,10.1.1.1,1,0,10.1.1.2,80,0'
    // EVENT_EXIT missing -> unmatched
  ].join('\n');
  var m = window.RPModel.build(window.RPParser.parse(raw).records);
  assert.ok(m.warnings.length >= 1, 'unmatched EVENT flagged');
  assert.strictEqual(m.flows[0].roots[0].unmatched, true);
});

// --- source map -----------------------------------------------------------
test('source map: handlers split + per-event/rule command stats (no double count)', function () {
  var m = window.RPModel.build(window.RPParser.parse(fs.readFileSync(FIXTURE, 'utf8')).records);
  var hs = window.SourceMap.handlers(fs.readFileSync(IRULE, 'utf8'));
  assert.deepEqual(hs.map(function (h) { return h.event; }), ['CLIENT_ACCEPTED', 'HTTP_REQUEST']);
  var stats = window.SourceMap.commandStats(m);
  // CMD_VM + CMD both present -> count once per invocation, with timing.
  var ca = stats.byEvent.get('CLIENT_ACCEPTED').get('IP::client_addr');
  assert.strictEqual(ca.count, 1);
  assert.ok(ca.totalRaw > 0, 'has elapsed µs');
  assert.ok(ca.totalSelf >= 0, 'has self µs');
  assert.strictEqual(stats.byEvent.get('HTTP_REQUEST').get('HTTP::respond').count, 1);
  // per-rule attribution (the fixture rule is /Common/testrul)
  var re = stats.byRuleEvent.get('/Common/testrul CLIENT_ACCEPTED');
  assert.ok(re && re.get('IP::client_addr').count === 1, 'attributed to the rule');
});

test('source map: command-token detection flags un-fired branch lines', function () {
  // log is a command token; if it never fired it should be detectable as such.
  assert.ok(window.SourceMap.commandTokens('        log local0. "denied"').indexOf('log') !== -1);
  assert.ok(window.SourceMap.commandTokens('    HTTP::respond 200 content "x"').indexOf('HTTP::respond') !== -1);
  assert.strictEqual(window.SourceMap.commandTokens('    if { $x == 1 } {').length, 0);
});

// --- run ------------------------------------------------------------------
var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log('  ok  - ' + t.name); }
  catch (e) { failed++; console.log('FAIL  - ' + t.name + '\n        ' + (e && e.message)); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
