'use strict';

// GET-only worker enumerating what the Setup view needs: virtual servers and
// their attached iRules, the events a given rule handles, available log
// publishers (flagging which route to local-syslog), and the occurrence types.
// ES5 syntax only.

var iremote = require('./iremote');
var restutil = require('./restutil');
var validate = require('./validate');
var logger = require('./logger');
var cpustats = require('./cpustats');

function fullName(obj) {
    if (obj.fullPath) { return obj.fullPath; }
    if (obj.partition && obj.name) { return '/' + obj.partition + '/' + obj.name; }
    return obj.name;
}

function InventoryWorker() {
    this.WORKER_URI_PATH = 'shared/rultracer/inventory';
    this.isPublic = true;
    this.isPassThrough = true; // sub-paths (/events, /rule) must reach onGet
}

InventoryWorker.prototype.onStart = function (success) { success(); };

InventoryWorker.prototype.onGet = function (restOperation) {
    var seg = restutil.segments(restOperation);
    var q = restutil.query(restOperation);
    if (seg.length >= 1 && (seg[0] === 'events' || seg[0] === 'rule')) {
        this._rule(restOperation, q.rule);
        return;
    }
    if (seg.length >= 1 && seg[0] === 'cpu') {
        this._cpu(restOperation);
        return;
    }
    if (seg.length >= 1 && seg[0] === 'rule-stats') {
        this._ruleStats(restOperation, q.rule);
        return;
    }
    this._summary(restOperation);
};

// GET /inventory/cpu -> { cpuHz, cores, mhz } from /proc/cpuinfo (Phase 4).
InventoryWorker.prototype._cpu = function (restOperation) {
    var self = this;
    cpustats.cpuInfo().then(function (info) {
        restutil.ok(self, restOperation, info);
    }).catch(function (err) {
        logger.error('cpu info failed:', err);
        restutil.fail(self, restOperation, err);
    });
};

// GET /inventory/rule-stats?rule=/Common/foo -> per-event cycle stats (Phase 4).
InventoryWorker.prototype._ruleStats = function (restOperation, ruleName) {
    var self = this;
    if (!ruleName) { return restutil.fail(this, restOperation, new Error('rule query parameter required')); }
    try { validate.assertName(ruleName, 'rule'); }
    catch (e) { return restutil.fail(this, restOperation, e); }
    cpustats.ruleStats(ruleName).then(function (rs) {
        restutil.ok(self, restOperation, rs);
    }).catch(function (err) {
        restutil.fail(self, restOperation, err);
    });
};

InventoryWorker.prototype._summary = function (restOperation) {
    var self = this;
    Promise.all([
        iremote.getItems('/mgmt/tm/ltm/virtual?$select=name,partition,fullPath,rules'),
        iremote.getItems('/mgmt/tm/sys/log-config/publisher'),
        iremote.getItems('/mgmt/tm/sys/log-config/destination/local-syslog')
    ]).then(function (res) {
        var virtuals = res[0].map(function (v) {
            return { name: fullName(v), rules: v.rules || [] };
        });
        var localSet = {};
        res[2].forEach(function (d) { localSet[d.name] = true; });
        var publishers = res[1].map(function (p) {
            var dests = Array.isArray(p.destinations)
                ? p.destinations.map(function (d) { return d.name; }) : [];
            return {
                name: fullName(p),
                destinations: dests,
                routesToLocalSyslog: dests.some(function (n) { return !!localSet[n]; })
            };
        });
        restutil.ok(self, restOperation, {
            virtuals: virtuals,
            publishers: publishers,
            occTypes: validate.OCC_TYPES
        });
    }).catch(function (err) {
        logger.error('inventory summary failed:', err);
        restutil.fail(self, restOperation, err);
    });
};

InventoryWorker.prototype._rule = function (restOperation, ruleName) {
    var self = this;
    if (!ruleName) { return restutil.fail(this, restOperation, new Error('rule query parameter required')); }
    try { validate.assertName(ruleName, 'rule'); }
    catch (e) { return restutil.fail(this, restOperation, e); }
    var enc = '~' + ruleName.replace(/^\//, '').replace(/\//g, '~');
    iremote.get('/mgmt/tm/ltm/rule/' + enc).then(function (rule) {
        var body = rule.apiAnonymous || '';
        var events = [];
        // Match real handler heads only: `when <EVENT_NAME> {` (possibly with
        // newlines/whitespace before the brace). Skips string literals or
        // comments that happen to contain "when SOMETHING".
        var re = /when\s+([A-Z][A-Z0-9_]*)\s*\{/g;
        var m;
        while ((m = re.exec(body))) {
            if (events.indexOf(m[1]) === -1) { events.push(m[1]); }
        }
        restutil.ok(self, restOperation, { name: ruleName, events: events, definition: body });
    }).catch(function (err) {
        restutil.fail(self, restOperation, err);
    });
};

module.exports = InventoryWorker;
