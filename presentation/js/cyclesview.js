// rultracer Stats (cycles-vs-CPU) view. Browser-only DOM rendering for the
// Analysis "Stats" sub-tab. NOT headless-tested beyond syntax coverage — it
// builds tables from the pure RPCycles seam (the math is validated there).
//
// Three sections, top to bottom:
//   1. A standing caveat banner: where the numbers come from and why the
//      authoritative cycles must be measured with the profiler OFF.
//   2. Authoritative tables (one per rule) from `ltm rule stats`: per event,
//      cycles + their µs / %CPU / max-req-per-sec derivations (the gist).
//   3. Reconcile: authoritative avgCycles vs trace-derived avgCycles per event
//      (the gap = profiler overhead, badged), then a trace-derived per-command
//      table (the only per-command source — clearly flagged as overhead-inflated).
//
// Kept free of optional chaining / nullish / ** so it survives the phase4 test's
// syntax load under Node 6.9.1.
(function () {
  'use strict';

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') { n.textContent = attrs[k]; }
        else if (k === 'class') { n.className = attrs[k]; }
        else { n.setAttribute(k, attrs[k]); }
      });
    }
    (kids || []).forEach(function (c) { if (c) { n.appendChild(c); } });
    return n;
  }

  function shortRule(r) { return String(r || '').replace(/^\/[^/]+\//, ''); }

  // Number formatting helpers.
  function fmtInt(n) {
    if (n == null || !isFinite(n)) { return '—'; }
    return Math.round(n).toLocaleString();
  }
  function fmtUs(n) {
    if (n == null || !isFinite(n)) { return '—'; }
    if (n >= 1000) { return (n / 1000).toFixed(2) + ' ms'; }
    return n.toFixed(2) + ' µs';
  }
  function fmtPct(frac) {
    if (frac == null || !isFinite(frac)) { return '—'; }
    var p = frac * 100;
    if (p > 0 && p < 0.0001) { return p.toExponential(2) + ' %'; }
    return p.toFixed(4) + ' %';
  }
  function fmtRps(n) {
    if (n == null || !isFinite(n) || n === 0) { return '—'; }
    return Math.round(n).toLocaleString() + '/s';
  }

  function thead(cols) {
    return el('thead', {}, [el('tr', {}, cols.map(function (c) { return el('th', { text: c }); }))]);
  }
  function td(text, cls) { return el('td', cls ? { text: text, class: cls } : { text: text }); }

  function CyclesView(container) { this.container = container; }

  CyclesView.prototype.message = function (text, kind) {
    this.container.innerHTML = '';
    this.container.appendChild(el('div', { class: 'cy-empty ' + (kind || ''), text: text }));
  };

  // opts: { cpu:{cpuHz,cores}, takenAt, ruleStats:[{rule,events:[...]}], model }
  CyclesView.prototype.render = function (opts) {
    opts = opts || {};
    var c = this.container;
    c.innerHTML = '';
    var cpuHz = (opts.cpu && opts.cpu.cpuHz) || 0;

    c.appendChild(this._caveat(opts));

    var hasStats = opts.ruleStats && opts.ruleStats.length;
    if (hasStats && cpuHz > 0) {
      // Whole-VS headline (only meaningful with multiple rules).
      if (opts.ruleStats.length >= 2) {
        c.appendChild(this._aggregate(window.RPCycles.aggregate(opts.ruleStats, cpuHz)));
      }
      opts.ruleStats.forEach(function (rs) {
        c.appendChild(this._authoritativeTable(rs, cpuHz));
      }, this);
      // Reconcile each rule's stats against the trace.
      opts.ruleStats.forEach(function (rs) {
        c.appendChild(this._reconcileTable(rs, opts.model, cpuHz));
      }, this);
    } else if (!hasStats) {
      c.appendChild(el('div', { class: 'cy-empty',
        text: 'No rule-stats snapshot yet. Reset, drive your high-volume traffic, then Snapshot to capture authoritative cycles.' }));
    }

    // Trace-derived per-command table (works with µs even if cpuHz is unknown).
    c.appendChild(this._commandTable(opts.model, cpuHz));
  };

  CyclesView.prototype._caveat = function (opts) {
    var cpu = opts.cpu || {};
    var bits = [];
    if (cpu.cpuHz) {
      bits.push(el('span', { class: 'cy-cpu',
        text: 'CPU budget: ' + (cpu.cpuHz / 1e9).toFixed(2) + ' GHz across ' + (cpu.cores || '?') +
          ' core(s) = ' + cpu.cpuHz.toLocaleString() + ' cyc/s' }));
    }
    if (opts.takenAt) {
      bits.push(el('span', { class: 'cy-taken', text: 'snapshot ' + String(opts.takenAt).replace('T', ' ').replace(/\..*/, '') }));
    }
    var banner = el('div', { class: 'cy-caveat' }, [
      el('strong', { text: 'How these numbers are sourced. ' }),
      el('span', { text: 'Authoritative cycles come from ' }),
      el('code', { text: 'ltm rule stats' }),
      el('span', { text: ' (TMM hardware counters). Measure them under a high-volume run (100k+ connections) with the rule-profiler OFF — its logging overhead inflates timings. The trace-derived numbers below are the only per-command view, but they include that overhead, so treat them as relative, not absolute. %CPU uses the whole-box budget (Σ all-core MHz), matching the DevCentral "Evaluating Performance" calculator.' })
    ]);
    if (bits.length) { banner.appendChild(el('div', { class: 'cy-facts' }, bits)); }
    return banner;
  };

  // Whole-VS headline: total per-request cost across every snapshotted rule,
  // plus each rule's share. Flat sum — caveat stated in the sub-line.
  CyclesView.prototype._aggregate = function (agg) {
    var stat = function (val, label) {
      return el('div', { class: 'cy-agg-stat' }, [
        el('div', { class: 'cy-agg-num', text: val }),
        el('div', { class: 'cy-agg-lbl', text: label })
      ]);
    };
    var grid = el('div', { class: 'cy-agg-grid' }, [
      stat(fmtInt(agg.cyclesPerReq), 'cycles / request'),
      stat(fmtUs(agg.usPerReq), 'µs / request'),
      stat(fmtPct(agg.pctPerReq), '%CPU / request'),
      stat(fmtRps(agg.maxReqPerSec), 'max req/s')
    ]);
    var body = el('tbody');
    agg.rules.forEach(function (r) {
      var share = agg.cyclesPerReq > 0 ? (r.cyclesPerReq / agg.cyclesPerReq) * 100 : 0;
      body.appendChild(el('tr', {}, [
        td(shortRule(r.rule)), td(fmtInt(r.cyclesPerReq), 'num'), td(share.toFixed(1) + ' %', 'num')
      ]));
    });
    return el('section', { class: 'cy-sec cy-agg' }, [
      el('h4', { text: 'Whole virtual server — ' + agg.ruleCount + ' rules' }),
      el('div', { class: 'cy-sub', text: 'sum of every rule’s per-request cost · assumes each event fires once per request (flat sum) — drive representative test traffic' }),
      grid,
      el('table', { class: 'cy-table' }, [thead(['Rule', 'Cyc / req', 'Share']), body])
    ]);
  };

  // Gist's authoritative table for one rule: per event, cycles + µs + %CPU + rps.
  CyclesView.prototype._authoritativeTable = function (rs, cpuHz) {
    var rows = window.RPCycles.ruleStatsRows(rs.events, cpuHz);
    var body = el('tbody');
    var sumAvgCyc = 0, maxExec = 0;
    rows.forEach(function (r) {
      sumAvgCyc += r.avgCycles;
      if (r.executions > maxExec) { maxExec = r.executions; }
      body.appendChild(el('tr', {}, [
        td(r.event), td(fmtInt(r.executions), 'num'),
        td(fmtInt(r.minCycles), 'num'), td(fmtInt(r.avgCycles), 'num'), td(fmtInt(r.maxCycles), 'num'),
        // req/s is a per-REQUEST metric — a request runs every event, so a
        // per-event req/s ("if the box did only this event") is misleading and
        // would read higher than the real combined limit. Shown on Total only.
        td(fmtUs(r.avgUs), 'num'), td(fmtPct(r.avgPct), 'num'), td('—', 'num')
      ]));
    });
    // Whole-rule total: cycles per request = Σ avg cycles across events.
    var totUs = window.RPCycles.cyclesToMicros(sumAvgCyc, cpuHz);
    var totPct = window.RPCycles.pctCpuPerReq(sumAvgCyc, cpuHz);
    var totRps = window.RPCycles.maxReqPerSec(sumAvgCyc, cpuHz);
    body.appendChild(el('tr', { class: 'cy-total' }, [
      td('Total / request'), td(fmtInt(maxExec), 'num'),
      td('', 'num'), td(fmtInt(sumAvgCyc), 'num'), td('', 'num'),
      td(fmtUs(totUs), 'num'), td(fmtPct(totPct), 'num'), td(fmtRps(totRps), 'num')
    ]));
    return el('section', { class: 'cy-sec' }, [
      el('h4', { text: 'Authoritative — ' + shortRule(rs.rule) + ' ' }),
      el('div', { class: 'cy-sub', text: 'from ltm rule stats · cycles measured by TMM · max req/s is per request (Σ all events) — a request runs every event, so per-event req/s is omitted' }),
      el('table', { class: 'cy-table' }, [
        thead(['Event', '# Exec', 'Min cyc', 'Avg cyc', 'Max cyc', 'Avg µs', 'Avg %CPU', 'Max req/s']),
        body
      ])
    ]);
  };

  // Reconcile: authoritative avgCycles vs trace-derived avgCycles per event.
  CyclesView.prototype._reconcileTable = function (rs, model, cpuHz) {
    var rows = window.RPCycles.reconcile(rs.events, model, cpuHz);
    var body = el('tbody');
    rows.forEach(function (r) {
      var badge = null;
      if (r.deltaPct != null) {
        var mag = Math.abs(r.deltaPct);
        var cls = mag <= 25 ? 'ok' : (mag <= 100 ? 'warn' : 'bad');
        var sign = r.deltaPct >= 0 ? '+' : '';
        badge = el('span', { class: 'cy-badge ' + cls, text: sign + r.deltaPct.toFixed(0) + '%' });
      }
      var deltaCell = el('td', { class: 'num' });
      if (badge) { deltaCell.appendChild(badge); } else { deltaCell.textContent = '—'; }
      body.appendChild(el('tr', {}, [
        td(r.event),
        td(r.statsAvgCycles != null ? fmtInt(r.statsAvgCycles) : '—', 'num'),
        td(r.traceAvgCycles != null ? fmtInt(r.traceAvgCycles) : '—', 'num'),
        td(r.traceAvgUs != null ? fmtUs(r.traceAvgUs) : '—', 'num'),
        td(r.traceExec != null ? fmtInt(r.traceExec) : '—', 'num'),
        deltaCell
      ]));
    });
    return el('section', { class: 'cy-sec' }, [
      el('h4', { text: 'Reconcile — ' + shortRule(rs.rule) }),
      el('div', { class: 'cy-sub', text: 'Left of the divider = measured by TMM (ltm rule stats, hardware counters, profiler OFF). Right = derived from the rule-profiler trace (profiler ON, inclusive wall-clock µs → cyc, overhead-inflated — not a real cycle count). Δ = profiler overhead (expect positive).' }),
      el('table', { class: 'cy-table cy-reconcile' }, [
        thead(['Event', 'Stats avg cyc', 'Trace avg cyc', 'Trace avg µs', 'Trace N', 'Δ overhead']),
        body
      ])
    ]);
  };

  // Trace-derived per-command table — the only per-command cycle view.
  CyclesView.prototype._commandTable = function (model, cpuHz) {
    var cmds = window.RPCycles.traceCommandStats(model);
    cmds.sort(function (a, b) { return b.totalRawUs - a.totalRawUs; });
    var body = el('tbody');
    var haveCyc = cpuHz > 0;
    cmds.forEach(function (cm) {
      var cells = [
        td(shortRule(cm.rule)), td(cm.event || '—'), td(cm.command),
        td(fmtInt(cm.count), 'num'),
        td(fmtUs(cm.avgRawUs), 'num'), td(fmtUs(cm.totalRawUs), 'num')
      ];
      if (haveCyc) {
        cells.push(td(fmtInt(window.RPCycles.microsToCycles(cm.avgRawUs, cpuHz)), 'num'));
        cells.push(td(fmtInt(window.RPCycles.microsToCycles(cm.totalRawUs, cpuHz)), 'num'));
      }
      body.appendChild(el('tr', {}, cells));
    });
    if (!cmds.length) { body.appendChild(el('tr', {}, [el('td', { colspan: haveCyc ? '8' : '6', text: 'No commands in this trace.' })])); }
    var cols = ['Rule', 'Event', 'Command', 'N', 'Avg µs', 'Total µs'];
    if (haveCyc) { cols = cols.concat(['Avg cyc', 'Total cyc']); }
    return el('section', { class: 'cy-sec' }, [
      el('h4', { text: 'Trace-derived per command' }),
      el('div', { class: 'cy-sub', text: 'profiler-overhead inflated · relative comparison only · counted by CMD_VM' + (haveCyc ? '' : ' · snapshot CPU for cycle columns') }),
      el('table', { class: 'cy-table' }, [thead(cols), body])
    ]);
  };

  window.CyclesView = CyclesView;
})();
