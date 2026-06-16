'use strict';

// CaptureEngine: the rule-profiler capture state machine. Owns a single-capture
// lock and orchestrates publisher setup, profiler create/start/stop, buffered
// flush detection, RP_ line extraction, session persistence, guaranteed
// teardown, and retention. ES5 syntax + Promises (Node 6.9.1).
//
// States: idle -> configuring -> capturing -> stopping -> flushing -> finalized
//         (any state -> error -> teardown)

var capture = require('./capture');
var profiler = require('./profiler');
var logchain = require('./logchain');
var validate = require('./validate');
var logger = require('./logger');

function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

function CaptureEngine(store, options) {
    options = options || {};
    this.store = store;
    this.flush = options.flush || { pollMs: 250, stable: 3, timeoutMs: 8000 };
    this.safetyMaxMs = options.safetyMaxMs || 300000; // hard ceiling on a capture
    this.retention = options.retention || { maxSessions: 20, maxBytes: 524288000 };
    this.maxPeriodMs = options.maxPeriodMs || 600000;
    this._reset();
}

CaptureEngine.prototype._reset = function () {
    this.state = 'idle';
    this.sessionId = null;
    this.profilerName = null;
    this.startOffset = 0;
    this.publisher = null;
    this.config = null;
    this.error = null;
    this._clearTimers();
};

CaptureEngine.prototype._clearTimers = function () {
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
    if (this._safetyTimer) { clearTimeout(this._safetyTimer); this._safetyTimer = null; }
};

CaptureEngine.prototype.status = function () {
    return {
        state: this.state,
        sessionId: this.sessionId,
        profilerName: this.profilerName,
        vs: this.config ? this.config.vs : null,
        error: this.error
    };
};

CaptureEngine.prototype._busy = function () {
    return this.state === 'configuring' || this.state === 'capturing' ||
           this.state === 'stopping' || this.state === 'flushing';
};

// Begin a capture. cfg: { vs, rules[], events[], occMask[], periodMs,
// stopMode('manual'|'period'), publisherMode('auto'|'reuse'|'create'), name }
CaptureEngine.prototype.start = function (cfg) {
    var self = this;
    if (this._busy()) {
        return Promise.reject(new Error('a capture is already in progress (state=' + this.state + ')'));
    }
    try {
        if (!cfg || !cfg.vs) { throw new Error('vs is required'); }
        validate.assertName(cfg.vs, 'vs');
        validate.assertOccMask(cfg.occMask);
        (cfg.events || []).forEach(function (e) { validate.assertEvent(e); });
        (cfg.rules || []).forEach(function (r) { validate.assertName(r, 'rule'); });
    } catch (e) {
        return Promise.reject(e);
    }

    var periodMs = validate.normalizePeriod(cfg.periodMs != null ? cfg.periodMs : 10, this.maxPeriodMs);
    if (periodMs === null) { return Promise.reject(new Error('invalid period')); }
    var stopMode = (cfg.stopMode === 'period') ? 'period' : 'manual';
    var publisherMode = cfg.publisherMode || 'auto';
    if (cfg.publisherName) {
        try { validate.assertName(cfg.publisherName, 'publisher'); }
        catch (e) { return Promise.reject(e); }
    }

    this._reset();
    this.state = 'configuring';
    this.config = {
        vs: cfg.vs, rules: cfg.rules || [], events: cfg.events || [],
        occMask: cfg.occMask, periodMs: periodMs, stopMode: stopMode
    };

    return logchain.ensurePublisher(publisherMode, cfg.publisherName).then(function (pub) {
        self.publisher = pub;
        // Phase 4.1: when the cycles phase already created the session shell up
        // front, ATTACH to it (so the pre-profiler snapshot persisted into the
        // same manifest) instead of creating a second session.
        if (cfg.sessionId) {
            return self.store.updateManifest(cfg.sessionId, {
                status: 'configuring',
                config: self.config,
                publisher: pub
            });
        }
        return self.store.createSession({
            name: cfg.name || ('capture ' + new Date().toISOString()),
            status: 'configuring',
            config: self.config,
            publisher: pub
        });
    }).then(function (m) {
        self.sessionId = m.id;
        self.profilerName = profiler.profilerName(m.id);
        // create with only filters + publisher (verified hand-test pattern):
        return profiler.create({
            name: self.profilerName, vs: self.config.vs, rules: self.config.rules,
            events: self.config.events, publisher: self.publisher.name
        });
    }).then(function () {
        return profiler.setOccMask(self.profilerName, self.config.occMask);
    }).then(function () {
        return profiler.setPeriod(self.profilerName, periodMs);
    }).then(function () {
        return capture.currentSize();
    }).then(function (size) {
        self.startOffset = size;
        return profiler.setState(self.profilerName, 'enabled');
    }).then(function () {
        return profiler.start(self.profilerName);
    }).then(function () {
        self.state = 'capturing';
        return self.store.updateManifest(self.sessionId, {
            status: 'capturing',
            profilerName: self.profilerName,
            publisher: self.publisher,
            capture: { startOffset: self.startOffset, startWallclock: new Date().toISOString() }
        });
    }).then(function () {
        if (stopMode === 'period' && periodMs > 0) {
            self._autoTimer = setTimeout(function () { self.stop().then(noop, noop); }, periodMs + 250);
        }
        self._safetyTimer = setTimeout(function () {
            if (self.state === 'capturing') { self.stop().then(noop, noop); }
        }, self.safetyMaxMs);
        return { sessionId: self.sessionId, state: self.state, profilerName: self.profilerName };
    }).catch(function (err) {
        self.error = err.message;
        self.state = 'error';
        if (self.sessionId) { self.store.updateManifest(self.sessionId, { status: 'error', error: err.message }).then(noop, noop); }
        return self._teardown().then(function () { throw err; }, function () { throw err; });
    });
};

