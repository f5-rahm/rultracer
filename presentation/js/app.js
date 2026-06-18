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
    captureStartedAt: null, // wall-clock ms when engine entered 'capturing'
    testPhase: null,        // Phase 4.1: 'cycles' | 'trace' | null
    testFlow: null          // Phase 4.1: the in-flight test orchestration state
  };

  var METHODS_WITH_BODY = { POST: 1, PUT: 1, PATCH: 1 };
  var _timerHandle = null;

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) { Object.keys(attrs).forEach(function (k) {
      if (k === 'text') { n.textContent = attrs[k]; }
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
    // pub-select only when reusing AND the trace phase is on (it's trace-only).
    $('pub-select-field').hidden = (mode !== 'reuse') || !$('trace-enable').checked;
    if (mode === 'reuse' && routed.length === 0 && $('trace-enable').checked) {
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

  function buildConfig() {
    var pubMode = radioValue('pubMode');
    return {
      vs: state.currentVS,
      rules: checkedValues($('rules')),
      events: checkedValues($('events')),
      occMask: checkedValues($('occmask')),
      periodMs: parseInt($('period').value, 10),
      stopMode: radioValue('stopMode'),
      publisherMode: pubMode,
      publisherName: (pubMode === 'reuse') ? $('pub-select').value : undefined,
      name: $('capname').value || undefined
    };
  }

  // ---- Phase 4.1 test orchestration ----------------------------------------
  // A "test" is one session that may carry a cycles phase (reset -> high-volume
  // load -> snapshot, profiler OFF) and/or a trace phase (profiler capture). The
  // cycles phase MUST precede the trace phase so `ltm rule stats` are measured
  // with the profiler off (the profiler's syslog logging inflates the counters).
  // The browser drives the sequence; the engine keeps its own safety net.
  function runTest() {
    var cyclesOn = $('cycles-enable').checked;
    var traceOn = $('trace-enable').checked;
    var config = buildConfig();

    if (!state.currentVS) { return msg($('setup-msg'), 'Choose a virtual server.', 'err'); }
    if (!cyclesOn && !traceOn) { return msg($('setup-msg'), 'Enable at least one phase (cycles and/or trace).', 'err'); }
    if (cyclesOn && config.rules.length === 0) {
      return msg($('setup-msg'), 'Select at least one iRule — the cycles phase reads per-rule ltm stats.', 'err');
    }
    if (traceOn && config.occMask.length === 0) {
      return msg($('setup-msg'), 'Select at least one occurrence type for the profiler trace.', 'err');
    }
    if (traceOn && config.publisherMode === 'reuse' && !config.publisherName) {
      return msg($('setup-msg'), 'Pick a publisher from the dropdown for reuse mode.', 'err');
    }

    var loadSource = radioValue('loadSource');
    var onbox = null;
    if (cyclesOn && loadSource === 'onbox') {
      onbox = {
        host: $('hv-host').value.trim(),
        port: parseInt($('hv-port').value, 10) || 80,
        path: $('hv-path').value || '/',
        https: $('hv-https').checked,
        count: parseInt($('hv-count').value, 10) || 1,
        concurrency: parseInt($('hv-conc').value, 10) || 20,
        highVolume: true
      };
      if (!onbox.host) { return msg($('setup-msg'), 'Enter the VIP address for on-box load generation.', 'err'); }
    }

    state.periodMs = config.periodMs;
    state.stopMode = config.stopMode;
    state.testFlow = {
      config: config, cyclesOn: cyclesOn, traceOn: traceOn,
      rules: config.rules, loadSource: loadSource, onbox: onbox, sessionId: null
    };

    msg($('setup-msg'), 'Starting test…', '');
    $('start-btn').disabled = true;
    API.beginTest(config, config.name).then(function (res) {
      $('start-btn').disabled = false;
      state.testFlow.sessionId = res.sessionId;
      state.lastSessionId = res.sessionId;
      if (cyclesOn) { return beginCyclesPhase(); }
      return startTracePhase();
    }).catch(function (e) {
      $('start-btn').disabled = false;
      msg($('setup-msg'), 'Start failed: ' + e.message, 'err');
    });
  }

  function setCyclesMsg(text) { $('cycles-phase-msg').textContent = text || ''; }

  // Step 1–2: reset the rules' stats, then either wait for the user's external
  // load (pause + Continue) or fire the on-box load ourselves.
  function beginCyclesPhase() {
    var flow = state.testFlow;
    state.testPhase = 'cycles';
    $('cap-session').textContent = flow.sessionId;
    $('cap-vs').textContent = flow.config.vs;
    msg($('setup-msg'), '', '');
    showView('capture');
    $('cycles-phase').hidden = false;
    $('stop-btn').disabled = true;
    msg($('capture-msg'), '', '');
    $('cycles-continue').disabled = true;
    setCyclesMsg('Resetting stats for ' + flow.rules.join(', ') + '…');
    return API.resetStats(flow.sessionId, flow.rules).then(function () {
      if (flow.onbox) { return runOnboxLoad(); }
      setCyclesMsg('Stats reset. Drive your high-volume load now (≥200k requests, profiler OFF), then click “Snapshot & continue”.');
      $('cycles-continue').disabled = false;
    }).catch(function (e) {
      setCyclesMsg('');
      msg($('capture-msg'), 'Reset failed: ' + e.message, 'err');
    });
  }

  function runOnboxLoad() {
    var o = state.testFlow.onbox;
    setCyclesMsg('Generating ' + o.count + ' on-box requests (concurrency ' + o.concurrency + ')… this skews the measurement.');
    return API.sendTraffic({
      host: o.host, port: o.port, path: o.path, https: o.https,
      count: o.count, concurrency: o.concurrency, highVolume: true
    }).then(function (res) {
      setCyclesMsg('Sent ' + res.sent + ' (' + res.ok + ' ok, ' + res.failed + ' failed). Snapshotting…');
      return snapshotAndContinue();
    }).catch(function (e) {
      setCyclesMsg('');
      msg($('capture-msg'), 'On-box load failed: ' + e.message, 'err');
    });
  }

  // Step 3: snapshot the authoritative cycles, then branch to the trace phase or
  // finalize a cycles-only run.
  function snapshotAndContinue() {
    var flow = state.testFlow;
    $('cycles-continue').disabled = true;
    setCyclesMsg('Snapshotting cycles…');
    return API.snapshotCycles(flow.sessionId, flow.rules).then(function () {
      $('cycles-phase').hidden = true;
      if (flow.traceOn) { return startTracePhase(); }
      return finalizeCyclesOnly();
    }).catch(function (e) {
      $('cycles-continue').disabled = false;
      setCyclesMsg('');
      msg($('capture-msg'), 'Snapshot failed: ' + e.message, 'err');
    });
  }

  function finalizeCyclesOnly() {
    var flow = state.testFlow;
    state.testPhase = null;
    return API.finalizeSession(flow.sessionId).then(function () {
      msg($('capture-msg'), 'Cycles-only test finalized (session ' + flow.sessionId + '). Open it in Sessions → analyze → Stats.', 'ok');
      showView('sessions');
    }).catch(function (e) {
      msg($('capture-msg'), 'Finalize failed: ' + e.message, 'err');
    });
  }

  // Step 4–7: attach the profiler to the existing session and arm the capture.
  // The existing Stop button + engine-state poll finalize it as before.
  function startTracePhase() {
    var flow = state.testFlow;
    state.testPhase = 'trace';
    var config = flow.config;
    config.sessionId = flow.sessionId; // engine.start attaches instead of creating
    msg($('setup-msg'), '', '');
    msg($('capture-msg'), 'Starting profiler…', '');
    showView('capture');
    return API.startCapture(config).then(function (res) {
      state.lastSessionId = res.sessionId;
      $('cap-session').textContent = res.sessionId;
      $('cap-vs').textContent = flow.config.vs;
      msg($('capture-msg'), 'Capture armed. Drive the small profiler run (default 25), then Stop.', 'ok');
    }).catch(function (e) {
      msg($('capture-msg'), 'Profiler start failed: ' + e.message, 'err');
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

  function syncCyclesOpts() {
    $('cycles-opts').hidden = !$('cycles-enable').checked;
  }
  function syncLoadSource() {
    $('onbox-opts').hidden = radioValue('loadSource') !== 'onbox';
  }
  // Hide the profiler-only fields (events/occmask/period/stopmode/publisher) for
  // a cycles-only test. pub-select-field is governed by syncPubModeUi (which also
  // honours the trace toggle), so refresh it here too.
  function syncTracePhase() {
    var on = $('trace-enable').checked;
    Array.prototype.forEach.call(document.querySelectorAll('.trace-only'), function (elm) {
      elm.hidden = !on;
    });
    syncPubModeUi();
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
    // During the cycles phase the profiler is intentionally off (engine idle);
    // don't let the poll wipe the cycles banner or toggle the Stop button.
    if (state.testPhase === 'cycles') { return; }
    if (to === 'finalized') { state.testPhase = null; }
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
        // Status badge built via setAttribute(class)+textContent so a session
        // status (attacker-controllable through an imported backup) can never
        // inject markup. See ARCHITECTURE / the security pass.
        tr.appendChild(el('td', {}, [el('span', { class: 'badge ' + (s.status || ''), text: s.status || '' })]));
        tr.appendChild(el('td', { text: String(cap.lineCount != null ? cap.lineCount : '') }));
        var actions = el('td');
        var analyze = el('span', { class: 'link', text: 'analyze' });
        analyze.addEventListener('click', function (ev) {
          ev.stopPropagation();
          API.getRaw(s.id).then(function (res) {
            window.Analysis.loadRaw(res.raw || '', {
              rules: (s.config && s.config.rules) || [],
              sessionId: s.id,
              cycles: s.cycles || null
            });
          }).catch(function (e) { window.alert('Could not load raw: ' + e.message); });
        });
        actions.appendChild(analyze);
        actions.appendChild(document.createTextNode(' · '));
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
      d.appendChild(el('h3', { text: res.session.name || id }));
      // A dedicated raw host so re-clicking "view" REPLACES the output instead
      // of appending a fresh copy each time (the old bug).
      var rawHost = el('div', { class: 'raw-host' });
      var actions = el('div', { class: 'raw-actions' });
      var view = el('span', { class: 'link', text: 'view raw occurrences' });
      view.addEventListener('click', function () { showRaw(id, rawHost); });
      var exp = el('span', { class: 'link', text: 'export raw occurrences' });
      exp.addEventListener('click', function () { exportRaw(id, res.session.name); });
      actions.appendChild(view);
      actions.appendChild(document.createTextNode(' · '));
      actions.appendChild(exp);
      d.appendChild(actions);
      d.appendChild(rawHost);
      d.appendChild(el('pre', { text: JSON.stringify(res.session, null, 2) }));
    }).catch(function (e) { d.textContent = 'Error: ' + e.message; });
  }

  // Render the full raw.csv into `host`, clearing it first so repeated clicks
  // replace rather than accumulate. No line cap — the <pre> scrolls (.raw-pre).
  function showRaw(id, host) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'muted', text: 'Loading raw…' }));
    API.getRaw(id).then(function (res) {
      host.innerHTML = '';
      var lines = (res.raw || '').split('\n').filter(Boolean);
      host.appendChild(el('h3', { text: 'Raw occurrences (' + lines.length + ')' }));
      host.appendChild(el('pre', { class: 'raw-pre', text: lines.join('\n') || '(empty)' }));
    }).catch(function (e) {
      host.innerHTML = '';
      host.appendChild(el('div', { text: 'Raw error: ' + e.message }));
    });
  }

  // Download a session's full raw.csv (handy for grabbing fixtures / analysing
  // multi-TMM captures off-box).
  function exportRaw(id, name) {
    API.getRaw(id).then(function (res) {
      var safe = String(name || id).replace(/[^\w.-]+/g, '_');
      downloadBlob(new Blob([res.raw || ''], { type: 'text/csv' }), 'rultracer-' + safe + '-raw.csv');
    }).catch(function (e) { window.alert('Export raw failed: ' + e.message); });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
  // Populate the collapsed "Bytecode reference" panel from the shared opcode
  // table (window.RPOpcodes) so the panel and the seq-diagram tick tooltips
  // never drift apart.
  function renderBytecodeTable() {
    var body = $('bc-table-body');
    if (!body || !window.RPOpcodes) { return; }
    body.innerHTML = '';
    window.RPOpcodes.table.forEach(function (row) {
      var tr = document.createElement('tr');
      var op = document.createElement('td');
      op.textContent = row.op;
      if (row.v85) {
        var tag = document.createElement('span');
        tag.className = 'op-85';
        tag.textContent = 'Tcl 8.5';
        tag.title = 'Tcl 8.5 only — appears in the disassembler but not in the 8.4.6 iRule trace';
        op.appendChild(document.createTextNode(' '));
        op.appendChild(tag);
      }
      var meaning = document.createElement('td');
      meaning.innerHTML = row.meaning;
      tr.appendChild(op);
      tr.appendChild(meaning);
      body.appendChild(tr);
    });
  }

  // ---- Phase 8: bytecode disassembler --------------------------------------
  // Opt-in scratchpad in the "Bytecode reference & disassembler" panel. The pure
  // RPDisasm seam extracts the disassemblable body from a `when {}` wrapper and
  // parses the raw tclsh output; DisasmView renders it; the worker runs tclsh.
  var _disasmResults = null; // last results, so the mode toggle re-renders without re-fetching

  function disasmStatusMsg(text, isErr) {
    var s = $('disasm-status');
    if (!s) { return; }
    s.textContent = text || '';
    s.className = 'disasm-statusmsg' + (isErr ? ' disasm-statusmsg-err' : '');
  }

  function setDisasmEnabledUI(enabled) {
    var dis = $('disasm-disabled');
    var ui = $('disasm-ui');
    if (dis) { dis.hidden = enabled; }
    if (ui) { ui.hidden = !enabled; }
  }

  function refreshDisasmStatus() {
    if (!window.API || !window.API.disasmStatus) { return; }
    API.disasmStatus().then(function (s) {
      setDisasmEnabledUI(s && s.enabled === true);
    }).catch(function () {
      setDisasmEnabledUI(false); // older build / error -> show the opt-in prompt
    });
  }

  function enableDisasm() {
    var btn = $('disasm-enable');
    if (btn) { btn.disabled = true; }
    API.disasmEnable(true).then(function () {
      setDisasmEnabledUI(true);
    }).catch(function (err) {
      disasmStatusMsg(err.message || 'failed to enable', true);
    }).then(function () {
      if (btn) { btn.disabled = false; }
    });
  }

  function renderDisasmWarnings(warnings) {
    var box = $('disasm-warnings');
    if (!box) { return; }
    box.innerHTML = '';
    if (!warnings || !warnings.length) { box.hidden = true; return; }
    warnings.forEach(function (w) {
      var p = document.createElement('div');
      p.className = 'disasm-warn';
      p.textContent = '⚠ ' + w;
      box.appendChild(p);
    });
    box.hidden = false;
  }

  function renderDisasmResults() {
    if (!window.DisasmView) { return; }
    var mode = $('disasm-table-mode') && $('disasm-table-mode').checked ? 'table' : 'raw';
    DisasmView.render($('disasm-output'), _disasmResults || [], mode);
  }

  function runDisasm() {
    var input = $('disasm-input');
    var src = input ? input.value : '';
    if (!src || !/\S/.test(src)) { disasmStatusMsg('enter a Tcl snippet first', true); return; }
    if (!window.RPDisasm) { disasmStatusMsg('disassembler not loaded', true); return; }

    var extract = RPDisasm.extractHandlers(src);
    var warnings = extract.warnings.slice();
    var btn = $('disasm-run');
    if (btn) { btn.disabled = true; }
    disasmStatusMsg('disassembling…', false);

    Promise.all(extract.bodies.map(function (b) {
      return API.disasm(b.body).then(function (resp) {
        if (resp.compileError) {
          return { label: b.label, raw: '', parsed: null, compileError: resp.compileError };
        }
        var parsed = RPDisasm.parse(resp.output || '');
        if (parsed.warnings && parsed.warnings.length) {
          warnings = warnings.concat(parsed.warnings);
        }
        return { label: b.label, raw: resp.output || '', parsed: parsed, compileError: null };
      });
    })).then(function (results) {
      _disasmResults = results;
      renderDisasmWarnings(warnings);
      renderDisasmResults();
      disasmStatusMsg('', false);
    }).catch(function (err) {
      // A disabled backstop or transport failure — re-check the gate.
      disasmStatusMsg(err.message || 'disassembly failed', true);
      refreshDisasmStatus();
    }).then(function () {
      if (btn) { btn.disabled = false; }
    });
  }

  function wireDisasm() {
    var enable = $('disasm-enable');
    if (enable) { enable.addEventListener('click', enableDisasm); }
    var run = $('disasm-run');
    if (run) { run.addEventListener('click', runDisasm); }
    var toggle = $('disasm-table-mode');
    if (toggle) { toggle.addEventListener('change', renderDisasmResults); }
    refreshDisasmStatus();
  }

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
    $('cycles-enable').addEventListener('change', syncCyclesOpts);
    $('trace-enable').addEventListener('change', syncTracePhase);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="loadSource"]'), function (r) {
      r.addEventListener('change', syncLoadSource);
    });
    $('cycles-continue').addEventListener('click', snapshotAndContinue);
    $('start-btn').addEventListener('click', runTest);
    $('send-btn').addEventListener('click', sendTraffic);
    $('stop-btn').addEventListener('click', stopCapture);
    $('refresh-sessions').addEventListener('click', loadSessions);
    $('export-sessions').addEventListener('click', exportSessions);
    $('import-sessions').addEventListener('click', chooseImportFile);
    $('import-file').addEventListener('change', onImportFile);
    renderPeriodPresets();
    renderBytecodeTable();
    wireDisasm();
    syncCyclesOpts();
    syncLoadSource();
    syncTracePhase();
    if (window.Analysis) { window.Analysis.init(); }
    loadInventory();
    showView('setup');
    pollStatus();
    setInterval(pollStatus, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
