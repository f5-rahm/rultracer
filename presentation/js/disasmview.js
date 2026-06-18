// rultracer Phase 8 — disassembler output view (window.DisasmView).
//
// Browser-only DOM rendering for the "Bytecode reference & disassembler" panel.
// NOT headless-tested beyond syntax coverage (Phase 2–7 lesson): the parsing it
// renders from is validated in the pure RPDisasm seam (test/phase8.js); app.js
// orchestrates extract -> POST /disasm -> parse and hands the results here.
//
// Renders an array of per-body results (one per `when` handler, or a single
// unwrapped body) in one of two modes (the checkbox toggle, mirroring the
// sequence diagram's "Collapse bytecodes"):
//   - 'raw'   : the verbatim tclsh disassembly text in a <pre>
//   - 'table' : structured, grouped by Command block (src header + pc/opcode/
//               operands/# literal rows), opcodes cross-linked to RPOpcodes
//               tooltips and 8.5-only opcodes flagged.
// Kept free of optional chaining / nullish / ** so the phase8 test can load it
// under Node 6.9.1 for syntax coverage.
(function () {
  'use strict';

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') { n.textContent = attrs[k]; }
        else if (k === 'class') { n.className = attrs[k]; }
        else if (k === 'title') { n.setAttribute('title', attrs[k]); }
        else { n.setAttribute(k, attrs[k]); }
      });
    }
    (kids || []).forEach(function (c) { if (c) { n.appendChild(c); } });
    return n;
  }

  // "3 commands · 9 instructions · 3 literals · stack depth 2" from parsed.meta.
  function costSummary(meta) {
    if (!meta) { return null; }
    var bits = [];
    if (meta.cmds != null) { bits.push(meta.cmds + ' command' + (meta.cmds === 1 ? '' : 's')); }
    if (meta.inst != null) { bits.push(meta.inst + ' instruction' + (meta.inst === 1 ? '' : 's')); }
    if (meta.litObjs != null) { bits.push(meta.litObjs + ' literal' + (meta.litObjs === 1 ? '' : 's')); }
    if (meta.stkDepth != null) { bits.push('stack depth ' + meta.stkDepth); }
    if (!bits.length) { return null; }
    return el('div', { class: 'disasm-cost', text: bits.join(' · ') });
  }

  // The opcode cell: mnemonic + tooltip + an "8.5" flag for 8.5-only opcodes.
  function opcodeCell(opcode) {
    var cell = el('td', { class: 'disasm-op' });
    var code = el('code', { text: opcode });
    var tip = window.RPOpcodes ? window.RPOpcodes.tip(opcode) : null;
    if (tip) { code.setAttribute('title', tip); }
    cell.appendChild(code);
    if (window.RPOpcodes && window.RPOpcodes.is85(opcode)) {
      cell.appendChild(document.createTextNode(' '));
      cell.appendChild(el('span', {
        class: 'op-85',
        text: 'Tcl 8.5',
        title: 'Tcl 8.5 only — appears in the disassembler but not in the 8.4.6 iRule trace'
      }));
    }
    return cell;
  }

  // One Command block as a labeled table (or a header-only note when empty).
  function blockTable(cmd) {
    var frag = el('div', { class: 'disasm-block' });
    frag.appendChild(el('div', { class: 'disasm-block-src' }, [el('code', { text: cmd.src || '(command)' })]));
    if (!cmd.instructions || !cmd.instructions.length) {
      frag.appendChild(el('div', { class: 'disasm-empty', text: '— container (instructions live in a nested command below)' }));
      return frag;
    }
    var head = el('thead', {}, [el('tr', {}, [
      el('th', { text: 'pc' }), el('th', { text: 'opcode' }),
      el('th', { text: 'operands' }), el('th', { text: '# literal' })
    ])]);
    var rows = cmd.instructions.map(function (ins) {
      return el('tr', {}, [
        el('td', { class: 'disasm-pc', text: String(ins.pc) }),
        opcodeCell(ins.opcode),
        el('td', { class: 'disasm-operands', text: ins.operands || '' }),
        el('td', { class: 'disasm-comment', text: ins.comment == null ? '' : ('# ' + ins.comment) })
      ]);
    });
    frag.appendChild(el('table', { class: 'disasm-table' }, [head, el('tbody', {}, rows)]));
    return frag;
  }

  // Render one result (one handler body or the whole snippet).
  //   result = { label: string|null, raw: string, parsed: {meta,commands,...} }
  function renderResult(result, mode) {
    var section = el('div', { class: 'disasm-result' });
    if (result.label) {
      section.appendChild(el('div', { class: 'disasm-handler', text: 'Handler: ' + result.label }));
    }
    // A Tcl compile error for this body — surfaced verbatim (useful feedback).
    if (result.compileError) {
      section.appendChild(el('pre', { class: 'disasm-error', text: result.compileError }));
      return section;
    }

    var cost = costSummary(result.parsed && result.parsed.meta);
    if (cost) { section.appendChild(cost); }

    if (mode === 'raw') {
      section.appendChild(el('pre', { class: 'disasm-raw', text: result.raw || '' }));
      return section;
    }
    var cmds = (result.parsed && result.parsed.commands) || [];
    if (!cmds.length) {
      section.appendChild(el('div', { class: 'disasm-empty', text: 'No bytecode produced.' }));
      return section;
    }
    cmds.forEach(function (c) { section.appendChild(blockTable(c)); });
    return section;
  }

  // Public: render all results into `container`. mode = 'raw' | 'table'.
  function render(container, results, mode) {
    if (!container) { return; }
    container.innerHTML = '';
    (results || []).forEach(function (r) { container.appendChild(renderResult(r, mode)); });
  }

  window.DisasmView = { render: render };
})();
