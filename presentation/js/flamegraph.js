// rultracer flamegraph view. Browser-only; wraps the vendored d3-flame-graph
// (global `flamegraph`, needs `d3`). NOT exercised by the headless test harness
// (DOM + d3) — every change here needs on-box eyes (Phase 2 lesson).
//
// Consumes the {name, value, children, _domain, _self, ...} trees from RPFlame.
// Two colour modes:
//   'domain' — frames tinted teal (TMM) / orange (TCL VM) to match the sequence
//              diagram; root grey.
//   'diff'   — frames tinted by self-time delta (red = slower in B, blue =
//              faster), normalised to the largest |delta| in the tree.
(function () {
  'use strict';

  var TMM = [20, 184, 166];   // teal  #14b8a6 (matches the sequence diagram)
  var VM = [234, 88, 12];     // orange #ea580c (matches the sequence diagram)
  var ROOT = '#9aa0a6';
  var NEUTRAL = '#dcdcdc';
  var RED = [201, 42, 42];    // slower in B
  var BLUE = [33, 102, 201];  // faster in B

  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  // mix white -> c by t in [0,1]
  function tint(c, t) {
    var r = Math.round(255 + (c[0] - 255) * t);
    var g = Math.round(255 + (c[1] - 255) * t);
    var b = Math.round(255 + (c[2] - 255) * t);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function domainColor(d) {
    var data = d.data || {};
    if (data._base === 'ROOT') { return ROOT; }
    return rgb(data._domain === 'VM' ? VM : TMM);
  }

  function fmtUs(n) {
    n = Math.round(n || 0);
    if (n >= 1000) { return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + ' ms'; }
    return n + ' µs';
  }

  function domainLabel(d) {
    var data = d.data || {};
    if (data._base === 'ROOT') {
      return data.name + ' — ' + fmtUs(data.value) + ' total';
    }
    var parts = [data.name + ' (' + data._base + ', ' + (data._domain === 'VM' ? 'TCL VM' : 'TMM') + ')'];
    parts.push('total ' + fmtUs(data.value));
    parts.push('self ' + fmtUs(data._self));
    if (data._count > 1) {
      parts.push(data._count + ' occurrences (avg ' + fmtUs(data.value / data._count) + ')');
    }
    if (data._bytecode) { parts.push(data._bytecode + ' bytecode'); }
    if (data._varmod) { parts.push(data._varmod + ' var-mod'); }
    if (data._unmatched) { parts.push('⚠ unmatched'); }
    return parts.join(' · ');
  }

  function diffLabel(d) {
    var data = d.data || {};
    if (data._base === 'ROOT') { return data.name + ' — diff (B sized, Δ self colour)'; }
    var dl = data.delta || 0;
    var sign = dl > 0 ? '+' : '';
    var tag = data._onlyB ? ' [new in B]' : (data._onlyA ? ' [only in A]' : '');
    return data.name + tag +
      ' · A ' + fmtUs(data._valA) + ' → B ' + fmtUs(data._valB) +
      ' · Δself ' + sign + fmtUs(dl).replace('µs', 'µs').replace(' ms', ' ms');
  }

  function FlameView(container) {
    this.el = container;
    this.charts = [];   // one per rendered flamegraph (stacked mode has many)
    this._last = null;  // remembered render call, for resize()
    this._max = 1;
  }

  FlameView.prototype._diffColor = function (d) {
    var data = d.data || {};
    if (data._base === 'ROOT') { return ROOT; }
    var dl = data.delta || 0;
    if (!dl || !this._max) { return NEUTRAL; }
    var t = Math.abs(dl) / this._max;
    if (t > 1) { t = 1; }
    // ease so small deltas still read
    t = 0.25 + 0.75 * t;
    return tint(dl > 0 ? RED : BLUE, t);
  };

  FlameView.prototype._empty = function (msg) {
    var p = document.createElement('p');
    p.className = 'flame-empty';
    p.textContent = msg || 'No spans with measurable duration to chart.';
    this.el.appendChild(p);
  };

  // Mount one flamegraph into `mountEl` for `data`. mode: 'domain' | 'diff'.
  FlameView.prototype._mount = function (mountEl, data, mode, width) {
    if (mode === 'diff') { this._max = window.RPFlame.maxAbsDelta(data) || 1; }
    var chart = window.flamegraph()
      .width(width)
      .cellHeight(18)
      .minFrameSize(1)
      .transitionDuration(0)
      .inverted(true)              // icicle: root on top, reads as a call tree
      .selfValue(false)            // our node.value is INCLUSIVE
      .sort(function (a, b) {
        var av = (a.data && a.data.value) || a.value || 0;
        var bv = (b.data && b.data.value) || b.value || 0;
        return bv - av;            // widest frames first
      });
    chart.setColorMapper(mode === 'diff' ? this._diffColor.bind(this) : domainColor);
    chart.setLabelHandler(mode === 'diff' ? diffLabel : domainLabel);
    window.d3.select(mountEl).datum(data).call(chart);
    this.charts.push(chart);
  };

  FlameView.prototype._reset = function () {
    while (this.el.firstChild) { this.el.removeChild(this.el.firstChild); }
    this.charts = [];
  };
  FlameView.prototype._width = function () {
    return this.el.clientWidth || this.el.offsetWidth || 900;
  };

  // Render a single flamegraph. data: an RPFlame tree. opts.mode: 'domain'|'diff'.
  FlameView.prototype.render = function (data, opts) {
    opts = opts || {};
    var mode = opts.mode || 'domain';
    this._last = { kind: 'one', data: data, opts: opts };
    this._reset();
    if (!data || !data.children || !data.children.length || !data.value) {
      this._empty(opts.emptyMsg);
      return;
    }
    this._mount(this.el, data, mode, this._width());
  };

  // Render several flamegraphs stacked vertically, each with its own header.
  // items: [{ label, data }]. opts.mode as above. Each graph's width is scaled
  // proportional to its root duration (left-aligned) so the stack preserves the
  // relative-duration context a single combined graph would show by width — with
  // a floor so a tiny event stays legible (its bar then over-states its share).
  var MIN_RATIO = 0.12;
  FlameView.prototype.renderMany = function (items, opts) {
    opts = opts || {};
    var mode = opts.mode || 'domain';
    this._last = { kind: 'many', items: items, opts: opts };
    this._reset();
    var drawn = items.filter(function (it) { return it.data && it.data.value; });
    if (!drawn.length) { this._empty(opts.emptyMsg); return; }
    var full = this._width();
    var maxVal = drawn.reduce(function (m, it) { return Math.max(m, it.data.value); }, 0) || 1;
    var floor = Math.round(full * MIN_RATIO);
    for (var i = 0; i < drawn.length; i++) {
      var ratio = drawn[i].data.value / maxVal;
      var w = Math.max(floor, Math.round(full * ratio));
      var scaled = w < full;            // flag bars whose width is sub-full-pane
      var wrap = document.createElement('div');
      wrap.className = 'flame-stack-item';
      var head = document.createElement('div');
      head.className = 'flame-stack-label';
      head.textContent = drawn[i].label || '';
      if (scaled && w === floor && ratio < MIN_RATIO) { head.title = 'width floored for legibility (actual share ' + Math.round(ratio * 100) + '%)'; }
      var inner = document.createElement('div');
      wrap.appendChild(head);
      wrap.appendChild(inner);
      this.el.appendChild(wrap);
      this._mount(inner, drawn[i].data, mode, w);
    }
  };

  FlameView.prototype.resetZoom = function () {
    this.charts.forEach(function (c) { if (c && c.resetZoom) { c.resetZoom(); } });
  };

  FlameView.prototype.resize = function () {
    var l = this._last;
    if (!l) { return; }
    if (l.kind === 'many') { this.renderMany(l.items, l.opts); }
    else { this.render(l.data, l.opts); }
  };

  FlameView.prototype.clear = function () {
    this._reset();
    this._last = null;
  };

  window.FlameView = FlameView;
})();
