// rultracer report-data seam (Phase 5). PURE: no DOM, no d3, no fetch — kept
// strictly Node-6.9.1-safe (var only; no arrow / const / let / template literals
// / optional chaining / nullish / **) so test/phase5.js exercises it on-box too.
//
// This module owns the parts of the "Export report" feature that are pure string
// / object building and therefore headless-testable:
//
//   flameSvg(tree, opts) — a STATIC inline icicle SVG (no d3) from an RPFlame
//       aggregated tree. CSS is embedded in a <style> element so the SVG is
//       self-contained (mirrors seqdiagram's self-contained export). The live
//       flamegraph's d3 zoom is intentionally dropped for the static artifact.
//   mermaid(unit, opts) — the ENRICHED Mermaid sequenceDiagram (autonumber,
//       activation bars, TMM/VM box grouping, per-return self-µs, per-event
//       Note). Replaces analysis.js's old minimal arrow list.
//   toJSON(o) — the structured JSON data export (records + cycles + summary).
//   htmlDoc(o) — assembles the final self-contained HTML report string from
//       pre-rendered parts (CSS + section HTML + an optional JSON data island).
//
// The DOM-bound stitching (rendering the live SeqDiagram / CyclesView / SourceMap
// off-screen, fetching app.css) lives in analysis.js; everything testable is here.
(function () {
  'use strict';

  // ---- escaping -------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function stripPart(v) { return String(v == null ? '' : v).replace(/^\/[^/]+\//, ''); }
  function round(n) { return (n == null || !isFinite(n)) ? 0 : Math.round(n); }

  // ===========================================================================
  // flameSvg — static icicle (root on top, children below; width ∝ inclusive µs)
  // ===========================================================================
  var FLAME_CSS = [
    '.rpf{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}',
    '.rpf-bg{fill:#ffffff}',
    '.rpf-frame-tmm{fill:#5eead4;stroke:#0d9488;stroke-width:.5}',
    '.rpf-frame-vm{fill:#fdba74;stroke:#ea580c;stroke-width:.5}',
    '.rpf-frame-root{fill:#cbd5e1;stroke:#94a3b8;stroke-width:.5}',
    '.rpf-label{font-size:10px;fill:#1e293b;pointer-events:none}'
  ].join('');

  // Class for a frame from its base/domain.
  function frameClass(node) {
    if (node._base === 'ROOT') { return 'rpf-frame-root'; }
    return node._domain === 'VM' ? 'rpf-frame-vm' : 'rpf-frame-tmm';
  }

  // Lay the tree out into flat {x,y,w,h,depth,label,title,cls} rects. Children
  // are placed left-to-right within their parent's x-range, each sized by its
  // share of the parent width; leftover (self time) shows as the gap at the right.
  function layout(tree, W, H) {
    var rects = [];
    var maxDepth = 0;
    var total = tree.value > 0 ? tree.value : 1;
    var scale = W / total;
    function place(node, x, depth) {
      var w = Math.max(node.value * scale, 0);
      if (depth > maxDepth) { maxDepth = depth; }
      var selfUs = node._self != null ? node._self : 0;
      var title = (node._base === 'ROOT' ? node.name : stripPart(node.name)) +
        ' — ' + round(node.value) + ' µs incl · ' + round(selfUs) + ' µs self' +
        (node._count ? ' · ' + node._count + '×' : '');
      rects.push({
        x: x, depth: depth, w: w, h: H,
        cls: frameClass(node),
        label: node._base === 'ROOT' ? node.name : stripPart(node.name),
        title: title
      });
      var cx = x;
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        place(kids[i], cx, depth + 1);
        cx += Math.max(kids[i].value * scale, 0);
      }
    }
    place(tree, 0, 0);
    return { rects: rects, height: (maxDepth + 1) * H };
  }

  // opts: { width, rowH }
  function flameSvg(tree, opts) {
    opts = opts || {};
    var W = opts.width || 1100;
    var H = opts.rowH || 18;
    if (!tree) { return ''; }
    var lay = layout(tree, W, H);
    var parts = [];
    parts.push('<svg class="rpf" xmlns="http://www.w3.org/2000/svg" width="' + W +
      '" height="' + lay.height + '" viewBox="0 0 ' + W + ' ' + lay.height + '">');
    parts.push('<style>' + FLAME_CSS + '</style>');
    parts.push('<rect class="rpf-bg" x="0" y="0" width="' + W + '" height="' + lay.height + '"/>');
    for (var i = 0; i < lay.rects.length; i++) {
      var r = lay.rects[i];
      if (r.w < 0.5) { continue; }
      var y = r.depth * H;
      parts.push('<g><title>' + esc(r.title) + '</title>');
      parts.push('<rect class="' + r.cls + '" x="' + r.x.toFixed(1) + '" y="' + y +
        '" width="' + r.w.toFixed(1) + '" height="' + (H - 1) + '" rx="1"/>');
      // Only draw a label if it plausibly fits (≈6px/char at 10px).
      var maxChars = Math.floor((r.w - 6) / 6);
      if (maxChars >= 2) {
        var txt = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + '…' : r.label;
        parts.push('<text class="rpf-label" x="' + (r.x + 3).toFixed(1) + '" y="' +
          (y + H - 6) + '">' + esc(txt) + '</text>');
      }
      parts.push('</g>');
    }
    parts.push('</svg>');
    return parts.join('');
  }

  // ===========================================================================
  // mermaid — enriched sequenceDiagram for a single selected unit (flow/event)
  // ===========================================================================
  // unit: { roots, recs, label }
  // opts: { cycleByEvent } — optional { eventName: avgCycles } authoritative map.
  function mermaid(unit, opts) {
    opts = opts || {};
    var cyc = opts.cycleByEvent || {};
    var out = ['sequenceDiagram', '  autonumber'];
    // Users sits outside the boxes; TMM vs TCL VM are grouped (call order means
    // Command is TMM again after the VM hop, so it gets its own TMM box — two
    // TMM boxes is fine and keeps the left-to-right call order intact).
    out.push('  participant Users');
    out.push('  box rgb(224,242,241) TMM');
    out.push('    participant Event');
    out.push('    participant Rule');
    out.push('  end');
    out.push('  box rgb(255,237,213) TCL VM');
    out.push('    participant RuleVM');
    out.push('    participant CommandVM');
    out.push('  end');
    out.push('  box rgb(224,242,241) TMM');
    out.push('    participant Command');
    out.push('  end');

    var spans = window.RPModel.flatten(unit.roots);
    var recs = (unit.recs || []).filter(function (r) { return r.kind === 'ENTRY' || r.kind === 'EXIT'; });
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      var node = findSpan(spans, r);
      if (!node) { continue; }
      var self = node.lifeline;
      var caller = node.parent ? node.parent.lifeline : 'Users';
      var label = (node.base === 'RULE' || node.base === 'RULE_VM') ? stripPart(node.value) : node.value;
      if (r.kind === 'ENTRY') {
        out.push('  ' + caller + '->>+' + self + ': ' + mlabel(label));
      } else {
        var selfUs = node.realExecTime != null ? round(node.realExecTime) : null;
        var retLbl = selfUs != null ? (selfUs + 'µs self') : 'return';
        out.push('  ' + self + '-->>-' + caller + ': ' + retLbl);
        if (node.base === 'EVENT') {
          var note = node.value + (node.raw != null ? ' · ' + round(node.raw) + 'µs total' : '');
          if (cyc[node.value] != null) { note += ' · ' + round(cyc[node.value]) + ' cyc'; }
          out.push('  Note over Event: ' + mlabel(note));
        }
      }
    }
    return out.join('\n');
  }
  function findSpan(spans, r) {
    for (var i = 0; i < spans.length; i++) {
      var n = spans[i];
      if ((n.entryRec && n.entryRec.i === r.i) || (n.exitRec && n.exitRec.i === r.i)) { return n; }
    }
    return null;
  }
  // Mermaid message text can't contain a literal semicolon/newline; keep it tame.
  function mlabel(s) { return String(s == null ? '' : s).replace(/[\n;]+/g, ' ').replace(/:/g, '∶'); }

  // ===========================================================================
  // toJSON — structured data export (pretty-printed JSON string)
  // ===========================================================================
  // o: { version, generatedAt, label, sessionId, scope, summary, cpu, cycles,
  //      commands, records }
  function toJSON(o) {
    o = o || {};
    var doc = {
      tool: 'rultracer',
      version: o.version || null,
      generatedAt: o.generatedAt || null,
      session: { label: o.label || null, id: o.sessionId || null, scope: o.scope || null },
      summary: o.summary || null,
      cpu: o.cpu || null,
      cycles: o.cycles || null,
      commandStats: o.commands || null,
      records: o.records || []
    };
    return JSON.stringify(doc, null, 2);
  }

  // ===========================================================================
  // htmlDoc — assemble the self-contained HTML report
  // ===========================================================================
  // o: { title, generatedAt, css, headerHtml, sections:[{id,title,html}], json }
  function htmlDoc(o) {
    o = o || {};
    var sections = o.sections || [];
    var body = [];
    body.push('<div class="rpt-wrap">');
    body.push(o.headerHtml || '');
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      if (!s || !s.html) { continue; }
      body.push('<section class="rpt-sec" id="rpt-' + esc(s.id) + '">');
      body.push('<h2 class="rpt-h">' + esc(s.title) + '</h2>');
      body.push('<div class="rpt-body">' + s.html + '</div>');
      body.push('</section>');
    }
    body.push('</div>');

    var doc = [];
    doc.push('<!DOCTYPE html>');
    doc.push('<html lang="en"><head><meta charset="utf-8">');
    doc.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
    doc.push('<title>' + esc(o.title || 'rultracer report') + '</title>');
    if (o.css) { doc.push('<style>' + o.css + '</style>'); }
    doc.push('<style>' + REPORT_CSS + '</style>');
    doc.push('</head><body class="rpt">');
    doc.push(body.join('\n'));
    if (o.json) {
      doc.push('<script type="application/json" id="rultracer-data">' +
        String(o.json).replace(/<\//g, '<\\/') + '</script>');
    }
    doc.push('</body></html>');
    return doc.join('\n');
  }

  // Report chrome — layered ON TOP of the app's inlined app.css so the reused
  // CyclesView / SourceMap DOM keeps its styling, with report-specific framing.
  var REPORT_CSS = [
    'body.rpt{background:#f1f5f9;margin:0;padding:24px;color:#0f172a;',
    'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}',
    '.rpt-wrap{max-width:1180px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;',
    'border-radius:10px;padding:28px 32px;box-shadow:0 1px 3px rgba(15,23,42,.08)}',
    '.rpt-title{font-size:22px;font-weight:700;margin:0 0 4px}',
    '.rpt-sub{color:#64748b;font-size:13px;margin:0 0 18px}',
    '.rpt-meta{border-collapse:collapse;font-size:13px;margin:0 0 8px}',
    '.rpt-meta td{padding:2px 14px 2px 0;vertical-align:top}',
    '.rpt-meta td:first-child{color:#64748b;white-space:nowrap}',
    '.rpt-sec{margin:26px 0 0;padding:18px 0 0;border-top:1px solid #e2e8f0}',
    '.rpt-h{font-size:16px;font-weight:700;margin:0 0 10px}',
    '.rpt-body svg{max-width:100%;height:auto}',
    '.rpt-body .seq-canvas,.rpt-body .flame-canvas,.rpt-body .cy-output{overflow:visible}'
  ].join('');

  window.RPReportData = {
    flameSvg: flameSvg,
    mermaid: mermaid,
    toJSON: toJSON,
    htmlDoc: htmlDoc,
    esc: esc
  };
})();
