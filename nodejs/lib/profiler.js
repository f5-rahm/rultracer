'use strict';

// Builds and runs the tmsh commands that drive `ltm rule-profiler`. Confirmed
// real sequence (TMOS 17.1 VE):
//   create ... event-filter add {..} vs-filter add {..} publisher .. state disabled
//   modify ... occ-mask { .. }
//   modify ... state enabled
//   start ...   /   stop ...   /   delete ...
// All object names are validated before interpolation. ES5 syntax only.

var tmsh = require('./tmsh');
var validate = require('./validate');

// Prefix on every profiler object we create, so the startup orphan-sweep can
// recognize and remove anything we left behind after a crash.
var PREFIX = 'rultracer_';

function profilerName(sessionId) {
    return PREFIX + String(sessionId).replace(/[^A-Za-z0-9_]/g, '_');
}

// Build the create command. Matches the user's verified hand-test pattern:
// only filters + publisher in the create. period / occ-mask / state are set
// in separate modify calls -- on 17.x, packing them into the create string
// breaks publisher binding ("requires log publisher" is the symptom).
//   cfg: { name, vs, rules[], events[], publisher }
function buildCreateCmd(cfg) {
    validate.assertName(cfg.name, 'rule-profiler name');
    var parts = ['create ltm rule-profiler ' + cfg.name];
    if (cfg.vs) {
        validate.assertName(cfg.vs, 'vs');
        parts.push('vs-filter add { ' + cfg.vs + ' }');
    }
    if (cfg.rules && cfg.rules.length) {
        cfg.rules.forEach(function (r) { validate.assertName(r, 'rule'); });
        parts.push('rule-filter add { ' + cfg.rules.join(' ') + ' }');
    }
    if (cfg.events && cfg.events.length) {
        cfg.events.forEach(function (e) { validate.assertEvent(e); });
        parts.push('event-filter add { ' + cfg.events.join(' ') + ' }');
    }
    validate.assertName(cfg.publisher, 'publisher');
    parts.push('publisher ' + cfg.publisher);
    return parts.join(' ');
}

function create(cfg) {
    return tmsh.run(buildCreateCmd(cfg));
}

function setOccMask(name, occMask) {
    validate.assertName(name, 'rule-profiler name');
    validate.assertOccMask(occMask);
    return tmsh.run('modify ltm rule-profiler ' + name + ' occ-mask { ' + occMask.join(' ') + ' }');
}

function setPeriod(name, periodMs) {
    validate.assertName(name, 'rule-profiler name');
    return tmsh.run('modify ltm rule-profiler ' + name + ' period ' + parseInt(periodMs, 10));
}

function setState(name, state) {
    validate.assertName(name, 'rule-profiler name');
    var s = (state === 'enabled') ? 'enabled' : 'disabled';
    return tmsh.run('modify ltm rule-profiler ' + name + ' state ' + s);
}

function start(name) {
    validate.assertName(name, 'rule-profiler name');
    return tmsh.run('start ltm rule-profiler ' + name);
}

function stop(name) {
    validate.assertName(name, 'rule-profiler name');
    return tmsh.runSafe('stop ltm rule-profiler ' + name);
}

function destroy(name) {
    validate.assertName(name, 'rule-profiler name');
    return tmsh.runSafe('delete ltm rule-profiler ' + name);
}

// Existing rule-profiler object names (for the orphan sweep / teardown).
function listNames() {
    return tmsh.runSafe('list ltm rule-profiler one-line').then(function (res) {
        if (!res.ok || !res.stdout) { return []; }
        var names = [];
        res.stdout.split(/\r?\n/).forEach(function (line) {
            var m = /^ltm rule-profiler (\S+)/.exec(line.trim());
            if (m) { names.push(m[1]); }
        });
        return names;
    });
}

// Disable + delete any leftover rultracer_* profilers. Resolves removed names.
function sweepOrphans() {
    return listNames().then(function (names) {
        var mine = names.filter(function (n) { return n.indexOf(PREFIX) === 0; });
        return mine.reduce(function (p, n) {
            return p.then(function (removed) {
                return setState(n, 'disabled').then(function () {}, function () {})
                    .then(function () { return destroy(n); })
                    .then(function () { removed.push(n); return removed; });
            });
        }, Promise.resolve([]));
    });
}

module.exports = {
    PREFIX: PREFIX,
    profilerName: profilerName,
    buildCreateCmd: buildCreateCmd,
    create: create,
    setOccMask: setOccMask,
    setPeriod: setPeriod,
    setState: setState,
    start: start,
    stop: stop,
    destroy: destroy,
    listNames: listNames,
    sweepOrphans: sweepOrphans
};
