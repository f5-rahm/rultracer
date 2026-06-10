// rultracer execution model. Browser-only (ES6+).
//
// Reimplements campfire's ENTRY/EXIT pairing + NestNode hierarchy + duration
// math in JS. Per flowId we LIFO-pair entries with exits into spans, attach
// singletons (bytecodes, var mods) to the open span as ordered points, and
// compute self-time (realExecTime = raw - sumChildren).
//
// v1 is single-TMM (the VE test box had one TMM): we ignore ctxId and partition
// purely by flowId. A later phase wraps this with a per-TMM partition.
(function () {
  'use strict';

  const PAIRABLE = { EVENT: 1, RULE: 1, RULE_VM: 1, CMD_VM: 1, CMD: 1 };

  function makeNode(rec) {
    return {
      base: rec.base,
      kind: 'span',
      value: rec.value,
      lifeline: rec.lifeline,
      domain: rec.domain,
      flowId: rec.flowId,
      entryRec: rec,
      exitRec: null,
      tsEntry: rec.tsMicros,
      tsExit: null,
      raw: null,          // total wall time (us): tsExit - tsEntry
      sumChildren: 0,     // sum of direct child raw times (us)
      realExecTime: null, // self time (us): raw - sumChildren
      children: [],       // nested spans
      points: [],         // singletons (bytecodes, var mods) in order
      parent: null,
      unmatched: false
    };
  }

  // Build a forest of spans for one ordered list of records (a single flow).
  function buildFlow(flowId, recs) {
    const roots = [];
    const stack = [];
    const warnings = [];

    const top = () => (stack.length ? stack[stack.length - 1] : null);

    for (const rec of recs) {
      if (rec.kind === 'SINGLETON') {
        const host = top();
        const point = {
          base: rec.base, value: rec.value, lifeline: rec.lifeline,
          tsMicros: rec.tsMicros, rec: rec,
          varName: rec.varName, varValue: rec.varValue
        };
        if (host) { host.points.push(point); }
        else { (roots._orphanPoints || (roots._orphanPoints = [])).push(point); }
        continue;
      }

      if (rec.kind === 'ENTRY') {
        if (!PAIRABLE[rec.base]) { warnings.push({ reason: 'unexpected ENTRY base', rec }); }
        const node = makeNode(rec);
        const parent = top();
        if (parent) { node.parent = parent; parent.children.push(node); }
        else { roots.push(node); }
        stack.push(node);
        continue;
      }

      // EXIT: ideally the open span on top matches. If not (suspension/resume,
      // dropped lines) search down for the nearest matching open span and flag
      // the spans we skip past.
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].base === rec.base && stack[k].value === rec.value) { idx = k; break; }
      }
      if (idx === -1) {
        warnings.push({ reason: 'EXIT with no open ENTRY', rec });
        continue;
      }
      // Close any spans above the match as unmatched (they never got an EXIT).
      for (let k = stack.length - 1; k > idx; k--) {
        stack[k].unmatched = true;
        warnings.push({ reason: 'ENTRY without matching EXIT', rec: stack[k].entryRec });
      }
      const node = stack[idx];
      node.exitRec = rec;
      node.tsExit = rec.tsMicros;
      node.raw = rec.tsMicros - node.tsEntry;
      stack.length = idx; // pop the match and everything above it
    }

    // Any spans still open at end of stream are unmatched.
    for (const open of stack) {
      open.unmatched = true;
      warnings.push({ reason: 'ENTRY still open at end of trace', rec: open.entryRec });
    }

    return { flowId, roots, warnings };
  }

  // Post-order: compute sumChildren + realExecTime for every span in a forest.
  function computeDurations(nodes) {
    for (const node of nodes) {
      computeDurations(node.children);
      let sum = 0;
      for (const c of node.children) { if (c.raw != null) { sum += c.raw; } }
      node.sumChildren = sum;
      node.realExecTime = (node.raw != null) ? Math.max(0, node.raw - sum) : null;
    }
  }

  // Flatten a forest in pre-order (spans only) — useful for tables/indices.
  function flatten(nodes, out, depth) {
    out = out || [];
    depth = depth || 0;
    for (const node of nodes) {
      node.depth = depth;
      out.push(node);
      flatten(node.children, out, depth + 1);
    }
    return out;
  }

  // Collapse consecutive bytecode points into runs for compact rendering.
  // Returns groups: { type:'bytecode', count, items:[point], tsStart, tsEnd }
  // for runs, or { type:'point', item } for var mods / lone singletons.
  function groupPoints(points) {
    const groups = [];
    let run = null;
    for (const p of points) {
      if (p.base === 'CMD_BYTECODE') {
        if (!run) { run = { type: 'bytecode', count: 0, items: [], tsStart: p.tsMicros, tsEnd: p.tsMicros }; groups.push(run); }
        run.items.push(p); run.count++; run.tsEnd = p.tsMicros;
      } else {
        run = null;
        groups.push({ type: 'point', item: p });
      }
    }
    return groups;
  }

  function build(records) {
    // Partition by flowId, preserving ts order (records arrive pre-sorted).
    const byFlowRecs = new Map();
    for (const rec of records) {
      if (!byFlowRecs.has(rec.flowId)) { byFlowRecs.set(rec.flowId, []); }
      byFlowRecs.get(rec.flowId).push(rec);
    }

    const flows = [];
    const warnings = [];
    const eventIndex = new Map(); // eventName -> [event span nodes]

    for (const [flowId, recs] of byFlowRecs) {
      const res = buildFlow(flowId, recs);
      computeDurations(res.roots);
      const first = recs[0];
      const flow = {
        flowId,
        roots: res.roots,
        recs,
        remoteIp: first.remoteIp, remotePort: first.remotePort,
        localIp: first.localIp, localPort: first.localPort,
        tsStart: recs[0].tsMicros, tsEnd: recs[recs.length - 1].tsMicros,
        eventCount: res.roots.length
      };
      flows.push(flow);
      for (const w of res.warnings) { warnings.push(Object.assign({ flowId }, w)); }
      // index every EVENT-rooted span by event name
      for (const node of flatten(res.roots)) {
        if (node.base === 'EVENT') {
          if (!eventIndex.has(node.value)) { eventIndex.set(node.value, []); }
          eventIndex.get(node.value).push(Object.assign({ flowId }, { node }));
        }
      }
    }

    flows.sort((a, b) => a.tsStart - b.tsStart);

    return {
      flows,
      byFlow: new Map(flows.map((f) => [f.flowId, f])),
      eventIndex,
      events: Array.from(eventIndex.keys()),
      warnings,
      tsRange: {
        min: records.length ? records[0].tsMicros : 0,
        max: records.length ? records[records.length - 1].tsMicros : 0
      }
    };
  }

  window.RPModel = { build, buildFlow, computeDurations, flatten, groupPoints };
})();
