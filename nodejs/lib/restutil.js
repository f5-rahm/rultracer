'use strict';

// Shared RestWorker helpers: response envelopes, URI path/query parsing, and
// package-relative directory resolution. ES5 syntax only.

var path = require('path');
var querystring = require('querystring');

// Workers live in <pkg>/nodejs/lib, so the package root is two levels up.
function pkgRoot() { return path.join(__dirname, '..', '..'); }
function presentationDir() { return path.join(pkgRoot(), 'presentation'); }

// Session/state data lives under /shared/ -- the iApps LX framework wipes
// /var/config/rest/iapps/<pkg>/ entirely on every INSTALL (in-place upgrade
// AND clean install), so anything inside the package tree is volatile. The
// worker (uid 198) cannot create /shared/rultracer/ itself, but RPM %post
// runs as root and creates it with restnoded ownership during install.
function dataDir() { return '/shared/rultracer/data'; }

// Path segments after the worker base. restnoded may route a request as either
// /mgmt/shared/rultracer/<worker>/... (public HTTPS) or
// /shared/rultracer/<worker>/...   (trusted localhost:8100), so we anchor on
// the package name rather than slicing by a fixed offset.
function segments(restOperation) {
    var u = restOperation.getUri();
    var pathname = (u && u.pathname) ? u.pathname : '';
    var parts = pathname.split('/').filter(function (s) { return s.length > 0; });
    var idx = parts.indexOf('rultracer');
    if (idx >= 0) {
        return parts.slice(idx + 2); // drop 'rultracer' and the worker segment
    }
    return parts.slice(4); // fallback for unexpected prefixes
}

function query(restOperation) {
    var u = restOperation.getUri();
    var q = u ? u.query : null;
    if (!q) { return {}; }
    return (typeof q === 'string') ? querystring.parse(q) : q;
}

// Success envelope: { ok: true, ...data }. Always HTTP 200.
function ok(worker, restOperation, data) {
    restOperation.setStatusCode(200);
    restOperation.setBody(Object.assign({ ok: true }, data || {}));
    worker.completeRestOperation(restOperation);
}

// Failure envelope: { ok: false, error }. Sent as HTTP 200 so the browser can
// read the body (restnoded intercepts non-2xx).
function fail(worker, restOperation, err) {
    restOperation.setStatusCode(200);
    restOperation.setBody({ ok: false, error: (err && err.message) ? err.message : String(err) });
    worker.completeRestOperation(restOperation);
}

module.exports = {
    pkgRoot: pkgRoot,
    dataDir: dataDir,
    presentationDir: presentationDir,
    segments: segments,
    query: query,
    ok: ok,
    fail: fail
};
