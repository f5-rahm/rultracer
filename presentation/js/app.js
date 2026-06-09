// rultracer SPA controller. Plain browser JS (no build step).
(function () {
  'use strict';

  var PERIOD_PRESETS = [
    { label: '10 ms', v: 10 },
    { label: '1 s', v: 1000 },
    { label: '5 s', v: 5000 },
    { label: '30 s', v: 30000 }
  ];

  var state = {
    inventory: null,
    vsRules: {},        // vsName -> [ruleName]
    ruleEvents: {},     // ruleName -> [event]
    activeView: 'setup',
    currentVS: null,
    lastEngineState: null,  // last engine state seen by the status poll
    lastSessionId: null,    // sessionId of the most recent armed capture
    periodMs: 0,            // capture period (ms) from the last Start
    stopMode: 'manual',     // 'manual' | 'period'
    captureStartedAt: null  // wall-clock ms when engine entered 'capturing'
  };

  var METHODS_WITH_BODY = { POST: 1, PUT: 1, PATCH: 1 };
  var _timerHandle = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) {
      if (k === 'text') { n.textContent = attrs[k]; }
      else if (k === 'html') { n.innerHTML = attrs[k]; }
      else { n.setAttribute(k, attrs[k]); }
    }); }
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function checkedValues(container) {
    return Array.prototype.slice.call(container.querySelectorAll('input:checked'))
      .map(function (i) { return i.value; });
  }
  function msg(node, text, kind) {
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // ---- view switching -------------------------------------------------------
  function showView(name) {
    state.activeView = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.dataset.view === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
      v.hidden = v.dataset.view !== name;
    });
    if (name === 'sessions') { loadSessions(); }
  }

  // ---- setup ----------------------------------------------------------------
  function loadInventory() {
    return API.inventory().then(function (inv) {
      state.inventory = inv;
      var vs = $('vs');
      vs.innerHTML = '';
      vs.appendChild(el('option', { value: '', text: '-- choose a virtual server --' }));
      inv.virtuals.forEach(function (v) {
        state.vsRules[v.name] = v.rules || [];
        vs.appendChild(el('option', { value: v.name, text: v.name }));
      });
      renderOccMask(inv.occTypes || []);
      renderPublisherInfo(inv.publishers || []);
    }).catch(function (e) { msg($('setup-msg'), 'Inventory failed: ' + e.message, 'err'); });
  }

  function renderOccMask(types) {
    var box = $('occmask');
    box.innerHTML = '';
    types.forEach(function (t) {
      var cb = el('input', { type: 'checkbox', value: t });
      cb.addEventListener('change', updateBytecodeHint);
      box.appendChild(el('label', {}, [cb, document.createTextNode(' ' + t)]));
    });
  }
  function updateBytecodeHint() {
    var on = checkedValues($('occmask')).indexOf('bytecode') !== -1;
    $('bytecode-hint').textContent = on ? 'bytecode tracing is extremely high-volume.' : '';
  }

  function setAllOccMask(checked) {
    Array.prototype.forEach.call(
      $('occmask').querySelectorAll('input[type="checkbox"]'),
      function (cb) { cb.checked = checked; }
    );
    updateBytecodeHint();
  }

  function setAllEvents(checked) {
    Array.prototype.forEach.call(
      $('events').querySelectorAll('input[type="checkbox"]'),
      function (cb) { cb.checked = checked; }
    );
  }

  function renderPublisherInfo(pubs) {
    var routed = pubs.filter(function (p) { return p.routesToLocalSyslog; });
    state.routedPubs = routed;
    var sel = $('pub-select');
    sel.innerHTML = '';
    routed.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    syncPubModeUi();
  }

  function syncPubModeUi() {
    var mode = radioValue('pubMode');
    var routed = state.routedPubs || [];
    $('pub-select-field').hidden = (mode !== 'reuse');
    if (mode === 'reuse' && routed.length === 0) {
      msg($('setup-msg'), 'No publisher routes to local-syslog; select Use/create rultracer_pub.', 'err');
    } else {
      msg($('setup-msg'), '', '');
    }
  }

  function onVSChange() {
    var vs = $('vs').value;
    state.currentVS = vs;
    var rules = state.vsRules[vs] || [];
    var box = $('rules');
    box.innerHTML = '';
    rules.forEach(function (r) {
      var cb = el('input', { type: 'checkbox', value: r });
      cb.addEventListener('change', refreshEvents);
      box.appendChild(el('label', {}, [cb, document.createTextNode(' ' + r)]));
    });
    // fetch events for all rules on the VS up front
    Promise.all(rules.map(function (r) {
      if (state.ruleEvents[r]) { return Promise.resolve(); }
      return API.ruleEvents(r).then(function (res) { state.ruleEvents[r] = res.events || []; })
        .catch(function () { state.ruleEvents[r] = []; });
    })).then(refreshEvents);
  }

  function refreshEvents() {
    var selectedRules = checkedValues($('rules'));
    var box = $('events');
    var hint = $('events-hint');
    box.innerHTML = '';
    if (selectedRules.length === 0) {
      hint.textContent = 'Check at least one rule above to see its events.';
      return;
    }
    var set = {};
    selectedRules.forEach(function (r) {
      (state.ruleEvents[r] || []).forEach(function (ev) { set[ev] = true; });
    });
    var events = Object.keys(set).sort();
    if (events.length === 0) {
      hint.textContent = 'No "when <EVENT>" handlers parsed from the selected rule(s).';
      return;
    }
    hint.textContent = 'Leave all unchecked to trace every listed event.';
    events.forEach(function (ev) {
      box.appendChild(el('label', {}, [el('input', { type: 'checkbox', value: ev }), document.createTextNode(' ' + ev)]));
    });
  }

  function renderPeriodPresets() {
    var box = $('period-presets');
    PERIOD_PRESETS.forEach(function (p) {
      var b = el('button', { type: 'button', class: 'preset', text: p.label });
      b.addEventListener('click', function () {
        $('period').value = p.v;
        Array.prototype.forEach.call(box.children, function (c) { c.classList.remove('active'); });
        b.classList.add('active');
      });
      box.appendChild(b);
    });
  }

  function radioValue(name) {
    var r = document.querySelector('input[name="' + name + '"]:checked');
    return r ? r.value : null;
  }

  function startCapture() {
    var occMask = checkedValues($('occmask'));
    if (!state.currentVS) { return msg($('setup-msg'), 'Choose a virtual server.', 'err'); }
    if (occMask.length === 0) { return msg($('setup-msg'), 'Select at least one occurrence type.', 'err'); }
    var pubMode = radioValue('pubMode');
    var config = {
      vs: state.currentVS,
      rules: checkedValues($('rules')),
      events: checkedValues($('events')),
      occMask: occMask,
      periodMs: parseInt($('period').value, 10),
      stopMode: radioValue('stopMode'),
      publisherMode: pubMode,
      publisherName: (pubMode === 'reuse') ? $('pub-select').value : undefined,
      name: $('capname').value || undefined
    };
    state.periodMs = config.periodMs;
    state.stopMode = config.stopMode;
    if (pubMode === 'reuse' && !config.publisherName) {
      return msg($('setup-msg'), 'Pick a publisher from the dropdown for reuse mode.', 'err');
    }
    msg($('setup-msg'), 'Starting...', '');
    $('start-btn').disabled = true;
    API.startCapture(config).then(function (res) {
      $('start-btn').disabled = false;
      state.lastSessionId = res.sessionId;
      $('cap-session').textContent = res.sessionId;
      $('cap-vs').textContent = config.vs;
      msg($('setup-msg'), '', '');
      showView('capture');
      msg($('capture-msg'), 'Capture armed. Drive traffic, then Stop.', 'ok');
    }).catch(function (e) {
      $('start-btn').disabled = false;
      msg($('setup-msg'), 'Start failed: ' + e.message, 'err');
    });
  }

  // ---- capture --------------------------------------------------------------
  function sendTraffic() {
    var method = $('t-method').value;
    var opts = {
      host: $('t-host').value.trim(),
      port: parseInt($('t-port').value, 10),
      path: $('t-path').value || '/',
      method: method,
      hostHeader: $('t-hosthdr').value.trim() || undefined,
      count: parseInt($('t-count').value, 10) || 1,
      https: $('t-https').checked
    };
    if (METHODS_WITH_BODY[method]) {
      var bodyText = $('t-body').value;
      if (bodyText.length > 0) {
        opts.body = bodyText;
        opts.headers = { 'Content-Type': $('t-body-json').checked ? 'application/json' : 'text/plain' };
      }
    }
    if (!opts.host) { return msg($('capture-msg'), 'Enter the VIP address.', 'err'); }
    msg($('capture-msg'), 'Sending ' + opts.count + ' request(s)...', '');
    API.sendTraffic(opts).then(function (res) {
      var statuses = res.results.map(function (r) { return r.status || r.error; }).join(', ');
      msg($('capture-msg'), 'Sent ' + res.sent + ': [' + statuses + ']', 'ok');
    }).catch(function (e) { msg($('capture-msg'), 'Traffic failed: ' + e.message, 'err'); });
  }

  function syncTrafficFormVisibility() {
    $('traffic-form').hidden = !$('traffic-enable').checked;
  }

  function syncTrafficBodyField() {
    var method = $('t-method').value;
    $('t-body-field').hidden = !METHODS_WITH_BODY[method];
  }

  function stopCapture() {
    $('stop-btn').disabled = true;
    msg($('capture-msg'), 'Stopping and flushing...', '');
    API.stopCapture().then(function (res) {
      $('stop-btn').disabled = false;
      var lines = res.manifest && res.manifest.capture ? res.manifest.capture.lineCount : 0;
      msg($('capture-msg'), 'Finalized session ' + res.sessionId + ' with ' + lines + ' occurrence lines.', 'ok');
      showView('sessions');
    }).catch(function (e) {
      $('stop-btn').disabled = false;
      msg($('capture-msg'), 'Stop failed: ' + e.message, 'err');
    });
  }

  // ---- engine status poll ---------------------------------------------------
  function pollStatus() {
    API.profilerStatus().then(function (res) {
      var s = (res.status && res.status.state) || 'idle';
      var chip = $('engine-state');
      chip.textContent = s;
      chip.className = 'engine-state ' + s;
      if ($('cap-state')) { $('cap-state').textContent = s; }
      if (s !== state.lastEngineState) {
        onEngineStateChange(state.lastEngineState, s);
        state.lastEngineState = s;
      }
    }).catch(function () {});
  }

  // Reconcile Setup/Capture view messages + button state whenever the engine
  // state transitions. Handles auto-stop (period mode): the click handler
  // never runs, so messages must be driven from the poll.
  function onEngineStateChange(from, to) {
    if (to === 'capturing') {
      msg($('setup-msg'), '', '');
      msg($('capture-msg'), 'Capturing. Drive traffic, then Stop (or wait for auto-stop).', 'ok');
      $('start-btn').disabled = true;
      $('stop-btn').disabled = false;
      state.captureStartedAt = Date.now();
      startCaptureTimer();
    } else if (to === 'stopping' || to === 'flushing') {
      msg($('capture-msg'), 'Capture ' + to + '...', '');
      $('stop-btn').disabled = true;
      stopCaptureTimer();
    } else if (to === 'finalized') {
      msg($('setup-msg'), '', '');
      var sid = state.lastSessionId;
      var detail = sid ? ' (session ' + sid + ')' : '';
      $('capture-msg').innerHTML = 'Capture finalized' + detail +
        '. <span class="link" id="goto-sessions">View in Sessions</span>';
      $('capture-msg').className = 'msg ok';
      var goto = document.getElementById('goto-sessions');
      if (goto) { goto.addEventListener('click', function () { showView('sessions'); }); }
      $('start-btn').disabled = false;
      $('stop-btn').disabled = false;
    } else if (to === 'idle') {
      // Engine reset (teardown / fresh start). Wipe any stale messages so a
      // returning Setup user sees a clean slate.
      if (from && from !== 'idle') {
        msg($('setup-msg'), '', '');
        msg($('capture-msg'), '', '');
      }
      $('start-btn').disabled = false;
      $('stop-btn').disabled = false;
      stopCaptureTimer();
    } else if (to === 'error') {
      msg($('capture-msg'), 'Capture errored. See the session in the Sessions tab for details.', 'err');
      $('start-btn').disabled = false;
      $('stop-btn').disabled = false;
      stopCaptureTimer();
    }
    if (to === 'finalized') { stopCaptureTimer(); }
  }

  // ---- countdown / elapsed timer -------------------------------------------
  function startCaptureTimer() {
    if (_timerHandle) { clearInterval(_timerHandle); }
    _timerHandle = setInterval(tickCaptureTimer, 1000);
    tickCaptureTimer();
  }

  function stopCaptureTimer() {
    if (_timerHandle) { clearInterval(_timerHandle); _timerHandle = null; }
    state.captureStartedAt = null;
    $('cap-timer').textContent = '—';
    $('cap-timer-label').textContent = 'Timer:';
    $('cap-timer-cell').classList.remove('warn');
  }

  function tickCaptureTimer() {
    if (!state.captureStartedAt) { return; }
    var elapsed = Date.now() - state.captureStartedAt;
    if (state.stopMode === 'period' && state.periodMs > 0) {
      var remaining = Math.max(0, state.periodMs - elapsed);
      $('cap-timer-label').textContent = 'Auto-stop in:';
      $('cap-timer').textContent = formatDuration(remaining);
      $('cap-timer-cell').classList.toggle('warn', remaining <= 5000);
    } else {
      $('cap-timer-label').textContent = 'Elapsed:';
      $('cap-timer').textContent = formatDuration(elapsed);
    }
  }

  function formatDuration(ms) {
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---- sessions -------------------------------------------------------------
  function loadSessions() {
    var body = $('sessions-body');
    body.innerHTML = '';
    $('session-detail').hidden = true;
    API.listSessions().then(function (res) {
      (res.sessions || []).forEach(function (s) {
        var cap = s.capture || {};
        var tr = el('tr', { class: 'clickable' });
        tr.appendChild(el('td', { text: s.name || s.id }));
        tr.appendChild(el('td', { text: (s.createdAt || '').replace('T', ' ').replace(/\..*/, '') }));
        tr.appendChild(el('td', { text: (s.config && s.config.vs) || '' }));
        tr.appendChild(el('td', { html: '<span class="badge ' + (s.status || '') + '">' + (s.status || '') + '</span>' }));
        tr.appendChild(el('td', { text: String(cap.lineCount != null ? cap.lineCount : '') }));
        var actions = el('td');
        var del = el('span', { class: 'link', text: 'delete' });
        del.addEventListener('click', function (ev) { ev.stopPropagation(); deleteSession(s.id); });
        actions.appendChild(del);
        tr.appendChild(actions);
        tr.addEventListener('click', function () { showDetail(s.id); });
        body.appendChild(tr);
      });
      if (!res.sessions || !res.sessions.length) {
        body.appendChild(el('tr', {}, [el('td', { colspan: '6', text: 'No sessions yet.' })]));
      }
    }).catch(function (e) {
      body.appendChild(el('tr', {}, [el('td', { colspan: '6', text: 'Error: ' + e.message })]));
    });
  }

  function showDetail(id) {
    var d = $('session-detail');
    d.hidden = false;
    d.innerHTML = 'Loading...';
    API.getSession(id).then(function (res) {
      d.innerHTML = '';
      var raw = el('span', { class: 'link', text: 'view raw occurrences' });
      raw.addEventListener('click', function () { showRaw(id, d); });
      d.appendChild(el('h3', { text: res.session.name || id }));
      d.appendChild(raw);
      d.appendChild(el('pre', { text: JSON.stringify(res.session, null, 2) }));
    }).catch(function (e) { d.textContent = 'Error: ' + e.message; });
  }

  function showRaw(id, container) {
    API.getRaw(id).then(function (res) {
      var lines = (res.raw || '').split('\n').filter(Boolean);
      var preview = lines.slice(0, 60).join('\n');
      var pre = el('pre', { text: preview + (lines.length > 60 ? '\n... (' + lines.length + ' lines total)' : '') });
      container.appendChild(el('h3', { text: 'Raw occurrences (' + lines.length + ')' }));
      container.appendChild(pre);
    }).catch(function (e) { container.appendChild(el('div', { text: 'Raw error: ' + e.message })); });
  }

  function deleteSession(id) {
    if (!window.confirm('Delete session ' + id + '?')) { return; }
    API.deleteSession(id).then(loadSessions).catch(function (e) { window.alert(e.message); });
  }

  // ---- backup / restore ----------------------------------------------------
  function exportSessions() {
    msg($('sessions-msg'), 'Building backup...', '');
    API.exportSessions().then(function (bundle) {
      var json = JSON.stringify(bundle, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'rultracer-sessions-' + ts + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      msg($('sessions-msg'), 'Downloaded ' + bundle.sessionCount + ' session(s).', 'ok');
    }).catch(function (e) {
      msg($('sessions-msg'), 'Export failed: ' + e.message, 'err');
    });
  }

  function chooseImportFile() {
    $('import-file').value = '';
    $('import-file').click();
  }

  function onImportFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) { return; }
    var reader = new FileReader();
    reader.onload = function (ev) {
      var bundle;
      try { bundle = JSON.parse(ev.target.result); }
      catch (err) {
        msg($('sessions-msg'), 'Invalid JSON: ' + err.message, 'err');
        return;
      }
      if (!Array.isArray(bundle.sessions)) {
        msg($('sessions-msg'), 'Not a valid backup file (missing sessions[]).', 'err');
        return;
      }
      if (!window.confirm('Restore ' + bundle.sessions.length + ' session(s)? ' +
                          'Existing sessions with the same id will be overwritten.')) { return; }
      msg($('sessions-msg'), 'Restoring...', '');
      API.importSessions(bundle).then(function (res) {
        msg($('sessions-msg'),
            'Restored ' + res.imported + ' of ' + bundle.sessions.length +
            ' session(s)' + (res.failed ? ' (' + res.failed + ' failed)' : '') + '.', 'ok');
        loadSessions();
      }).catch(function (err) {
        msg($('sessions-msg'), 'Import failed: ' + err.message, 'err');
      });
    };
    reader.readAsText(file);
  }

  // ---- wire up --------------------------------------------------------------
  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { showView(t.dataset.view); });
    });
    $('vs').addEventListener('change', onVSChange);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="pubMode"]'), function (r) {
      r.addEventListener('change', syncPubModeUi);
    });
    $('occ-all').addEventListener('click', function () { setAllOccMask(true); });
    $('occ-none').addEventListener('click', function () { setAllOccMask(false); });
    $('ev-all').addEventListener('click', function () { setAllEvents(true); });
    $('ev-none').addEventListener('click', function () { setAllEvents(false); });
    $('traffic-enable').addEventListener('change', syncTrafficFormVisibility);
    $('t-method').addEventListener('change', syncTrafficBodyField);
    $('start-btn').addEventListener('click', startCapture);
    $('send-btn').addEventListener('click', sendTraffic);
    $('stop-btn').addEventListener('click', stopCapture);
    $('refresh-sessions').addEventListener('click', loadSessions);
    $('export-sessions').addEventListener('click', exportSessions);
    $('import-sessions').addEventListener('click', chooseImportFile);
    $('import-file').addEventListener('change', onImportFile);
    renderPeriodPresets();
    loadInventory();
    showView('setup');
    pollStatus();
    setInterval(pollStatus, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
