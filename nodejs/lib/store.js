'use strict';

// Filesystem session store under <dataDir>/sessions/<id>/ with manifest.json +
// raw.csv, and retention pruning by session count and total bytes. ES5 syntax.

var path = require('path');
var util = require('./util');

function Store(dataDir) {
    this.dataDir = dataDir;
    this.sessionsDir = path.join(dataDir, 'sessions');
}

function genId() {
    var rand = Math.floor(Math.random() * 0x10000).toString(16);
    while (rand.length < 4) { rand = '0' + rand; }
    // String(Date.now()) sorts chronologically as a fixed-width millisecond value.
    return String(Date.now()) + '-' + rand;
}

Store.prototype.init = function () {
    return util.mkdirp(this.sessionsDir);
};

Store.prototype._dir = function (id) { return path.join(this.sessionsDir, id); };
Store.prototype.rawPath = function (id) { return path.join(this._dir(id), 'raw.csv'); };
Store.prototype.manifestPath = function (id) { return path.join(this._dir(id), 'manifest.json'); };

Store.prototype.createSession = function (manifest) {
    var self = this;
    manifest = manifest || {};
    manifest.id = manifest.id || genId();
    if (!manifest.createdAt) { manifest.createdAt = new Date().toISOString(); }
    return util.mkdirp(this._dir(manifest.id)).then(function () {
        return self.writeManifest(manifest.id, manifest);
    }).then(function () { return manifest; });
};

Store.prototype.writeManifest = function (id, manifest) {
    return util.pWriteFile(this.manifestPath(id), JSON.stringify(manifest, null, 2));
};

Store.prototype.updateManifest = function (id, patch) {
    var self = this;
    return this.getManifest(id).then(function (m) {
        if (!m) { throw new Error('no such session: ' + id); }
        var merged = Object.assign({}, m, patch);
        return self.writeManifest(id, merged).then(function () { return merged; });
    });
};

Store.prototype.writeRaw = function (id, csvLines) {
    var text = (csvLines && csvLines.length) ? csvLines.join('\n') + '\n' : '';
    return util.pWriteFile(this.rawPath(id), text);
};

Store.prototype.getManifest = function (id) {
    return util.readFileOrNull(this.manifestPath(id)).then(function (txt) {
        if (txt === null) { return null; }
        try { return JSON.parse(txt); } catch (e) { return null; }
    });
};

// All session manifests, newest first.
Store.prototype.listSessions = function () {
    var self = this;
    return util.pReaddir(this.sessionsDir).then(
        function (names) {
            return util.serial(names.map(function (name) {
                return function () { return self.getManifest(name); };
            }));
        },
        function (err) { if (err.code === 'ENOENT') { return []; } throw err; }
    ).then(function (manifests) {
        return manifests.filter(Boolean).sort(function (a, b) {
            if (a.createdAt < b.createdAt) { return 1; }
            if (a.createdAt > b.createdAt) { return -1; }
            return 0;
        });
    });
};

Store.prototype.deleteSession = function (id) {
    return util.rimraf(this._dir(id));
};

Store.prototype._sessionBytes = function (id) {
    var dir = this._dir(id);
    return util.pReaddir(dir).then(function (names) {
        return util.serial(names.map(function (n) {
            return function () {
                return util.pStat(path.join(dir, n)).then(
                    function (st) { return st.size; },
                    function () { return 0; }
                );
            };
        })).then(function (sizes) {
            return sizes.reduce(function (a, b) { return a + b; }, 0);
        });
    }, function () { return 0; });
};

// Prune oldest sessions until within both caps. Resolves the pruned id list.
Store.prototype.enforceRetention = function (maxSessions, maxBytes) {
    var self = this;
    return this.listSessions().then(function (manifests) {
        return util.serial(manifests.map(function (m) {
            return function () {
                return self._sessionBytes(m.id).then(function (b) { return { id: m.id, bytes: b }; });
            };
        }));
    }).then(function (sized) {
        // sized is newest-first; prune from the oldest end.
        var oldestFirst = sized.slice().reverse();
        var total = sized.reduce(function (a, s) { return a + s.bytes; }, 0);
        var keptCount = sized.length;
        var pruned = [];
        var idx = 0;
        function step() {
            var overCount = maxSessions && keptCount > maxSessions;
            var overBytes = maxBytes && total > maxBytes;
            if ((!overCount && !overBytes) || idx >= oldestFirst.length) {
                return Promise.resolve(pruned);
            }
            var victim = oldestFirst[idx++];
            return self.deleteSession(victim.id).then(function () {
                keptCount -= 1;
                total -= victim.bytes;
                pruned.push(victim.id);
                return step();
            });
        }
        return step();
    });
};

module.exports = Store;
module.exports.genId = genId;
