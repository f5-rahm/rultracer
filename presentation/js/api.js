// API client for the rultracer workers. Plain browser JS (no build step).
// Exposes window.API.
(function () {
  'use strict';

  var BASE = '/mgmt/shared/rultracer';

  function handle(promise) {
    return promise.then(function (r) {
      return r.json().catch(function () {
        throw new Error('non-JSON response (HTTP ' + r.status + ')');
      });
    }).then(function (body) {
      if (body && body.ok === false) { throw new Error(body.error || 'request failed'); }
      return body;
    });
  }

  function get(path) {
    return handle(fetch(BASE + path, { credentials: 'include' }));
  }
  function post(path, body) {
    return handle(fetch(BASE + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }));
  }
  function del(path) {
    return handle(fetch(BASE + path, { method: 'DELETE', credentials: 'include' }));
  }

  window.API = {
    inventory: function () { return get('/inventory'); },
    ruleEvents: function (ruleName) { return get('/inventory/events?rule=' + encodeURIComponent(ruleName)); },
    profilerStatus: function () { return get('/profiler'); },
    startCapture: function (config) { return post('/profiler', { action: 'start', config: config }); },
    stopCapture: function () { return post('/profiler', { action: 'stop' }); },
    teardown: function () { return post('/profiler', { action: 'teardown' }); },
    sendTraffic: function (opts) { return post('/traffic', opts); },
    listSessions: function () { return get('/sessions'); },
    getSession: function (id) { return get('/sessions/' + encodeURIComponent(id)); },
    getRaw: function (id) { return get('/sessions/' + encodeURIComponent(id) + '/raw'); },
    deleteSession: function (id) { return del('/sessions/' + encodeURIComponent(id)); },
    exportSessions: function () { return get('/sessions/export'); },
    importSessions: function (bundle) { return post('/sessions/import', bundle); }
  };
})();
