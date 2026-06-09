'use strict';

// Thin wrapper over f5-logger with a console fallback so the modules are
// testable outside restnoded. ES5 syntax only.

var f5logger = null;
try {
    f5logger = require('f5-logger').getInstance();
} catch (e) {
    f5logger = null;
}

var PREFIX = '[rultracer] ';

function format(args) {
    var parts = Array.prototype.map.call(args, function (a) {
        if (typeof a === 'string') { return a; }
        if (a instanceof Error) { return a.stack || a.message; }
        try { return JSON.stringify(a); } catch (e) { return String(a); }
    });
    return PREFIX + parts.join(' ');
}

function emit(f5method, consoleMethod, args) {
    var msg = format(args);
    if (f5logger && typeof f5logger[f5method] === 'function') {
        f5logger[f5method](msg);
    } else {
        (console[consoleMethod] || console.log)(msg);
    }
}

module.exports = {
    info: function () { emit('info', 'log', arguments); },
    warning: function () { emit('warning', 'warn', arguments); },
    error: function () { emit('severe', 'error', arguments); },
    fine: function () { emit('fine', 'log', arguments); }
};
