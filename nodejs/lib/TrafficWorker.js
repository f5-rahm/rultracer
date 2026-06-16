'use strict';

// Built-in HTTP request sender to trigger occurrences against the selected VS.
// POST { host, port, path, method, count, https, hostHeader, headers,
//        highVolume, concurrency }.
//
// Two modes:
//   - default (the small profiler run): capped at 100, fired serially, returns
//     a per-request results[] (existing behaviour the Capture view relies on).
//   - highVolume (the Phase 4.1 on-box cycles load, an explicit "quick/dirty"
//     override): cap raised to 1,000,000, fired with bounded concurrency, and
//     returns an aggregate summary instead of a 200k-entry results[]. On-box
//     generation competes with TMM and skews the cycles being measured — the UI
//     surfaces that warning; the engine never picks this path on its own.
// ES5 syntax only.

var http = require('http');
var https = require('https');
var restutil = require('./restutil');

function TrafficWorker() {}
TrafficWorker.prototype.WORKER_URI_PATH = 'shared/rultracer/traffic';
TrafficWorker.prototype.isPublic = true;

TrafficWorker.prototype.onStart = function (success) { success(); };

TrafficWorker.prototype.onPost = function (restOperation) {
    var self = this;
    var body = restOperation.getBody() || {};

    if (!body.host) { return restutil.fail(this, restOperation, new Error('host (VIP address) is required')); }
    var useHttps = !!body.https;
    var highVolume = !!body.highVolume;
    var maxCount = highVolume ? 1000000 : 100;
    var count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), maxCount);
    // Bounded concurrency: serial (1) by default to preserve the small-run
    // behaviour; high-volume defaults to 20 in-flight, clamped to [1, 200].
    var concurrency = Math.min(Math.max(parseInt(body.concurrency, 10) || (highVolume ? 20 : 1), 1), 200);
    var headers = body.headers || {};
    if (body.hostHeader) { headers.Host = body.hostHeader; }

    var method = (body.method || 'GET').toUpperCase();
    var requestBody = null;
    if (typeof body.body === 'string' && body.body.length > 0 &&
        (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        requestBody = body.body;
        if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'text/plain';
        }
        headers['Content-Length'] = Buffer.byteLength(requestBody);
    }

    var opts = {
        host: body.host,
        port: parseInt(body.port, 10) || (useHttps ? 443 : 80),
        path: body.path || '/',
        method: method,
        headers: headers,
        rejectUnauthorized: false
    };
    var lib = useHttps ? https : http;

    var started = 0;     // requests dispatched
    var done = 0;        // requests completed (success or error)
    var ok = 0;
    var failed = 0;
    var statuses = {};   // status-code histogram (high-volume summary)
    var results = [];    // per-request detail (small runs only)
    var replied = false;

    function record(entry) {
        done += 1;
        if (entry.error) { failed += 1; } else {
            ok += 1;
            statuses[entry.status] = (statuses[entry.status] || 0) + 1;
        }
        if (!highVolume) { results.push(entry); }
    }

    function finish() {
        if (replied) { return; }
        replied = true;
        if (highVolume) {
            restutil.ok(self, restOperation, { sent: done, ok: ok, failed: failed, statuses: statuses, concurrency: concurrency });
        } else {
            restutil.ok(self, restOperation, { sent: results.length, results: results });
        }
    }

    // Keep up to `concurrency` requests in flight until `count` have been sent.
    function pump() {
        while (started < count && (started - done) < concurrency) {
            started += 1;
            fireOne();
        }
        if (done >= count) { finish(); }
    }

    function fireOne() {
        var settled = false;
        function settle(entry) {
            if (settled) { return; }
            settled = true;
            record(entry);
            pump();
        }
        var req = lib.request(opts, function (res) {
            res.resume();
            res.on('end', function () { settle({ status: res.statusCode }); });
        });
        req.on('error', function (e) { settle({ error: e.message }); });
        req.setTimeout(5000, function () { req.abort(); });
        if (requestBody) { req.write(requestBody); }
        req.end();
    }

    pump();
};

module.exports = TrafficWorker;
