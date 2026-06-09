'use strict';

// Hybrid log-publisher management (capture path A). Three modes:
//   auto  : reuse any publisher that routes to local-syslog; else create rultracer_pub
//   reuse : caller picks a specific publisher by name; verify it routes to local-syslog
//   create: ensure rultracer_pub exists -- idempotent; reuse if it already does
//
// Teardown removes only a publisher this run created (`created: true`). A
// rultracer_pub left over from a previous run is treated as not-ours and is
// preserved (delete it manually with `tmsh delete sys log-config publisher
// rultracer_pub` if you want a clean slate). ES5 syntax.

var iremote = require('./iremote');
var tmsh = require('./tmsh');
var validate = require('./validate');

var DEFAULT_PUB = 'rultracer_pub';
var LOCAL_SYSLOG_DEST = 'local-syslog';

function listLocalSyslogDestNames() {
    return iremote.getItems('/mgmt/tm/sys/log-config/destination/local-syslog').then(function (items) {
        return items.map(function (d) { return d.name; });
    });
}
function listPublishers() {
    return iremote.getItems('/mgmt/tm/sys/log-config/publisher');
}
function publisherDestNames(pub) {
    if (Array.isArray(pub.destinations)) {
        return pub.destinations.map(function (d) { return d.name; });
    }
    return [];
}

// Match either bare name or fully-qualified /partition/name.
function pubMatches(pub, name) {
    if (!name) { return false; }
    if (pub.name === name) { return true; }
    if (pub.fullPath && pub.fullPath === name) { return true; }
    var partition = pub.partition || 'Common';
    return ('/' + partition + '/' + pub.name) === name;
}

// Find an existing publisher that references a local-syslog destination.
// Resolves the publisher name or null.
function detectPublisher() {
    return Promise.all([listLocalSyslogDestNames(), listPublishers()]).then(function (res) {
        var localSet = {};
        res[0].forEach(function (n) { localSet[n] = true; });
        var pubs = res[1];
        for (var i = 0; i < pubs.length; i++) {
            var names = publisherDestNames(pubs[i]);
            for (var j = 0; j < names.length; j++) {
                if (localSet[names[j]]) { return pubs[i].name; }
            }
        }
        return null;
    });
}

function createDefault() {
    var cmd = 'create sys log-config publisher ' + DEFAULT_PUB +
              ' { destinations add { ' + LOCAL_SYSLOG_DEST + ' } }';
    return tmsh.run(cmd).then(function () { return { name: DEFAULT_PUB, created: true }; });
}

// Ensure a usable publisher exists. Resolves { name, created }.
function ensurePublisher(mode, requestedName) {
    mode = mode || 'auto';
    return Promise.all([listLocalSyslogDestNames(), listPublishers()]).then(function (res) {
        var localSet = {};
        res[0].forEach(function (n) { localSet[n] = true; });
        var pubs = res[1];

        function routesLocal(p) {
            return publisherDestNames(p).some(function (n) { return !!localSet[n]; });
        }

        var localPubs = pubs.filter(routesLocal);
        var defaultPub = null;
        for (var i = 0; i < pubs.length; i++) {
            if (pubMatches(pubs[i], DEFAULT_PUB)) { defaultPub = pubs[i]; break; }
        }

        if (mode === 'reuse') {
            if (!requestedName) {
                throw new Error('reuse mode requires a publisher selection');
            }
            var picked = null;
            for (var k = 0; k < localPubs.length; k++) {
                if (pubMatches(localPubs[k], requestedName)) { picked = localPubs[k]; break; }
            }
            if (!picked) {
                throw new Error('publisher not found or does not route to local-syslog: ' + requestedName);
            }
            return { name: picked.name, created: false };
        }

        if (mode === 'create') {
            if (defaultPub) { return { name: DEFAULT_PUB, created: false }; } // idempotent
            return createDefault();
        }

        // mode === 'auto'
        if (localPubs.length) {
            // Prefer rultracer_pub if it is already in the list of local-syslog publishers.
            var prefer = null;
            for (var m = 0; m < localPubs.length; m++) {
                if (pubMatches(localPubs[m], DEFAULT_PUB)) { prefer = localPubs[m]; break; }
            }
            if (!prefer) { prefer = localPubs[0]; }
            return { name: prefer.name, created: false };
        }
        return createDefault();
    });
}

// Remove a publisher only if we created it. Never rejects.
function teardownPublisher(record) {
    if (!record || !record.created || !record.name) {
        return Promise.resolve({ ok: true, skipped: true });
    }
    try { validate.assertName(record.name, 'publisher'); }
    catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
    return tmsh.runSafe('delete sys log-config publisher ' + record.name);
}

module.exports = {
    DEFAULT_PUB: DEFAULT_PUB,
    LOCAL_SYSLOG_DEST: LOCAL_SYSLOG_DEST,
    detectPublisher: detectPublisher,
    ensurePublisher: ensurePublisher,
    teardownPublisher: teardownPublisher
};
