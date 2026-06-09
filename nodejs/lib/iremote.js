'use strict';

// Minimal iControl REST GET client against the local control plane on
// localhost:8100, which trusts the username with no password. Used for READS
// only (virtuals, rules, log-config). Writes go through tmsh.js. ES5 syntax.

var http = require('http');

function authHeader() {
    return 'Basic ' + Buffer.from('admin:').toString('base64');
}

// GET a JSON resource. Resolves the parsed body; rejects on transport error or
// non-2xx status.
function get(uri) {
    return new Promise(function (resolve, reject) {
        var options = {
            host: 'localhost',
            port: 8100,
            method: 'GET',
            path: uri,
            headers: {
                'Authorization': authHeader(),
                'Content-Type': 'application/json'
            }
        };
        var req = http.request(options, function (res) {
            var body = '';
            res.setEncoding('utf8');
            res.on('data', function (d) { body += d; });
            res.on('end', function () {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('iControl GET ' + uri + ' -> ' + res.statusCode + ': ' + body));
                    return;
                }
                try {
                    resolve(body ? JSON.parse(body) : {});
                } catch (e) {
                    reject(new Error('iControl GET ' + uri + ' returned invalid JSON: ' + e.message));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, function () { req.abort(); });
        req.end();
    });
}

// Convenience: GET .items[] from a collection, defaulting to [].
function getItems(uri) {
    return get(uri).then(function (body) {
        return (body && Array.isArray(body.items)) ? body.items : [];
    });
}

// POST a JSON body. Resolves the parsed response body; rejects on transport
// error or non-2xx status. Used to drive /mgmt/tm/util/bash so commands run
// as root and avoid the restnoded-uid-198 history-file write failure.
function post(uri, body) {
    var bodyStr = JSON.stringify(body || {});
    return new Promise(function (resolve, reject) {
        var options = {
            host: 'localhost',
            port: 8100,
            method: 'POST',
            path: uri,
            headers: {
                'Authorization': authHeader(),
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        };
        var req = http.request(options, function (res) {
            var resBody = '';
            res.setEncoding('utf8');
            res.on('data', function (d) { resBody += d; });
            res.on('end', function () {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error('iControl POST ' + uri + ' -> ' + res.statusCode + ': ' + resBody));
                    return;
                }
                try {
                    resolve(resBody ? JSON.parse(resBody) : {});
                } catch (e) {
                    reject(new Error('iControl POST ' + uri + ' returned invalid JSON: ' + e.message));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, function () { req.abort(); });
        req.write(bodyStr);
        req.end();
    });
}

module.exports = {
    get: get,
    getItems: getItems,
    post: post
};
