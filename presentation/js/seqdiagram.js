// rultracer sequence diagram. Browser-only (ES6+). Custom SVG, no D3.
//
// Lifelines are ordered by CALL ORDER so every arrow is a short adjacent step:
//   Users · Event · Rule · RuleVM · CommandVM · Command
// (EVENT->RULE->RULE_VM->CMD_VM->CMD, then returns). There is no fixed gutter;
// instead TMM vs TCL-VM is shown with stark colour contrast (teal vs orange) on
// the lifelines, headers and activation bars, and every arrow that crosses the
// TMM<->VM boundary is drawn in an accent colour so the handoffs pop.
//
// The diagram is responsive: lifeline x-positions are computed from the measured
// pane width (down to a minimum, below which it scrolls). The diagram's CSS is
// embedded as a <style> inside the SVG (single source of truth) which also makes
// the SVG/PNG exports self-contained.
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';

  // Call-order lifelines with their domain. 'Command' is TMM even though it sits
  // on the far right, because native commands are dispatched from CommandVM.
  const LIFELINES = [
    { key: 'Users', label: 'Users', domain: 'actor' },
    { key: 'Event', label: 'Event', domain: 'tmm' },
    { key: 'Rule', label: 'Rule', domain: 'tmm' },
    { key: 'RuleVM', label: 'RuleVM', domain: 'vm' },
    { key: 'CommandVM', label: 'CommandVM', domain: 'vm' },
    { key: 'Command', label: 'Command', domain: 'tmm' }
  ];
  const DOMAIN_OF = {};
  LIFELINES.forEach((l) => { DOMAIN_OF[l.key] = l.domain; });

  const MIN_W = 860;       // below this the canvas scrolls horizontally
  const LEFT = 80;
  const RIGHT = 48;
  const HEADER_H = 56;
  const ROW_H = 30;
  const TOP_PAD = 20;
  const BAR_W = 10;

  // Diagram-internal styles, embedded in the SVG so exports are self-contained.
  const SEQ_CSS = [
    '.seqsvg{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}',
    '.seq-bg{fill:#ffffff}',
    '.seq-band-tmm{fill:#0d9488;fill-opacity:.05}',
    '.seq-band-vm{fill:#ea580c;fill-opacity:.05}',
    '.seq-lifeline-tmm{stroke:#5eead4;stroke-width:1.5;stroke-dasharray:3 3}',
    '.seq-lifeline-vm{stroke:#fdba74;stroke-width:1.5;stroke-dasharray:3 3}',
    '.seq-lifeline-actor{stroke:#cbd5e1;stroke-width:1;stroke-dasharray:3 3}',
    '.seq-head-tmm{fill:#0d9488;stroke:#0f766e}',
    '.seq-head-vm{fill:#ea580c;stroke:#c2410c}',
    '.seq-head-label{font-size:12px;font-weight:600;fill:#ffffff}',
    '.seq-head-label-actor{font-size:12px;fill:#334155;font-weight:600}',
    '.seq-actor{stroke:#334155;stroke-width:1.5;fill:#f4d24a}',
    '.seq-bar-tmm{fill:#5eead4;fill-opacity:.9;stroke:#0d9488;stroke-width:.6}',
    '.seq-bar-vm{fill:#fdba74;fill-opacity:.9;stroke:#ea580c;stroke-width:.6}',
    '.seq-bar.unmatched{stroke-dasharray:3 2;stroke-width:1.3}',
    '.seq-line{stroke:#334155;stroke-width:1.3}',
    '.seq-line.dashed{stroke-dasharray:4 3;stroke:#94a3b8}',
    '.seq-line.cross{stroke:#7c3aed;stroke-width:2.2}',
    '.seq-line.cross.dashed{stroke:#a78bfa;stroke-width:1.6}',
    '.ah-solid{fill:#334155}', '.ah-open{fill:#94a3b8}',
    '.ah-cross{fill:#7c3aed}', '.ah-cross-open{fill:#a78bfa}',
    '.seq-label{font-size:11px;fill:#1e293b}',
    '.seq-label.cross{fill:#6d28d9;font-weight:600}',
    '.seq-label.bc{fill:#9a3412}',
    '.seq-label.var{fill:#15803d;font-weight:600}',
    '.seq-label.run{fill:#9a3412;cursor:pointer;text-decoration:underline}',
    '.seq-loop{fill:none;stroke:#ea580c;stroke-width:1}',
    '.seq-time{font-family:monospace;font-size:9px;fill:#94a3b8}',
    '.seq-delta{font-family:monospace;font-size:10px;fill:#6d28d9}',
    '.seq-bracket{fill:none;stroke:#7c3aed;stroke-width:1}',
    '.seq-band-sel{fill:#2da7df;fill-opacity:.14}',
    '.seq-hit{cursor:pointer}'
  ].join('');

  function svg(tag, attrs, children) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) { Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k])); }
    (children || []).forEach((c) => n.appendChild(c));
    return n;
  }
  function t(s) { return document.createTextNode(s); }
  function shortName(v) { return String(v || '').replace(/^\/[^/]+\//, ''); }

  function collectRecords(node, out) {
    out = out || [];
    if (node.entryRec) { out.push(node.entryRec); }
    if (node.exitRec) { out.push(node.exitRec); }
    node.points.forEach((p) => out.push(p.rec));
    node.children.forEach((c) => collectRecords(c, out));
    return out;
  }

  class SeqDiagram {
    constructor(container) {
      this.container = container;
      this.scale = 1;
      this.mode = { collapseBytecode: true, timeScaled: false, timing: 'off' };
      this.expandedRuns = new Set();
      this.selectHandlers = [];
      this.unit = null;
      this.rowByRec = new Map();
      this.svgEl = null;
      this.lx = {};
      this.follow = true;   // auto-center the diagram on the highlighted span
      this._initPan();
    }

    onSelect(fn) { this.selectHandlers.push(fn); }
    _emitSelect(recI) { this.selectHandlers.forEach((fn) => fn(recI)); }
    setMode(patch) { Object.assign(this.mode, patch); if (this.unit) { this.render(this.unit); } }
    setFollow(v) { this.follow = !!v; }   // toggle without a full re-render

    _initPan() {
      let down = false; let sx = 0; let sy = 0; let sl = 0; let st = 0;
      const c = this.container;
      c.addEventListener('mousedown', (e) => {
        down = true; sx = e.clientX; sy = e.clientY; sl = c.scrollLeft; st = c.scrollTop;
        c.classList.add('panning');
      });
      window.addEventListener('mousemove', (e) => {
        if (!down) { return; }
        c.scrollLeft = sl - (e.clientX - sx);
        c.scrollTop = st - (e.clientY - sy);
      });
      window.addEventListener('mouseup', () => { down = false; c.classList.remove('panning'); });
    }

    zoom(factor) { this.scale = Math.max(0.3, Math.min(3, this.scale * factor)); this._applyScale(); }
    zoomReset() { this.scale = 1; this._applyScale(); }
    _applyScale() {
      if (!this.svgEl) { return; }
      this.svgEl.setAttribute('width', this._contentW * this.scale);
      this.svgEl.setAttribute('height', this._contentH * this.scale);
    }

    _computeX(width) {
      const w = Math.max(width || 0, MIN_W);
      const usable = w - LEFT - RIGHT;
      const step = usable / (LIFELINES.length - 1);
      LIFELINES.forEach((l, i) => { l.x = LEFT + i * step; this.lx[l.key] = l.x; });
      return w;
    }

    render(unit) {
      this.unit = unit;
      this.rowByRec.clear();
      this.container.innerHTML = '';

      const width = this._computeX(this.container.clientWidth);
      const LX = this.lx;
      const spans = window.RPModel.flatten(unit.roots);
      const recs = unit.recs;

      // visual rows (collapse consecutive bytecodes unless expanded)
      const rows = [];
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (this.mode.collapseBytecode && r.base === 'CMD_BYTECODE' && !this.expandedRuns.has(r.i)) {
          const run = [r];
          let j = i + 1;
          while (j < recs.length && recs[j].base === 'CMD_BYTECODE') { run.push(recs[j]); j++; }
          if (run.length > 1) { rows.push({ type: 'run', recs: run, ts: r.tsMicros }); i = j - 1; continue; }
        }
        rows.push({ type: 'occ', rec: r, ts: r.tsMicros });
      }

      const tsMin = recs.length ? recs[0].tsMicros : 0;
      const tsMax = recs.length ? recs[recs.length - 1].tsMicros : 1;
      const span = (tsMax - tsMin) || 1;
      const bodyH = Math.max(rows.length, 1) * ROW_H;
      const yOf = (row, idx) => this.mode.timeScaled
        ? HEADER_H + TOP_PAD + ((row.ts - tsMin) / span) * (bodyH - ROW_H)
        : HEADER_H + TOP_PAD + idx * ROW_H;
      rows.forEach((row, idx) => {
        row.y = yOf(row, idx);
        (row.type === 'run' ? row.recs : [row.rec]).forEach((r) => this.rowByRec.set(r.i, { y: row.y, rowIdx: idx }));
      });

      const contentH = HEADER_H + TOP_PAD * 2 + bodyH + HEADER_H;
      this._contentW = width;
      this._contentH = contentH;

      const root = svg('svg', {
        xmlns: SVGNS, class: 'seqsvg',
        viewBox: '0 0 ' + width + ' ' + contentH,
        width: width * this.scale, height: contentH * this.scale
      });
      const style = svg('style');
      style.textContent = SEQ_CSS;
      root.appendChild(style);
      root.appendChild(this._defs());
      root.appendChild(svg('rect', { class: 'seq-bg', x: 0, y: 0, width: width, height: contentH }));
      const vp = svg('g', { class: 'viewport' });
      root.appendChild(vp);

      const colW = (LX.Event - LX.Users); // approx lifeline spacing
      LIFELINES.forEach((l) => {
        if (l.domain !== 'actor') {
          vp.appendChild(svg('rect', { class: 'seq-band-' + l.domain, x: l.x - colW * 0.42, y: HEADER_H, width: colW * 0.84, height: contentH - HEADER_H * 2 }));
        }
        vp.appendChild(svg('line', { class: 'seq-lifeline-' + l.domain, x1: l.x, y1: HEADER_H, x2: l.x, y2: contentH - HEADER_H }));
        vp.appendChild(this._head(l, 8));
        vp.appendChild(this._head(l, contentH - HEADER_H + 8));
      });

      this._band = svg('rect', { x: 0, y: -100, width: width, height: ROW_H, class: 'seq-band-sel', visibility: 'hidden' });
      vp.appendChild(this._band);

      spans.forEach((node) => {
        const e = this.rowByRec.get(node.entryRec.i);
        if (!e || LX[node.lifeline] == null) { return; }
        const xx = LX[node.lifeline];
        let y2;
        if (node.exitRec && this.rowByRec.get(node.exitRec.i)) { y2 = this.rowByRec.get(node.exitRec.i).y; }
        else { y2 = HEADER_H + TOP_PAD + bodyH; }
        const cls = 'seq-bar seq-bar-' + (node.domain === 'VM' ? 'vm' : 'tmm') + (node.unmatched ? ' unmatched' : '');
        vp.appendChild(svg('rect', { x: xx - BAR_W / 2, y: e.y, width: BAR_W, height: Math.max(ROW_H * 0.6, y2 - e.y), rx: 2, class: cls }));

        // 'bracket' timing: a duration spine hugging the activation, capped at
        // entry/exit, labelled with the total elapsed µs. Height = row-extent in
        // even-step layout, real time in 'Scale to time'; the µs label is exact.
        if (this.mode.timing === 'bracket' && node.exitRec && node.raw != null) {
          const er = this.rowByRec.get(node.exitRec.i);
          if (er && er.y > e.y) {
            // Brackets + labels go to the LEFT of the lifeline so they stay
            // clear of the bytecode/var ticks (which sit on the right).
            const dir = -1;
            const xb = xx + dir * (BAR_W / 2 + 5);
            const g = svg('g');
            g.appendChild(svg('path', { d: 'M' + (xb - dir * 5) + ',' + e.y + ' H' + xb + ' V' + er.y + ' H' + (xb - dir * 5), class: 'seq-bracket' }));
            g.appendChild(svg('text', { x: xb + dir * 4, y: (e.y + er.y) / 2 + 3, class: 'seq-delta', 'text-anchor': 'end' }, [t('Δ ' + node.raw + 'µs')]));
            vp.appendChild(g);
          }
        }
      });

      rows.forEach((row) => {
        if (row.type === 'run') { vp.appendChild(this._run(row)); return; }
        const r = row.rec;
        if (r.kind === 'SINGLETON') { vp.appendChild(this._tick(r, row.y)); return; }
        vp.appendChild(this._arrow(r, row.y, spans));
        vp.appendChild(svg('text', { x: 8, y: row.y + 4, class: 'seq-time' }, [t('+' + (r.tsMicros - tsMin) + 'µs')]));
      });

      this.svgEl = root;
      this.container.appendChild(root);
    }

    _defs() {
      const d = svg('defs');
      const mk = (id, cls) => {
        const m = svg('marker', { id, markerWidth: 10, markerHeight: 10, refX: 8, refY: 3, orient: 'auto', markerUnits: 'userSpaceOnUse' });
        m.appendChild(svg('path', { d: 'M0,0 L8,3 L0,6 Z', class: cls }));
        return m;
      };
      d.appendChild(mk('arrowSolid', 'ah-solid'));
      d.appendChild(mk('arrowOpen', 'ah-open'));
      d.appendChild(mk('arrowCross', 'ah-cross'));
      d.appendChild(mk('arrowCrossOpen', 'ah-cross-open'));
      return d;
    }

    _head(l, y) {
      const g = svg('g');
      if (l.domain === 'actor') {
        g.appendChild(svg('circle', { cx: l.x, cy: y + 12, r: 7, class: 'seq-actor' }));
        g.appendChild(svg('line', { x1: l.x, y1: y + 19, x2: l.x, y2: y + 34, class: 'seq-actor' }));
        g.appendChild(svg('text', { x: l.x, y: y + 46, class: 'seq-head-label-actor', 'text-anchor': 'middle' }, [t(l.label)]));
      } else {
        const w = Math.max(58, l.label.length * 8 + 16);
        g.appendChild(svg('rect', { x: l.x - w / 2, y: y, width: w, height: 26, rx: 3, class: 'seq-head-' + l.domain }));
        g.appendChild(svg('text', { x: l.x, y: y + 17, class: 'seq-head-label', 'text-anchor': 'middle' }, [t(l.label)]));
      }
      return g;
    }

    _arrow(r, y, spans) {
      const node = spans.find((n) => (n.entryRec && n.entryRec.i === r.i) || (n.exitRec && n.exitRec.i === r.i));
      const self = node ? node.lifeline : r.lifeline;
      const caller = node && node.parent ? node.parent.lifeline : 'Users';
      const entry = r.kind === 'ENTRY';
      const from = entry ? caller : self;
      const to = entry ? self : caller;
      const x1 = this.lx[from]; const x2 = this.lx[to];
      // crossing = endpoints in different TMM/VM domains (Users excluded)
      const cross = from !== 'Users' && to !== 'Users' && DOMAIN_OF[from] !== DOMAIN_OF[to];
      const g = svg('g');
      let marker;
      if (cross) { marker = entry ? 'arrowCross' : 'arrowCrossOpen'; }
      else { marker = entry ? 'arrowSolid' : 'arrowOpen'; }
      g.appendChild(svg('line', {
        x1, y1: y, x2, y2: y,
        class: 'seq-line' + (entry ? '' : ' dashed') + (cross ? ' cross' : ''),
        'marker-end': 'url(#' + marker + ')'
      }));
      let label;
      if (r.base === 'EVENT') { label = r.value; }
      else if (r.base === 'RULE' || r.base === 'RULE_VM') { label = shortName(r.value); }
      else { label = r.value; }
      if (entry) {
        g.appendChild(svg('text', { x: (x1 + x2) / 2, y: y - 5, class: 'seq-label' + (cross ? ' cross' : ''), 'text-anchor': 'middle' }, [t(label)]));
      } else if (this.mode.timing === 'label' && node && node.raw != null) {
        // 'label' timing: annotate the return hop with the elapsed delta.
        g.appendChild(svg('text', { x: (x1 + x2) / 2, y: y + 12, class: 'seq-delta', 'text-anchor': 'middle' }, [t('Δ ' + node.raw + 'µs')]));
      }
      g.appendChild(this._hit(y, r.i));
      return g;
    }

    _tick(r, y) {
      const x = this.lx[r.lifeline];
      const g = svg('g');
      g.appendChild(svg('path', { d: 'M' + x + ',' + y + ' h16 v8 h-16', class: 'seq-loop', 'marker-end': 'url(#arrowOpen)' }));
      const label = r.base === 'VAR_MOD' ? ('set ' + (r.varName || '') + ' = ' + (r.varValue || '')) : ('bytecode ' + r.value);
      g.appendChild(svg('text', { x: x + 22, y: y + 8, class: 'seq-label ' + (r.base === 'VAR_MOD' ? 'var' : 'bc') }, [t(label)]));
      g.appendChild(this._hit(y, r.i));
      return g;
    }

    _run(row) {
      const x = this.lx.RuleVM;
      const y = row.y;
      const g = svg('g', { class: 'seq-run' });
      g.appendChild(svg('path', { d: 'M' + x + ',' + y + ' h16 v8 h-16', class: 'seq-loop', 'marker-end': 'url(#arrowOpen)' }));
      g.appendChild(svg('text', { x: x + 22, y: y + 8, class: 'seq-label bc run' }, [t('bytecode ×' + row.recs.length + '  (expand)')]));
      g.appendChild(this._hit(y, row.recs[0].i));
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        row.recs.forEach((r) => this.expandedRuns.add(r.i));
        this.render(this.unit);
      });
      return g;
    }

    _hit(y, recI) {
      const r = svg('rect', { x: 0, y: y - ROW_H / 2, width: this._contentW, height: ROW_H, class: 'seq-hit', fill: 'transparent' });
      r.addEventListener('click', (e) => { e.stopPropagation(); this._emitSelect(recI); });
      return r;
    }

    highlight(recI) {
      const row = this.rowByRec.get(recI);
      if (!row || !this._band) { if (this._band) { this._band.setAttribute('visibility', 'hidden'); } return; }
      this._band.setAttribute('y', row.y - ROW_H / 2);
      this._band.setAttribute('visibility', 'visible');
      // Only auto-center when "follow" is on; the band stays visible either way,
      // so the diagram doesn't lurch under the user when they don't want it to.
      if (this.follow) {
        this.container.scrollTop = Math.max(0, (row.y * this.scale) - this.container.clientHeight / 2);
      }
    }

    // ---- export (self-contained, styles already embedded) ------------------
    _exportSvgString() {
      if (!this.svgEl) { return null; }
      const clone = this.svgEl.cloneNode(true);
      clone.setAttribute('width', this._contentW);
      clone.setAttribute('height', this._contentH);
      clone.setAttribute('xmlns', SVGNS);
      return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    }

    exportSVG(filename) {
      const str = this._exportSvgString();
      if (!str) { return; }
      _download(new Blob([str], { type: 'image/svg+xml' }), (filename || 'trace') + '.svg');
    }

    exportPNG(filename) {
      const str = this._exportSvgString();
      if (!str) { return; }
      const scale = 2; // 2x for a crisp raster
      const w = this._contentW; const h = this._contentH;
      const img = new Image();
      const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = w * scale; canvas.height = h * scale;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => { if (blob) { _download(blob, (filename || 'trace') + '.png'); } }, 'image/png');
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }
  }

  function _download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.SeqDiagram = SeqDiagram;
  window.SeqDiagram.collectRecords = collectRecords;
})();
