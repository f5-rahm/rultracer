'use strict';

// Promised fs helpers + recursive mkdir/rm for Node 6.9.1 (no fs.promises, no
// fs.mkdir recursive option). ES5 syntax only.

var fs = require('fs');
var path = require('path');

// Decimal file modes (octal literals are avoided per restnoded ES5 gotchas).
var MODE_DIR = 493;   // 0755
var MODE_FILE = 420;  // 0644

function promisifyNodeback(fn, ctx) {
    return function () {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
            args.push(function (err, res) {
                if (err) { reject(err); } else { resolve(res); }
            });
            fn.apply(ctx, args);
        });
    };
}

var pReadFile = promisifyNodeback(fs.readFile, fs);
var pWriteFile = promisifyNodeback(fs.writeFile, fs);
var pReaddir = promisifyNodeback(fs.readdir, fs);
var pStat = promisifyNodeback(fs.stat, fs);
var pLstat = promisifyNodeback(fs.lstat, fs);
var pUnlink = promisifyNodeback(fs.unlink, fs);
var pMkdir = promisifyNodeback(fs.mkdir, fs);
var pRmdir = promisifyNodeback(fs.rmdir, fs);

// Resolve to file contents (utf8) or null if the file does not exist.
function readFileOrNull(file) {
    return pReadFile(file, 'utf8').then(
        function (data) { return data; },
        function (err) { if (err.code === 'ENOENT') { return null; } throw err; }
    );
}

// Recursive mkdir (mkdir -p). Resolves with the directory path.
function mkdirp(dir, mode) {
    if (mode === undefined || mode === null) { mode = MODE_DIR; }
    dir = path.resolve(dir);
    return pMkdir(dir, mode).then(
        function () { return dir; },
        function (err) {
            if (err.code === 'EEXIST') { return dir; }
            if (err.code === 'ENOENT') {
                return mkdirp(path.dirname(dir), mode).then(function () {
                    return pMkdir(dir, mode).then(
                        function () { return dir; },
                        function (e) { if (e.code === 'EEXIST') { return dir; } throw e; }
                    );
                });
            }
            throw err;
        }
    );
}

// Recursive delete (rm -rf). Tolerates a missing target.
function rimraf(target) {
    return pLstat(target).then(
        function (st) {
            if (st.isDirectory()) {
                return pReaddir(target).then(function (entries) {
                    return entries.reduce(function (p, name) {
                        return p.then(function () { return rimraf(path.join(target, name)); });
                    }, Promise.resolve());
                }).then(function () { return pRmdir(target); });
            }
            return pUnlink(target);
        },
        function (err) { if (err.code === 'ENOENT') { return; } throw err; }
    );
}

// Run an array of thunks (functions returning Promises) one after another.
function serial(thunks) {
    return thunks.reduce(function (p, thunk) {
        return p.then(function (acc) {
            return thunk().then(function (res) { acc.push(res); return acc; });
        });
    }, Promise.resolve([]));
}

module.exports = {
    MODE_DIR: MODE_DIR,
    MODE_FILE: MODE_FILE,
    promisifyNodeback: promisifyNodeback,
    pReadFile: pReadFile,
    pWriteFile: pWriteFile,
    pReaddir: pReaddir,
    pStat: pStat,
    pLstat: pLstat,
    pUnlink: pUnlink,
    readFileOrNull: readFileOrNull,
    mkdirp: mkdirp,
    rimraf: rimraf,
    serial: serial
};
