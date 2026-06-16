'use strict';

// Phase 4 (goal 7) CPU + rule-stats helpers, shared by InventoryWorker (live
// reads) and SessionWorker (snapshot-into-manifest). ES5 syntax only.
//
//   cpuInfo()           -> { cpuHz, cores, mhz:[...] } from /proc/cpuinfo
//   ruleStats(name)     -> { rule, events:[{event,executions,min/avg/maxCycles}] }
//   resetStats(name)    -> tmsh reset-stats ltm rule <name>  (zero the counters)
//   snapshot(names)     -> { cpuHz, cores, mhz, takenAt, rules:[ruleStats...] }
//
// cpuHz follows the DevCentral calculator: SUM of every core's MHz * 1e6 (the
// whole-box cycle budget). Reads /proc/cpuinfo via util/bash (root) because the
// restnoded worker is uid 198; matches the gist's `cat /proc/cpuinfo | grep MHz`.

var iremote = require('./iremote');
var tmsh = require('./tmsh');
var validate = require('./validate');

// Parse "cpu MHz : 3095.158" lines; sum them (all cores) and count.
function parseMhz(text) {
    var mhz = [];
    var lines = String(text || '').split(/\r?\n/);
    var re = /MHz\s*:\s*([0-9.]+)/i;
    for (var i = 0; i < lines.length; i++) {
        var m = re.exec(lines[i]);
        if (m) { mhz.push(parseFloat(m[1])); }
    }
    var sum = 0;
    for (var j = 0; j < mhz.length; j++) { sum += mhz[j]; }
    return { cpuHz: sum * 1e6, cores: mhz.length, mhz: mhz };
}

function cpuInfo() {
    // `grep MHz` has no shell metacharacters, so runBash's `-c "<cmd>"` is safe.
    return tmsh.runBash('grep -i MHz /proc/cpuinfo').then(function (res) {
        var info = parseMhz(res.stdout);
        if (!info.cores) { throw new Error('could not read cpu MHz from /proc/cpuinfo'); }
        return info;
    });
}

// Encode /Common/name -> ~Common~name for the iControl REST path.
function encName(name) {
    return '~' + name.replace(/^\//, '').replace(/\//g, '~');
}

// Pull per-event cycle stats out of the nested iControl stats envelope.
function parseRuleStats(name, body) {
    var events = [];
    var entries = (body && body.entries) || {};
    Object.keys(entries).forEach(function (k) {
        var ns = entries[k] && entries[k].nestedStats;
        var e = ns && ns.entries;
        if (!e) { return; }
        var evType = e.eventType && e.eventType.description;
        if (!evType) { return; } // skip non-per-event aggregate rows
        events.push({
            event: evType,
            executions: pick(e, 'totalExecutions'),
            minCycles: pick(e, 'minCycles'),
            avgCycles: pick(e, 'avgCycles'),
            maxCycles: pick(e, 'maxCycles'),
            failures: pick(e, 'failures'),
            aborts: pick(e, 'aborts')
        });
    });
    return { rule: name, events: events };
}
function pick(e, field) {
    return (e[field] && e[field].value != null) ? e[field].value : 0;
}

function ruleStats(name) {
    validate.assertName(name, 'rule');
    return iremote.get('/mgmt/tm/ltm/rule/' + encName(name) + '/stats').then(function (body) {
        return parseRuleStats(name, body);
    });
}

function resetStats(name) {
    validate.assertName(name, 'rule');
    return tmsh.run('reset-stats ltm rule ' + name);
}

// Fetch CPU facts + per-rule stats for the given rule names. Rules that fail to
// stat (e.g. deleted) resolve to an empty events list rather than failing the
// whole snapshot.
function snapshot(names) {
    names = (names || []).filter(Boolean);
    return cpuInfo().then(function (cpu) {
        return Promise.all(names.map(function (n) {
            return ruleStats(n).then(function (rs) { return rs; }, function () { return { rule: n, events: [] }; });
        })).then(function (rules) {
            return {
                cpuHz: cpu.cpuHz, cores: cpu.cores, mhz: cpu.mhz,
                takenAt: new Date().toISOString(),
                rules: rules
            };
        });
    });
}

module.exports = {
    cpuInfo: cpuInfo,
    ruleStats: ruleStats,
    resetStats: resetStats,
    snapshot: snapshot,
    // exposed for tests
    _parseMhz: parseMhz,
    _parseRuleStats: parseRuleStats
};
