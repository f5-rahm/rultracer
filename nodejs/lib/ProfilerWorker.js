'use strict';

// Drives the capture state machine. POST { action: 'start'|'stop'|'teardown',
// config } and GET for status. On startup it sweeps any orphaned rultracer_*
// profiler objects so a prior crash never leaves tracing enabled. ES5 syntax.

var Store = require('./store');
var settings = require('./settings');
var profiler = require('./profiler');
var CaptureEngine = require('./engine');
var restutil = require('./restutil');
var logger = require('./logger');

function ProfilerWorker() {}
ProfilerWorker.prototype.WORKER_URI_PATH = 'shared/rultracer/profiler';
ProfilerWorker.prototype.isPublic = true;

ProfilerWorker.prototype.onStart = function (success) {
    var self = this;
    var dir = restutil.dataDir();
    this.store = new Store(dir);
    this.store.init().then(function () {
        return settings.load(dir);
    }).then(function (cfg) {
        self.engine = new CaptureEngine(self.store, {
            retention: { maxSessions: cfg.retentionMaxSessions, maxBytes: cfg.retentionMaxBytes },
            maxPeriodMs: cfg.maxPeriodMs
        });
        return profiler.sweepOrphans();
    }).then(function (removed) {
        if (removed && removed.length) { logger.warning('swept orphaned profilers:', removed); }
        success();
    }).catch(function (err) {
        logger.error('onStart partial failure:', err);
        if (!self.engine) { self.engine = new CaptureEngine(self.store, {}); }
        success();
    });
};

ProfilerWorker.prototype.onGet = function (restOperation) {
    var status = this.engine ? this.engine.status() : { state: 'unknown' };
    restutil.ok(this, restOperation, { status: status });
};

ProfilerWorker.prototype.onPost = function (restOperation) {
    var self = this;
    var body = restOperation.getBody() || {};
    if (!this.engine) { return restutil.fail(this, restOperation, new Error('engine not ready')); }

    if (body.action === 'start') {
        this.engine.start(body.config || {})
            .then(function (res) { restutil.ok(self, restOperation, res); })
            .catch(function (err) { restutil.fail(self, restOperation, err); });
    } else if (body.action === 'stop') {
        this.engine.stop()
            .then(function (res) { restutil.ok(self, restOperation, res); })
            .catch(function (err) { restutil.fail(self, restOperation, err); });
    } else if (body.action === 'teardown') {
        this.engine.teardown()
            .then(function (info) { restutil.ok(self, restOperation, { teardown: info }); })
            .catch(function (err) { restutil.fail(self, restOperation, err); });
    } else {
        restutil.fail(this, restOperation, new Error('unknown action: ' + body.action));
    }
};

module.exports = ProfilerWorker;
