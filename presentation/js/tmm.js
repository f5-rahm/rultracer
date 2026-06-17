// rultracer multi-TMM partition seam. Browser-side, but kept strictly
// Node-6.9.1-safe (ES5: var / function only, no arrow / const / template
// literals) so test/phase6.js can exercise it under the on-box restnoded
// Node as well as headless JavaScriptCore.
//
// Ground truth (4-TMM VE, background info/rultracer-solo_test_4-raw.csv —
// 4,525 occurrences / 141 flows): the logical TMMs are worker THREADS of one
// tmm process (shared pid 11313), so the syslog "tmm[pid]:" prefix is the same
// for all of them and useless for splitting. The per-TMM key is field 5
// (ctxId) = the worker-thread id (main thread == pid; here 11313/11670/11673/
// 11674). A flow pins to exactly one TMM (flow handles are unique within the
// shared-memory process — verified: 0/141 flows spanned two ctxIds), so
// (ctxId, flowId) is a robust composite key; ctxId alone is sufficient here.
//
// ctxIds are opaque thread ids, so we sort them ascending and label TMM 0..N
// (lowest == main thread). The raw ctxId is preserved on every partition for
// hover/tooltip display. On real multi-blade hardware the partition key may
// instead live in the prefix (tmmN[pid]) — RPParser.PREFIX_RE already matches
// that form; a future build can swap the key source without touching callers.
(function () {
  'use strict';

  // Numeric-ascending comparison of two ctxId strings (they are decimal thread
  // ids on every observed platform); falls back to lexical for non-numeric ids.
  function cmpCtx(a, b) {
    var na = parseInt(a, 10);
    var nb = parseInt(b, 10);
    if (isNaN(na) || isNaN(nb)) { return a < b ? -1 : (a > b ? 1 : 0); }
    return na - nb;
  }

  // partition(records) -> [{ ctxId, index, label, records, flowCount, occCount }]
  // ordered by ascending ctxId (TMM 0..N). Records within each TMM keep their
  // incoming order (the parser pre-sorts by timestamp), so RPModel.build can
  // consume a partition's records unchanged.
  function partition(records) {
    records = records || [];
    var byCtx = Object.create(null);
    var order = [];
    var i;
    for (i = 0; i < records.length; i++) {
      var c = records[i].ctxId;
      c = (c === undefined || c === null) ? '' : String(c);
      if (!byCtx[c]) { byCtx[c] = []; order.push(c); }
      byCtx[c].push(records[i]);
    }
    order.sort(cmpCtx);

    var tmms = [];
    for (i = 0; i < order.length; i++) {
      var recs = byCtx[order[i]];
      var flows = Object.create(null);
      var nFlows = 0;
      for (var k = 0; k < recs.length; k++) {
        var fl = recs[k].flowId;
        if (!flows[fl]) { flows[fl] = true; nFlows++; }
      }
      tmms.push({
        ctxId: order[i],
        index: i,
        label: 'TMM ' + i,
        records: recs,
        flowCount: nFlows,
        occCount: recs.length
      });
    }
    return tmms;
  }

  // flowTmmMap(tmms) -> { flowId: 'TMM n' } so the interleaved view can badge
  // each flow with the TMM it belongs to (flows pin to one TMM). Last writer
  // would win on the theoretical cross-TMM handle reuse other platforms might
  // show; on this platform every flow maps to exactly one TMM.
  function flowTmmMap(tmms) {
    var map = Object.create(null);
    for (var i = 0; i < tmms.length; i++) {
      var recs = tmms[i].records;
      for (var k = 0; k < recs.length; k++) { map[recs[k].flowId] = tmms[i].label; }
    }
    return map;
  }

  window.RPTmm = { partition: partition, flowTmmMap: flowTmmMap, cmpCtx: cmpCtx };
})();
