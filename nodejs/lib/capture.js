'use strict';

// Reads rule-profiler occurrence lines out of /var/log/ltm.
//
// A publisher with the built-in local-syslog destination lands rule-profiler
// output in /var/log/ltm, each line prefixed by syslog, e.g.:
//   May 29 11:26:29 bigip02.f5demo.com info tmm[22555]: 1780079189187194,RP_EVENT_ENTRY,/Common/testvip-http,CLIENT_ACCEPTED,22623,0x...,10.1.10.6,36086,0,10.1.10.50,80,0
// On multi-TMM hardware the program tag is tmm0[..]/tmm1[..]; on the VE it is
// bare tmm[..]. We capture the CSV payload after the "tmm...[pid]: " marker and
// keep only this session's lines (by virtual server and capture-start time).
//
// Confirmed on TMOS 17.1 VE: exactly 12 CSV fields, NO trailing field, and the
// timestamp (field 0) is microseconds since the Unix epoch. ES5 syntax only.

var fs = require('fs');
var util = require('./util');
var tmsh = require('./tmsh');

var LTM_LOG = '/var/log/ltm';

// Match "...tmm[12345]: <ts>,RP_..." and capture the CSV payload (group 1).
// Handles the optional TMM index (tmm0/tmm1/...) seen on multi-TMM systems.
var RP_LINE_RE = /tmm\d*\[\d+\]:\s+(\d+,RP_[^\r\n]*)/;

// CSV field indices (post-prefix-strip).
var F = {
    TS: 0, OCC: 1, VS: 2, VALUE: 3, CTX: 4, FLOW: 5,
    RIP: 6, RPORT: 7, RRD: 8, LIP: 9, LPORT: 10, LRD: 11
};

// Current byte length of the log (0 if it doesn't exist yet). Recorded at
// capture start so we only read what arrives during this session.
function currentSize(filePath) {
    return util.pStat(filePath || LTM_LOG).then(
        function (st) { return st.size; },
        function (err) { if (err.code === 'ENOENT') { return 0; } throw err; }
    );
}

// Read the log from startOffset to EOF and return only the rule-profiler
// (`RP_`) lines. /var/log/ltm is 0640 root:adm so the worker (uid 198) cannot
// open() it directly. We have bash do the read+filter as root via the same
// /util/bash channel tmsh uses, dropping the result into a temp file we then
// chown to restnoded so the worker can fs.readFile + unlink it.
//
// Rotation detection: if currentSize < startOffset the log was rotated, so we
// reset to byte 1 (tail -c +1). `tail -c +N` is 1-indexed.
//
// Resolves { text, endOffset, rotated, lineCount }.
function readFrom(filePath, startOffset) {
    filePath = filePath || LTM_LOG;
    // filePath is interpolated into a root bash script below. It is always the
    // LTM_LOG constant today, but assert a safe absolute path (no shell
    // metacharacters / quotes) so a future caller can never turn this into a
    // root command injection. Combined with the single-quoting in the script.
    if (!/^\/[A-Za-z0-9_./-]+$/.test(filePath)) {
        return Promise.reject(new Error('unsafe log path: ' + JSON.stringify(filePath)));
    }
    var token = 'rultracer_' + String(Date.now()) + '_' + Math.floor(Math.random() * 100000);
    var scriptFile = '/var/tmp/' + token + '.sh';
    var dataFile = '/var/tmp/' + token + '.raw';

    return currentSize(filePath).then(function (size) {
        var fromOffset = startOffset || 0;
        var rotated = size < fromOffset;
        var tailFrom = rotated ? 1 : (fromOffset + 1);
        if (size <= fromOffset && !rotated) {
            return { text: '', endOffset: size, rotated: false };
        }

        // Bash script runs as root (via /util/bash). Single-quoted grep
        // pattern preserves the backslashes inside (\[ \]) literally so grep
        // -E sees them as escaped brackets.
        var script =
            '#!/bin/sh\n' +
            'tail -c +' + tailFrom + " '" + filePath + "'" +
                " | grep -E 'tmm[0-9]*\\[[0-9]+\\]: [0-9]+,RP_' > '" + dataFile + "' 2>/dev/null\n" +
            "chown restnoded:restnoded '" + dataFile + "' 2>/dev/null\n" +
            "chmod 0644 '" + dataFile + "'\n";

        return util.pWriteFile(scriptFile, script)
            .then(function () { return tmsh.runBash("sh '" + scriptFile + "'"); })
            .then(function () { return util.readFileOrNull(dataFile); })
            .then(function (text) {
                util.pUnlink(scriptFile).then(function () {}, function () {});
                util.pUnlink(dataFile).then(function () {}, function () {});
                return { text: text || '', endOffset: size, rotated: rotated };
            });
    });
}

// Pull this session's RP_ lines from a block of log text.
//   opts.vs        - keep only lines for this virtual server (optional)
//   opts.minMicros - keep only lines at/after this epoch-microsecond time (optional)
// Resolves synchronously-shaped { lines: [csv...], stats }.
function extract(text, opts) {
    opts = opts || {};
    var vs = opts.vs || null;
    var minMicros = opts.minMicros || 0;
    var rawLines = text.split(/\r?\n/);
    var out = [];
    var stats = { scanned: rawLines.length, matched: 0, malformed: 0, filtered: 0 };
    for (var i = 0; i < rawLines.length; i++) {
        var m = RP_LINE_RE.exec(rawLines[i]);
        if (!m) { continue; }
        var csv = m[1];
        var f = csv.split(',');
        if (f.length < 12) { stats.malformed++; continue; }
        var ts = parseInt(f[F.TS], 10);
        if (isNaN(ts)) { stats.malformed++; continue; }
        if (minMicros && ts < minMicros) { stats.filtered++; continue; }
        if (vs && f[F.VS] !== vs) { stats.filtered++; continue; }
        out.push(csv);
        stats.matched++;
    }
    return { lines: out, stats: stats };
}

module.exports = {
    LTM_LOG: LTM_LOG,
    RP_LINE_RE: RP_LINE_RE,
    FIELDS: F,
    currentSize: currentSize,
    readFrom: readFrom,
    extract: extract
};
