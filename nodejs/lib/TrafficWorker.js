'use strict';

// Built-in HTTP request sender to trigger occurrences against the selected VS
// while a capture runs. POST { host, port, path, method, count, https,
// hostHeader, headers }. Capped at 100 requests. ES5 syntax only.

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
    var count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 100);
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

    var results = [];
    var i = 0;
    function fire() {
        if (i >= count) {
            restutil.ok(self, restOperation, { sent: results.length, results: results });
            return;
        }
        i += 1;
        var req = lib.request(opts, function (res) {
            res.resume();
            res.on('end', function () { results.push({ status: res.statusCode }); fire(); });
        });
        req.on('error', function (e) { results.push({ error: e.message }); fire(); });
        req.setTimeout(5000, function () { req.abort(); });
        if (requestBody) { req.write(requestBody); }
        req.end();
    }
    fire();
};

module.exports = TrafficWorker;
