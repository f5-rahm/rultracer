'use strict';

// Zero-dependency test harness. Run from the repo root with Node (incl. the
// BIG-IP's Node 6.9.1):  node test/unit.js
// Exercises the pure on-box logic (no tmsh / iControl needed): trace extraction
// against the real VE capture fixture, input validation, the rule-profiler
// command builder, and the session store + retention.

var assert = require('assert');
var path = require('path');
var os = require('os');
var fs = require('fs');

var capture = require('../nodejs/lib/capture');
var validate = require('../nodejs/lib/validate');
var profiler = require('../nodejs/lib/profiler');
var util = require('../nodejs/lib/util');
var Store = require('../nodejs/lib/store');

var FIXTURE = path.join(__dirname, '..', 'background info', 'example-logs.txt');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- validation -----------------------------------------------------------
test('validate accepts /Common paths, rejects tmsh metacharacters', function () {
    assert.ok(validate.isValidName('/Common/testvip-http'));
    assert.ok(validate.isValidName('rultracer_123-abc'));
    assert.ok(!validate.isValidName('foo { bar }'));
    assert.ok(!validate.isValidName('foo;bar'));
    assert.ok(!validate.isValidName('foo\nbar'));
    assert.throws(function () { validate.assertName('a b'); });
});

test('validate event + occ-mask + period', function () {
    assert.ok(validate.isValidEvent('HTTP_REQUEST'));
    assert.ok(!validate.isValidEvent('http_request'));
    assert.throws(function () { validate.assertOccMask([]); });
    assert.throws(function () { validate.assertOccMask(['bogus']); });
    assert.deepEqual(validate.assertOccMask(['cmd', 'event']), ['cmd', 'event']);
    assert.strictEqual(validate.normalizePeriod('5000', 600000), 5000);
    assert.strictEqual(validate.normalizePeriod(999999, 600000), 600000);
    assert.strictEqual(validate.normalizePeriod('nope', 1000), null);
});

// ---- trace extraction (against the real VE capture) -----------------------
test('capture.extract parses the real example log', function () {
    var text = fs.readFileSync(FIXTURE, 'utf8');
    var ex = capture.extract(text, { vs: '/Common/testvip-http' });
    assert.strictEqual(ex.stats.matched, 40, 'expected 40 matched lines');
    assert.strictEqual(ex.stats.malformed, 0, 'expected 0 malformed lines');
    assert.strictEqual(ex.lines.length, 40);

    // every kept line has exactly 12 fields and field[1] starts with RP_
    ex.lines.forEach(function (csv) {
        var f = csv.split(',');
        assert.strictEqual(f.length, 12, 'expected 12 fields: ' + csv);
        assert.ok(/^RP_/.test(f[capture.FIELDS.OCC]), 'field 1 should be RP_*: ' + csv);
    });

    // ENTRY/EXIT counts are balanced per paired family
    var counts = {};
    ex.lines.forEach(function (csv) {
        var occ = csv.split(',')[capture.FIELDS.OCC];
        counts[occ] = (counts[occ] || 0) + 1;
    });
    ['RP_EVENT', 'RP_RULE', 'RP_RULE_VM', 'RP_CMD', 'RP_CMD_VM'].forEach(function (fam) {
        assert.strictEqual(counts[fam + '_ENTRY'], counts[fam + '_EXIT'],
            fam + ' entry/exit must balance');
    });
});

test('capture.extract filters by virtual server', function () {
    var text = fs.readFileSync(FIXTURE, 'utf8');
    var ex = capture.extract(text, { vs: '/Common/does-not-exist' });
    assert.strictEqual(ex.stats.matched, 0);
    assert.ok(ex.stats.filtered > 0);
});

// ---- rule-profiler command builder ----------------------------------------
test('profiler.buildCreateCmd builds a valid tmsh string', function () {
    var cmd = profiler.buildCreateCmd({
        name: 'rultracer_abc',
        vs: '/Common/testvip-http',
        events: ['CLIENT_ACCEPTED', 'HTTP_REQUEST'],
        rules: ['/Common/testrul'],
        periodMs: 5000,
        publisher: 'rultracer_pub'
    });
    assert.ok(cmd.indexOf('create ltm rule-profiler rultracer_abc') === 0);
    assert.ok(cmd.indexOf('vs-filter add { /Common/testvip-http }') !== -1);
    assert.ok(cmd.indexOf('event-filter add { CLIENT_ACCEPTED HTTP_REQUEST }') !== -1);
    assert.ok(cmd.indexOf('rule-filter add { /Common/testrul }') !== -1);
    assert.ok(cmd.indexOf('publisher rultracer_pub') !== -1);
    assert.ok(cmd.indexOf('period 5000') !== -1);
    assert.ok(/state disabled$/.test(cmd));
});

test('profiler.buildCreateCmd rejects an injected vs name', function () {
    assert.throws(function () {
        profiler.buildCreateCmd({ name: 'x', vs: '/Common/v } ; delete sys', publisher: 'p' });
    });
});

test('profiler.profilerName is tmsh-safe', function () {
    assert.ok(validate.isValidName(profiler.profilerName('1780079189187-a1b2')));
    assert.strictEqual(profiler.profilerName('1780079189187-a1b2'), 'rultracer_1780079189187_a1b2');
});

// ---- session store + retention --------------------------------------------
test('store create/list/retention/delete', function () {
    var dir = path.join(os.tmpdir(), 'rultracer-test-' + Date.now());
    var store = new Store(dir);
    return store.init()
        .then(function () { return store.createSession({ id: 's1', name: 'one', createdAt: '2026-05-29T10:00:00Z' }); })
        .then(function () { return store.writeRaw('s1', ['1,RP_EVENT_ENTRY,/Common/v,X,1,0x0,a,1,0,b,2,0']); })
        .then(function () { return store.createSession({ id: 's2', name: 'two', createdAt: '2026-05-29T10:01:00Z' }); })
        .then(function () { return store.createSession({ id: 's3', name: 'three', createdAt: '2026-05-29T10:02:00Z' }); })
        .then(function () { return store.listSessions(); })
        .then(function (list) {
            assert.strictEqual(list.length, 3);
            assert.strictEqual(list[0].id, 's3', 'newest first');
            assert.strictEqual(list[2].id, 's1', 'oldest last');
        })
        .then(function () { return store.enforceRetention(2, 0); })
        .then(function (pruned) {
            assert.strictEqual(pruned.length, 1);
            assert.strictEqual(pruned[0], 's1', 'oldest pruned first');
        })
        .then(function () { return store.listSessions(); })
        .then(function (list) { assert.strictEqual(list.length, 2); })
        .then(function () { return util.rimraf(dir); });
});

// ---- runner ----------------------------------------------------------------
var pass = 0, fail = 0;
tests.reduce(function (p, t) {
    return p.then(function () {
        return Promise.resolve().then(t.fn).then(
            function () { pass += 1; console.log('  ok   - ' + t.name); },
            function (e) { fail += 1; console.log('  FAIL - ' + t.name + ': ' + (e && e.message)); }
        );
    });
}, Promise.resolve()).then(function () {
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
});
