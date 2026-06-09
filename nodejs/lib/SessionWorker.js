'use strict';

// CRUD over persisted capture sessions.
//   GET    /sessions            -> list manifests (newest first)
//   GET    /sessions/<id>       -> one manifest
//   GET    /sessions/<id>/raw   -> { raw: "<csv text>" } for the browser parser
//   GET    /sessions/export     -> { sessions: [{manifest, raw}, ...] } -- download all
//   POST   /sessions/import     -> { sessions: [{manifest, raw}, ...] } -> { imported, failed }
//   DELETE /sessions/<id>       -> delete one
// ES5 syntax only.

var Store = require('./store');
var restutil = require('./restutil');
var util = require('./util');

function SessionWorker() {
    this.WORKER_URI_PATH = 'shared/rultracer/sessions';
    this.isPublic = true;
    this.isPassThrough = true; // sub-paths (/<id>, /<id>/raw) must reach onGet/onDelete
}

SessionWorker.prototype.onStart = function (success) {
    this.store = new Store(restutil.dataDir());
    success();
};

SessionWorker.prototype.onGet = function (restOperation) {
    var self = this;
    var seg = restutil.segments(restOperation);

    if (seg.length === 0) {
        this.store.listSessions()
            .then(function (list) { restutil.ok(self, restOperation, { sessions: list }); })
            .catch(function (err) { restutil.fail(self, restOperation, err); });
        return;
    }

    if (seg[0] === 'export') {
        return this._export(restOperation);
    }

    var id = seg[0];
    if (seg[1] === 'raw') {
        util.readFileOrNull(this.store.rawPath(id))
            .then(function (txt) {
                if (txt === null) { return restutil.fail(self, restOperation, new Error('no raw data for session ' + id)); }
                restutil.ok(self, restOperation, { raw: txt });
            })
            .catch(function (err) { restutil.fail(self, restOperation, err); });
        return;
    }

    this.store.getManifest(id)
        .then(function (m) {
            if (!m) { return restutil.fail(self, restOperation, new Error('no such session: ' + id)); }
            restutil.ok(self, restOperation, { session: m });
        })
        .catch(function (err) { restutil.fail(self, restOperation, err); });
};

SessionWorker.prototype.onPost = function (restOperation) {
    var seg = restutil.segments(restOperation);
    if (seg.length >= 1 && seg[0] === 'import') {
        return this._import(restOperation);
    }
    restutil.fail(this, restOperation, new Error('unknown sessions path: POST /' + seg.join('/')));
};

// GET /sessions/export -> JSON bundle of every session's manifest + raw.csv
// content. Intended for the SPA to write to disk as a backup before an install
// that will wipe the package-internal data directory.
SessionWorker.prototype._export = function (restOperation) {
    var self = this;
    this.store.listSessions().then(function (manifests) {
        return util.serial(manifests.map(function (m) {
            return function () {
                return util.readFileOrNull(self.store.rawPath(m.id)).then(function (raw) {
                    return { manifest: m, raw: raw || '' };
                });
            };
        }));
    }).then(function (bundle) {
        restutil.ok(self, restOperation, {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            sessionCount: bundle.length,
            sessions: bundle
        });
    }).catch(function (err) { restutil.fail(self, restOperation, err); });
};

// POST /sessions/import { sessions: [{manifest, raw}, ...] }
// Re-creates each session under the data dir, preserving id and createdAt so
// the restored sessions keep their original ordering. Existing sessions with
// the same id are overwritten (intentional: lets users re-import the same
// backup safely after partial failures).
SessionWorker.prototype._import = function (restOperation) {
    var self = this;
    var body = restOperation.getBody() || {};
    if (!Array.isArray(body.sessions)) {
        return restutil.fail(this, restOperation, new Error('expected { sessions: [...] } in body'));
    }
    var imported = 0;
    var failed = 0;
    util.serial(body.sessions.map(function (entry) {
        return function () {
            if (!entry || !entry.manifest || !entry.manifest.id) {
                failed += 1;
                return Promise.resolve();
            }
            return self.store.createSession(entry.manifest).then(function () {
                if (typeof entry.raw === 'string' && entry.raw.length > 0) {
                    return util.pWriteFile(self.store.rawPath(entry.manifest.id), entry.raw);
                }
            }).then(function () { imported += 1; }, function () { failed += 1; });
        };
    })).then(function () {
        restutil.ok(self, restOperation, { imported: imported, failed: failed });
    }).catch(function (err) { restutil.fail(self, restOperation, err); });
};

SessionWorker.prototype.onDelete = function (restOperation) {
    var self = this;
    var seg = restutil.segments(restOperation);
    if (seg.length === 0) { return restutil.fail(this, restOperation, new Error('session id required')); }
    this.store.deleteSession(seg[0])
        .then(function () { restutil.ok(self, restOperation, { deleted: seg[0] }); })
        .catch(function (err) { restutil.fail(self, restOperation, err); });
};

module.exports = SessionWorker;