// Stop the active capture, flush, extract, persist, tear down, prune.
CaptureEngine.prototype.stop = function () {
    var self = this;
    if (this.state !== 'capturing') {
        return Promise.reject(new Error('no capture in progress (state=' + this.state + ')'));
    }
    this._clearTimers();
    this.state = 'stopping';
    var result = {};
    return profiler.stop(self.profilerName).then(function () {
        return profiler.setState(self.profilerName, 'disabled');
    }).then(function () {
        self.state = 'flushing';
        return self._waitForFlush();
    }).then(function (flush) {
        result.flush = flush;
        return capture.readFrom(capture.LTM_LOG, self.startOffset);
    }).then(function (read) {
        result.endOffset = read.endOffset;
        result.rotated = read.rotated;
        var ex = capture.extract(read.text, { vs: self.config.vs });
        result.stats = ex.stats;
        result.lineCount = ex.lines.length;
        return self.store.writeRaw(self.sessionId, ex.lines);
    }).then(function () {
        return self._teardown();
    }).then(function (teardown) {
        return self.store.updateManifest(self.sessionId, {
            status: 'finalized',
            finalizedAt: new Date().toISOString(),
            capture: {
                startOffset: self.startOffset, endOffset: result.endOffset,
                rotated: result.rotated, lineCount: result.lineCount,
                stats: result.stats, flush: result.flush
            },
            teardown: teardown
        });
    }).then(function (manifest) {
        return self.store.enforceRetention(self.retention.maxSessions, self.retention.maxBytes)
            .then(function (pruned) { manifest.pruned = pruned; return manifest; }, function () { return manifest; });
    }).then(function (manifest) {
        self.state = 'finalized';
        return { sessionId: self.sessionId, state: self.state, manifest: manifest };
    }).catch(function (err) {
        self.error = err.message;
        self.state = 'error';
        if (self.sessionId) { self.store.updateManifest(self.sessionId, { status: 'error', error: err.message }).then(noop, noop); }
        return self._teardown().then(function () { throw err; }, function () { throw err; });
    });
};

// Poll the log size until it is stable across N polls (flush complete) or the
// timeout elapses. Resolves { size, stable, timedOut }.
CaptureEngine.prototype._waitForFlush = function () {
    var self = this;
    var pollMs = self.flush.pollMs;
    var need = self.flush.stable;
    var deadline = Date.now() + self.flush.timeoutMs;
    var last = -1;
    var stable = 0;
    function tick() {
        return capture.currentSize().then(function (size) {
            if (size === last) { stable += 1; } else { stable = 0; last = size; }
            if (stable >= need) { return { size: size, stable: true, timedOut: false }; }
            if (Date.now() >= deadline) { return { size: size, stable: false, timedOut: true }; }
            return delay(pollMs).then(tick);
        });
    }
    return tick();
};

// Delete our profiler object and any publisher we created. Never rejects.
CaptureEngine.prototype._teardown = function () {
    var self = this;
    var info = { profilerDeleted: false, publisherTornDown: false, publisherSkipped: false };
    var p = Promise.resolve();
    if (self.profilerName) {
        p = p.then(function () { return profiler.destroy(self.profilerName); })
             .then(function (r) { info.profilerDeleted = !!(r && r.ok); });
    }
    return p.then(function () {
        return logchain.teardownPublisher(self.publisher);
    }).then(function (r) {
        info.publisherTornDown = !!(r && r.ok && !r.skipped);
        info.publisherSkipped = !!(r && r.skipped);
        return info;
    }, function () { return info; });
};

// Public idempotent teardown (used on abort / explicit request).
CaptureEngine.prototype.teardown = function () {
    var self = this;
    this._clearTimers();
    return this._teardown().then(function (info) { self._reset(); return info; });
};

function noop() {}

module.exports = CaptureEngine;
