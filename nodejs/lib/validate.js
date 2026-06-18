'use strict';

// Validation for any value that gets concatenated into a tmsh command string.
// Because the worker execs `tmsh -c "<cmd>"` directly (no shell), the only real
// risk is a name containing tmsh metacharacters (braces, quotes, whitespace,
// newlines) that would break the command or smuggle extra tmsh syntax.
// ES5 syntax only.

// tmsh object names (incl. /partition/name paths): word chars plus / . - _ :
var NAME_RE = /^[A-Za-z0-9_.\-\/:]+$/;
// iRule event names: HTTP_REQUEST, CLIENT_ACCEPTED, etc.
var EVENT_RE = /^[A-Z][A-Z0-9_]*$/;
// allowed rule-profiler occurrence types
var OCC_TYPES = ['event', 'rule', 'rule-vm', 'cmd-vm', 'cmd', 'var-mod', 'bytecode'];
// Session ids become a single filesystem path component (<dataDir>/sessions/<id>/),
// so they must contain no separators and no dots (which blocks `..` traversal).
// store.genId() emits "<ms>-<hex4>"; this charset covers that. NOTE: do NOT reuse
// isValidName here — NAME_RE allows '/' and '.' for tmsh partition paths, which
// would let "../../x" through.
var SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

function isValidName(s) {
    return typeof s === 'string' && s.length > 0 && s.length <= 255 && NAME_RE.test(s);
}

function assertName(s, what) {
    if (!isValidName(s)) {
        throw new Error('invalid ' + (what || 'name') + ': ' + JSON.stringify(s));
    }
    return s;
}

function isValidEvent(s) {
    return typeof s === 'string' && s.length <= 64 && EVENT_RE.test(s);
}

function assertEvent(s) {
    if (!isValidEvent(s)) {
        throw new Error('invalid iRule event name: ' + JSON.stringify(s));
    }
    return s;
}

function isValidSessionId(s) {
    return typeof s === 'string' && s.length > 0 && s.length <= 128 && SESSION_ID_RE.test(s);
}

function assertSessionId(s) {
    if (!isValidSessionId(s)) {
        throw new Error('invalid session id: ' + JSON.stringify(s));
    }
    return s;
}

function isValidOcc(s) {
    return OCC_TYPES.indexOf(s) !== -1;
}

function assertOccMask(list) {
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error('occ-mask must be a non-empty list of occurrence types');
    }
    list.forEach(function (o) {
        if (!isValidOcc(o)) { throw new Error('invalid occurrence type: ' + JSON.stringify(o)); }
    });
    return list;
}

// Coerce a period (ms) to a non-negative integer, clamped to an optional max.
function normalizePeriod(value, maxMs) {
    var n = parseInt(value, 10);
    if (isNaN(n) || n < 0) { return null; }
    if (maxMs && n > maxMs) { return maxMs; }
    return n;
}

module.exports = {
    OCC_TYPES: OCC_TYPES,
    isValidName: isValidName,
    assertName: assertName,
    isValidSessionId: isValidSessionId,
    assertSessionId: assertSessionId,
    isValidEvent: isValidEvent,
    assertEvent: assertEvent,
    isValidOcc: isValidOcc,
    assertOccMask: assertOccMask,
    normalizePeriod: normalizePeriod
};
