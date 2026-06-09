'use strict';

// Static SPA server. Modeled on rulbased's uiWorker
// (https://github.com/f5-rahm/rulbased/blob/main/nodejs/lib/uiWorker.js).
//
// Two restnoded gotchas the rulbased pattern resolves:
//   1. isPassThrough = true: without it, restnoded matches only the exact
//      WORKER_URI_PATH; sub-paths (css/, js/) never reach onGet.
//   2. setBody(data) on a Buffer is JSON-serialised by restnoded (the body
//      arrives at the browser as {"type":"Buffer","data":[...]}). Text files
//      must be passed as strings; setContentType handles the response header.
// ES5 syntax only.

var fs = require('fs');
var path = require('path');
var logger = require('./logger');

var WORKER_URI_PATH = 'shared/rultracer/ui';
var PRESENTATION_DIR = '/var/config/rest/iapps/rultracer/presentation';

var MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.map':  'application/json; charset=utf-8'
};

function UiWorker() {
    this.WORKER_URI_PATH = WORKER_URI_PATH;
    this.isPublic = true;
    this.isPassThrough = true;
}

UiWorker.prototype.onStart = function (success) {
    logger.info('UiWorker started, serving from ' + PRESENTATION_DIR);
    success();
};

UiWorker.prototype.onGet = function (restOperation) {
    var uri = restOperation.getUri();
    var pathname = uri ? (uri.pathname || '') : '';

    // Strip the worker base. restnoded may route requests as either
    // /mgmt/shared/rultracer/ui/... (public HTTPS) or /shared/rultracer/ui/...
    // (trusted localhost:8100) -- handle both.
    var prefixes = ['/mgmt/shared/rultracer/ui', '/shared/rultracer/ui'];
    var relative = pathname;
    for (var i = 0; i < prefixes.length; i++) {
        if (pathname.indexOf(prefixes[i]) === 0) {
            relative = pathname.slice(prefixes[i].length);
            break;
        }
    }
    relative = relative.replace(/^\/+/, '') || 'index.html';

    // Path-traversal guard.
    var segments = relative.split('/');
    for (var j = 0; j < segments.length; j++) {
        if (segments[j] === '..' || segments[j] === '.') {
            restOperation.setStatusCode(400);
            restOperation.setBody({ error: 'Invalid path' });
            restOperation.complete();
            return;
        }
    }

    var filePath = path.join(PRESENTATION_DIR, relative);
    var ext = path.extname(filePath).toLowerCase();
    var mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    logger.fine('UiWorker: serving ' + filePath);

    fs.readFile(filePath, function (err, data) {
        if (err) {
            if (err.code === 'ENOENT') {
                restOperation.setStatusCode(404);
                restOperation.setBody({ error: 'File not found: ' + relative });
            } else {
                logger.error('UiWorker: readFile error: ' + err.message);
                restOperation.setStatusCode(500);
                restOperation.setBody({ error: 'Internal error reading file' });
            }
            restOperation.complete();
            return;
        }

        // restnoded JSON-serialises objects/Buffers in setBody; pass a string
        // so the raw text content reaches the browser intact.
        restOperation.setStatusCode(200);
        restOperation.setContentType(mimeType);
        restOperation.setBody(data.toString('utf8'));
        restOperation.complete();
    });
};

module.exports = UiWorker;
