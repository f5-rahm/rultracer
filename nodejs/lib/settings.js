'use strict';

// Persisted, user-adjustable settings under <dataDir>/settings.json. ES5 syntax.

var path = require('path');
var util = require('./util');

var DEFAULTS = {
    retentionMaxSessions: 20,
    retentionMaxBytes: 524288000, // ~500 MB
    publisherMode: 'auto',        // auto | reuse | create
    maxPeriodMs: 600000,          // safety ceiling for the rule-profiler period
    disasmEnabled: false          // Phase 8 bytecode disassembler: opt-in, default OFF
};

function file(dataDir) { return path.join(dataDir, 'settings.json'); }

function load(dataDir) {
    return util.readFileOrNull(file(dataDir)).then(function (txt) {
        if (!txt) { return Object.assign({}, DEFAULTS); }
        try { return Object.assign({}, DEFAULTS, JSON.parse(txt)); }
        catch (e) { return Object.assign({}, DEFAULTS); }
    });
}

function save(dataDir, patch) {
    return load(dataDir).then(function (cur) {
        var merged = Object.assign({}, cur, patch || {});
        return util.pWriteFile(file(dataDir), JSON.stringify(merged, null, 2)).then(function () { return merged; });
    });
}

module.exports = {
    DEFAULTS: DEFAULTS,
    load: load,
    save: save
};
