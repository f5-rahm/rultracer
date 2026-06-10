// rultracer step-through debugger. Browser-only (ES6+).
//
// A linked table + timeline scrubber over a unit's ordered occurrence records.
// Moving the scrubber (or clicking a row) sets a cursor; everything at/before
// the cursor is "executed", so we replay VAR_MOD lines to show current variable
// values and surface the most recent native command. Emits the cursor record so
// the sequence diagram can cross-highlight.
//
// Caveat (Goal 6): native-command return VALUES are only observable when stored
// into a variable (then visible via VAR_MOD). The table shows command
// invocation order/timing; values appear in the variables panel when captured.
(function () {
  'use strict';

  const KIND_LABEL = { ENTRY: '▶', EXIT: '◀', SINGLETON: '•' };

  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    if (attrs) { Object.keys(attrs).forEach((k) => {
      if (k === 'text') { n.textContent = attrs[k]; }
      else if (k === 'class') { n.className = attrs[k]; }
      else { n.setAttribute(k, attrs[k]); }
    }); }
    (kids || []).forEach((c) => n.appendChild(c));
    return n;
  }

  class StepThrough {
    constructor(tableContainer, scrubberContainer, panelContainer) {
      this.tableC = tableContainer;
      this.scrubC = scrubberContainer;
      this.panelC = panelContainer;
      this.cursorHandlers = [];
      this.unit = null;
      this.rowEls = new Map(); // rec.i -> <tr>
      this.cursorPos = 0;
    }

    onCursor(fn) { this.cursorHandlers.push(fn); }
    _emitCursor(recI) { this.cursorHandlers.forEach((fn) => fn(recI)); }

    render(unit) {
      this.unit = unit;
      this.rowEls.clear();
      const recs = unit.recs;
      const tsMin = recs.length ? recs[0].tsMicros : 0;

      // --- scrubber ---
      this.scrubC.innerHTML = '';
      const slider = el('input', { type: 'range', min: '0', max: String(Math.max(0, recs.length - 1)), value: '0', class: 'scrubber' });
      const readout = el('span', { class: 'scrub-readout', text: '0 / ' + recs.length });
      slider.addEventListener('input', () => this.setCursor(recs[parseInt(slider.value, 10)].i, true));
      this.scrubC.appendChild(el('label', { class: 'scrub-label', text: 'Timeline' }));
      this.scrubC.appendChild(slider);
      this.scrubC.appendChild(readout);
      this._slider = slider; this._readout = readout;

      // --- table ---
      this.tableC.innerHTML = '';
      const table = el('table', { class: 'step-table' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: '#' }), el('th', { text: '+µs' }), el('th', { text: '' }),
        el('th', { text: 'type' }), el('th', { text: 'value' }),
        el('th', { text: 'Self (µs)', title: 'Self time: this step’s own duration, excluding time spent in nested steps (raw − children).' })
      ])]));
      const tbody = el('tbody');
      const spanByEntry = new Map();
      window.RPModel.flatten(unit.roots).forEach((n) => { if (n.entryRec) { spanByEntry.set(n.entryRec.i, n); } });

      recs.forEach((r, pos) => {
        const tr = el('tr', { class: 'step-row' });
        tr.dataset.pos = pos;
        const node = spanByEntry.get(r.i);
        const self = (node && node.realExecTime != null) ? String(node.realExecTime) : '';
        const depthPad = node ? ' '.repeat(node.depth * 2) : '';
        const valTxt = r.base === 'VAR_MOD' ? (r.varName + ' = ' + r.varValue) : r.value;
        tr.appendChild(el('td', { class: 'num', text: String(pos) }));
        tr.appendChild(el('td', { class: 'num', text: '+' + (r.tsMicros - tsMin) }));
        tr.appendChild(el('td', { class: 'kind ' + r.kind.toLowerCase(), text: KIND_LABEL[r.kind] || '' }));
        tr.appendChild(el('td', { class: 'ty ' + r.domain.toLowerCase(), text: r.base }));
        tr.appendChild(el('td', { class: 'val', text: depthPad + valTxt }));
        tr.appendChild(el('td', { class: 'num', text: self }));
        tr.addEventListener('click', () => this.setCursor(r.i, true));
        tbody.appendChild(tr);
        this.rowEls.set(r.i, tr);
      });
      table.appendChild(tbody);
      this.tableC.appendChild(table);

      this.setCursor(recs.length ? recs[0].i : null, true);
    }

    setCursor(recI, emit) {
      if (recI == null) { this.panelC.innerHTML = ''; return; }
      const recs = this.unit.recs;
      const pos = recs.findIndex((r) => r.i === recI);
      if (pos < 0) { return; }
      this.cursorPos = pos;
      if (this._slider) { this._slider.value = String(pos); }
      if (this._readout) { this._readout.textContent = (pos + 1) + ' / ' + recs.length; }

      // highlight rows: executed (<=pos) vs current
      this.rowEls.forEach((tr) => { tr.classList.remove('current'); tr.classList.toggle('done', parseInt(tr.dataset.pos, 10) <= pos); });
      const cur = this.rowEls.get(recI);
      if (cur) { cur.classList.add('current'); cur.scrollIntoView({ block: 'nearest' }); }

      this._renderPanel(pos);
      if (emit) { this._emitCursor(recI); }
    }

    // Replay state up to and including cursor position.
    _renderPanel(pos) {
      const recs = this.unit.recs;
      const vars = new Map();        // name -> { value, atPos }
      let lastCmd = null;            // most recent CMD/CMD_VM entered
      const cmdStack = [];
      for (let i = 0; i <= pos; i++) {
        const r = recs[i];
        if (r.base === 'VAR_MOD') { vars.set(r.varName, { value: r.varValue, atPos: i }); }
        else if ((r.base === 'CMD' || r.base === 'CMD_VM') && r.kind === 'ENTRY') { lastCmd = r; cmdStack.push(r.value); }
        else if ((r.base === 'CMD' || r.base === 'CMD_VM') && r.kind === 'EXIT') { cmdStack.pop(); }
      }

      this.panelC.innerHTML = '';
      const cur = recs[pos];
      this.panelC.appendChild(el('div', { class: 'sp-head', text: 'At step ' + pos + ': ' + cur.base + ' ' + (cur.base === 'VAR_MOD' ? (cur.varName + '=' + cur.varValue) : cur.value) }));

      const vbox = el('div', { class: 'sp-vars' });
      vbox.appendChild(el('div', { class: 'sp-sub', text: 'Variables (captured so far)' }));
      if (!vars.size) { vbox.appendChild(el('div', { class: 'sp-empty', text: 'none captured yet (no VAR_MOD seen)' })); }
      else {
        const tbl = el('table', { class: 'sp-vartbl' });
        Array.from(vars.entries()).forEach(([name, v]) => {
          const tr = el('tr', { class: v.atPos === pos ? 'just-set' : '' });
          tr.appendChild(el('td', { class: 'vn', text: name }));
          tr.appendChild(el('td', { class: 'vv', text: v.value }));
          tbl.appendChild(tr);
        });
        vbox.appendChild(tbl);
      }
      this.panelC.appendChild(vbox);

      const cbox = el('div', { class: 'sp-cmd' });
      cbox.appendChild(el('div', { class: 'sp-sub', text: 'Command' }));
      cbox.appendChild(el('div', { text: lastCmd ? ('last invoked: ' + lastCmd.value) : 'no command invoked yet' }));
      cbox.appendChild(el('div', { class: 'sp-note', text: 'Native return values appear above only when stored to a variable.' }));
      this.panelC.appendChild(cbox);
    }
  }

  window.StepThrough = StepThrough;
})();
