// rultracer trace parser. Browser-only (ES6+; never runs in restnoded).
//
// Turns raw rule-profiler text into structured occurrence records. Handles two
// input shapes:
//   1. Full /var/log/ltm lines WITH the syslog prefix (the bundled fixture,
//      capture "path B", or a hand-pasted log):
//        May 29 11:26:29 host info tmm[22555]: 1780079189187194,RP_EVENT_ENTRY,...
//   2. Prefix-stripped lines as written to a session's raw.csv by capture.js:
//        1780079189187194,RP_EVENT_ENTRY,...
//
// Confirmed TMOS 17.1 VE format: exactly 12 CSV fields, NO trailing field, and
// field 0 (tsMicros) is microseconds since the Unix epoch (~1.78e15 — within
// Number.MAX_SAFE_INTEGER, so plain Number math is exact).
(function () {
  'use strict';

  // "...tmm[pid]: " or multi-TMM "...tmm0[pid]: " program tag. We split on this
  // to recover the CSV payload; bare RP_ lines (no prefix) pass through.
  const PREFIX_RE = /tmm\d*\[\d+\]:\s+/;

  // CSV field order (post prefix-strip).
  const F = {
    TS: 0, OCC: 1, VS: 2, VALUE: 3, CTX: 4, FLOW: 5,
    RIP: 6, RPORT: 7, RRD: 8, LIP: 9, LPORT: 10, LRD: 11
  };

  // base occurrence type -> which side of the TMM/VM boundary it lives on.
  const DOMAIN = {
    EVENT: 'TMM', RULE: 'TMM', CMD: 'TMM',
    RULE_VM: 'VM', CMD_VM: 'VM', CMD_BYTECODE: 'VM', VAR_MOD: 'VM'
  };

  // base occurrence type -> diagram lifeline. Bytecodes and var mods execute in
  // the rule's VM frame, so they render as ticks on the RuleVM lifeline.
  const LIFELINE = {
    EVENT: 'Event', RULE: 'Rule', CMD: 'Command',
    RULE_VM: 'RuleVM', CMD_VM: 'CommandVM',
    CMD_BYTECODE: 'RuleVM', VAR_MOD: 'RuleVM'
  };

  // Split RP_<TYPE>_(ENTRY|EXIT) into a base type + kind. Singletons
  // (RP_CMD_BYTECODE, RP_VAR_MOD) have no ENTRY/EXIT suffix.
  function classify(occType) {
    let t = occType.replace(/^RP_/, '');
    let kind = 'SINGLETON';
    if (/_ENTRY$/.test(t)) { kind = 'ENTRY'; t = t.slice(0, -6); }
    else if (/_EXIT$/.test(t)) { kind = 'EXIT'; t = t.slice(0, -5); }
    return { base: t, kind: kind };
  }

  // Recover the "<ts>,RP_..." payload from a line whether or not it carries the
  // syslog prefix. Returns null for lines with no RP_ payload.
  function payload(line) {
    const parts = line.split(PREFIX_RE);
    const csv = parts.length > 1 ? parts[parts.length - 1] : line;
    return /^\d+,RP_/.test(csv.trim()) ? csv.trim() : null;
  }

  function parse(text) {
    const lines = String(text || '').split(/\r?\n/);
    const records = [];
    const errors = [];
    const flowSet = Object.create(null);
    const eventSet = Object.create(null);
    let minTs = Infinity;
    let maxTs = -Infinity;

    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      if (!line.trim()) { continue; }
      const csv = payload(line);
      if (!csv) {
        // Non-RP lines are expected noise in a raw /var/log/ltm paste; only
        // flag lines that look like they were meant to be occurrences.
        if (/RP_/.test(line)) { errors.push({ lineNo: n + 1, reason: 'no RP_ payload', text: line }); }
        continue;
      }
      const f = csv.split(',');
      if (f.length < 12) { errors.push({ lineNo: n + 1, reason: 'expected 12 fields, got ' + f.length, text: line }); continue; }
      const ts = parseInt(f[F.TS], 10);
      if (isNaN(ts)) { errors.push({ lineNo: n + 1, reason: 'non-numeric timestamp', text: line }); continue; }

      const c = classify(f[F.OCC]);
      const rec = {
        i: records.length,
        tsMicros: ts,
        rawType: f[F.OCC],
        base: c.base,
        kind: c.kind,
        domain: DOMAIN[c.base] || 'TMM',
        lifeline: LIFELINE[c.base] || 'Event',
        vs: f[F.VS],
        value: f[F.VALUE],
        ctxId: f[F.CTX],
        flowId: f[F.FLOW],
        remoteIp: f[F.RIP], remotePort: f[F.RPORT], remoteRd: f[F.RRD],
        localIp: f[F.LIP], localPort: f[F.LPORT], localRd: f[F.LRD]
      };
      if (c.base === 'VAR_MOD') {
        const eq = rec.value.indexOf('=');
        if (eq !== -1) { rec.varName = rec.value.slice(0, eq); rec.varValue = rec.value.slice(eq + 1); }
      }
      if (c.base === 'EVENT' && c.kind === 'ENTRY') { eventSet[rec.value] = true; }
      flowSet[rec.flowId] = true;
      if (ts < minTs) { minTs = ts; }
      if (ts > maxTs) { maxTs = ts; }
      records.push(rec);
    }

    // Stable sort by timestamp (ties keep original order via index) so a paste
    // that interleaves flows still pairs correctly downstream.
    records.sort((a, b) => (a.tsMicros - b.tsMicros) || (a.i - b.i));

    return {
      records: records,
      errors: errors,
      meta: {
        totalLines: lines.length,
        parsed: records.length,
        flowIds: Object.keys(flowSet),
        events: Object.keys(eventSet),
        minTs: records.length ? minTs : 0,
        maxTs: records.length ? maxTs : 0
      }
    };
  }

  window.RPParser = { parse, classify, FIELDS: F, DOMAIN, LIFELINE };
})();
