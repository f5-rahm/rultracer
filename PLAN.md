# rultracer — iRules Debugger iApps LX Extension

## Context

iRule performance/behavior debugging on BIG-IP today means inserting `log` statements, reloading config, and re-running traffic — slow and lossy. TMOS 13.1+ shipped a passive tracer, `ltm rule-profiler`, that emits per-occurrence execution traces without touching the script. But it is **tmsh-only**, has **no GUI**, and its raw CSV output is hard to interpret — especially the back-and-forth handoffs between TMM (the traffic microkernel) and the embedded TCL VM, which is exactly where iRule inefficiency hides.

**rultracer** wraps rule-profiler in an iApps LX extension that runs **on the BIG-IP**: it configures the profiler, captures the trace stream, and serves it to a browser SPA that parses and visualizes it as an interactive UML-style sequence diagram (TMM↔TCL VM crossings), a step-through debugger (variables + commands over time), flamegraphs, cycle-vs-CPU stats, and an exportable report.

This builds on two prior projects: **rulbased** (github.com/f5-rahm/rulbased — the author's iApps LX patterns: worker auto-discovery, tmsh-via-bash writes, filesystem version store, RPM packaging, hard-won gotchas) and **campfire** (github.com/f5devcentral/campfire — an abandoned Python tool whose ENTRY/EXIT pairing, NestNode hierarchy, duration math, and folded-stack→flamegraph *algorithms* we reimplement in JS).

**Outcome:** a deployable, self-contained on-box tool that turns rule-profiler from a CLI power-user feature into a visual iRules debugger/profiler.

---

## How rule-profiler works (the system we're wrapping)

- A tmsh config object `ltm rule-profiler <name>` with **no native REST endpoint** — the worker runs `tmsh` **directly** (restnoded is root on the box) via `child_process.execFile('tmsh', ['-c', '<command>'], {env:{HOME:'/var/tmp'}})`; no REST `/util/bash` round-trip and no shell, so brace-lists need no escaping. Fields: `vs-filter`, `rule-filter`, `event-filter`, `occ-mask`, `period` (ms), `publisher`, `state`; lifecycle `state enabled` + `start`/`stop`.
- Emits CSV **occurrence** lines through a configured **log publisher**:
  `tsMicros, occType, vs, occValue, tmmPid, flowId(hex), remoteIp, remotePort, remoteRd, localIp, localPort, localRd, <trailing numeric>`
- Occurrences span two domains that pass control back and forth: **TMM side** = `EVENT`, `RULE`, `CMD`; **TCL VM side** = `RULE_VM`, `CMD_VM`, `BYTECODE`; plus `VAR_MOD`. Most are `_ENTRY`/`_EXIT` pairs; `BYTECODE`/`VAR_MOD` are singletons. `occValue` carries the event/rule/command name, `var=value`, or bytecode op.
- **Constraints (load-bearing for design):** output is **buffered** (delayed flush — on buffer-full, period-timer expiry, or `stop`); **TMM-scoped** (duplicate line set per TMM process); a **period timer** bounds it (small default); it's **lab-only** (adds TMM overhead); and **native-command return values are NOT in the trace** unless captured into a variable (then visible via `VAR_MOD`).

### Confirmed trace format (TMOS 17.1 VE capture, May 2026 — see `background info/example-logs.txt`)

Real `/var/log/ltm` line:
`May 29 11:26:29 bigip02.f5demo.com info tmm[22555]: 1780079189187194,RP_EVENT_ENTRY,/Common/testvip-http,CLIENT_ACCEPTED,22623,0x70373707000576,10.1.10.6,36086,0,10.1.10.50,80,0`

- **Syslog prefix** precedes the CSV and must be stripped: `<Mon DD HH:MM:SS> <host> <sev> tmm[<pid>]: `. (On multi-TMM hardware the tag is typically `tmmN[...]`; the VE shows bare `tmm[...]`.)
- **CSV = exactly 12 fields, NO trailing field** (the articles' apparent 13th field does not appear on 17.1 VE): `tsMicros, occType, vs, occValue, ctxId, flowId(hex), remoteIp, remotePort, remoteRd, localIp, localPort, localRd`.
- **Timestamps are microseconds since Unix epoch** (`1780079189187194`µs ≈ 2026-05-29). Durations come from **timestamp deltas**, not a cycle field — Goal 7 converts µs→cycles via CPU clock and reconciles with `ltm rule stats`.
- Field 5 (`ctxId`, here `22623`) differs from the prefix `tmm[pid]` (`22555`); treat as a TMM/context id and revisit its exact meaning on multi-TMM hardware.
- Capture validates clean ENTRY/EXIT nesting and the **TMM↔TCL VM round trip per native command**: `RULE_VM_ENTRY → BYTECODE(push/invokeStk) → CMD_VM_ENTRY IP::client_addr → CMD_ENTRY → CMD_EXIT → CMD_VM_EXIT → BYTECODE(storeScalarStk) → VAR_MOD cip=10.1.10.6`. `CMD` (TMM-native) nests **inside** `CMD_VM` (VM) — every command is a VM→TMM→VM crossing. `VAR_MOD` carries the stored value (`cip=10.1.10.6`), confirming the Goal-6 caveat.
- One flowId (`0x70373707000576`) spans both events (CLIENT_ACCEPTED then HTTP_REQUEST) → **flowId is the natural per-connection grouping key**; the VE run was single-TMM.

---

## Locked decisions (from clarifying Q&A)

| Area | Decision |
|---|---|
| Runtime | iApps LX extension on the BIG-IP; target **TMOS 17.1+**. **restnoded Node.js is 6.9.1 → worker code is strict ES5** |
| Heavy lifting | **Browser-side**: SPA parses + visualizes; on-box Node worker only configures/captures/persists/serves |
| Capture target | A **dedicated per-session file** the worker produces (see capture mechanism) |
| Logging chain | **Hybrid**: detect usable existing publisher, else offer to create; **always tear down on teardown/uninstall** — never leave tracing enabled |
| occ-mask | **No defaults** — UI forces explicit selection of every occurrence type |
| Capture window | Period **presets + custom field**; bounding supports **both** manual stop and auto-stop-at-period |
| Multi-TMM | **Deferred to a later phase** (VE test was single-TMM). v1 assumes one TMM and groups by flow/event; eventual design: group by `tmmPid`, single-TMM default, interleaved/raw, + trace layering/overlay (needs multi-TMM hardware to validate) |
| Primary viz (goal 4) | Interactive **custom SVG/D3 sequence diagram** (the `uml_rendering_trace.png` style) + **Mermaid export** of a selected single-TMM span |
| Step-through (goal 6) | **Linked** table + timeline scrubber + sequence diagram (cross-highlight); variable values + native-command results over time |
| Navigation | **Configurable** grouping: flow id / event / TMM |
| Source mapping | Fetch iRule via `/mgmt/tm/ltm/rule`, annotate source per event handler (**best-effort**, no line numbers in trace) |
| Persistence | Persist named sessions with **retention cap** (default ~20 sessions AND ~500 MB, prune oldest, adjustable) |
| Test traffic | Built-in **HTTP sender** + in-UI guidance for driving complex patterns externally |
| UI stack | **Vanilla JS, libs vendored (D3, d3-flame-graph), no build step** (rulbased pattern) |
| License/home | **f5devcentral, Apache-2.0**; vendor only permissive deps |
| Name | **rultracer** |

---

## Viability of all 8 goals

All 8 are viable. Two require honest scoping caveats:

1. **Set up rule profiler (VS/events/publisher)** — ✅ Viable. REST enumeration of VS/rules/events + tmsh-via-bash config + hybrid publisher chain.
2. **Syslog listener on localhost → file in extension subdirs** — ✅ Viable, **mechanism adjusted, confirmed on VE.** A restnoded-bound syslog listener is risky (single-threaded, data-plane-sensitive) and a `local-syslog` publisher always routes to `/var/log/ltm`, not an arbitrary file. Confirmed: a publisher with the built-in `local-syslog` destination (`sys log-config publisher rule_profiling_pub { destinations { local-syslog { } } }`) writes `RP_` lines to `/var/log/ltm` prefixed with `… tmm[pid]:`. The robust path: the worker offset-tails `/var/log/ltm` and extracts only this session's `RP_` lines (prefix-stripped) into a dedicated per-session `raw.csv`. The *outcome* (a dedicated parseable file the tool owns) is fully achieved. Optional power-user "clean file" mode via a `sys syslog include` rule.
3. **Log parser** — ✅ Viable. Browser-side JS reimplementation of campfire's pairing/hierarchy/duration algorithm.
4. **Visualize TMM↔TCL VM traces** — ✅ Viable. Custom D3 sequence diagram with crossing arrows; Mermaid export for sharing a slice.
5. **Flamegraph** — ✅ Viable (Phase 3). `d3-flame-graph` from NestNode→folded stacks; diff support for layering.
6. **Step through native-command + variable data** — ✅ Viable with caveat. **Variable values are reliable** (via `VAR_MOD`); **native-command return values are only observable when stored into a variable** — the raw trace does not carry e.g. the literal `HTTP::host` result otherwise. v1 surfaces variable state + command invocation sequence/timing; command return values are best-effort where the trace reflects them.
7. **Cycle stats vs CPU** — ✅ Viable (Phase 4), pending live-box verification of the trailing field's meaning; combines trace timing + `/mgmt/tm/sys` CPU (core count/clock) + existing `ltm rule stats`.
8. **Export report** — ✅ Viable (Phase 5). Self-contained HTML + JSON/folded/CSV raw data.

---

## Architecture

**On-box RestWorkers** (Node, `nodejs/lib/`, restnoded auto-discovers `.js`; reads via iControl REST to `localhost:8100`, writes config by **exec'ing `tmsh` directly** (root, no shell — see below); `onStart` is single-arg `function(success)`):

- **InventoryWorker** `/mgmt/shared/rultracer/inventory` — GET VS (`/mgmt/tm/ltm/virtual`), iRules + event names (`/mgmt/tm/ltm/rule`, parse `when <EVENT>`), publishers/destinations, and (Phase 4 stub) CPU info.
- **ProfilerWorker** `/mgmt/shared/rultracer/profiler` — the capture state machine; publisher detect/create; start/stop; offset bookkeeping; `RP_`-line extraction; finalize `raw.csv`; **guaranteed idempotent teardown**.
- **SessionWorker** `/mgmt/shared/rultracer/sessions` — session CRUD, stream `raw.csv`, retention pruning, purge endpoint.
- **TrafficWorker** `/mgmt/shared/rultracer/traffic` — built-in HTTP request sender at a target VS.
- **uiWorker** `/mgmt/shared/rultracer/ui` — serves the static SPA + vendored libs.

**Shared `nodejs/lib/` helpers:** `tmsh.js` (`child_process.execFile('tmsh', ['-c', cmd], {env:{HOME:'/var/tmp'}})` — no shell, so no escaping; validate interpolated object names; capture stderr/exit code), `iremote.js` (REST GET client), `logchain.js` (publisher detect/create/teardown + optional syslog include), `capture.js` (offset tail + `RP_` extraction), `store.js` (session store + retention, content-addressed blobs + `manifest.json` + `audit.jsonl`, rulbased pattern).

**SPA** (`presentation/`, vanilla JS modules): views = Setup, Capture, Sessions, Analysis. Analysis sub-panels = sequence diagram, step-through (table + scrubber), source-map, multi-TMM/layering controls, grouping selector. Modules: `api.js`, `parser.js`, `model.js`, `seqdiagram.js`, `stepthrough.js`, `sourcemap.js`; vendored `d3.min.js`, `d3-flame-graph.min.js`/`.css`.

### Capture flow / state machine (ProfilerWorker)
`IDLE → CONFIGURING (validate non-empty occ-mask, resolve/create publisher, create profiler disabled, record /var/log/ltm byte offset) → ARMED (state enabled) → CAPTURING (start; optional traffic) → STOPPING (manual stop OR explicit stop at period) → FLUSHING (poll /var/log/ltm tail until byte count stable across ~3 polls or timeout) → FINALIZED (extract RP_ lines → raw.csv; delete profiler; tear down created chain; write manifest) → PARSED (browser)`. ERROR/ABORT from any state → idempotent `teardown()`. A startup reconciliation sweep deletes orphaned `rultracer_*` profilers so a crash never leaves tracing on.

### Capture mechanism (resolved)
Default **path A**: publisher→`local-syslog`→`/var/log/ltm`; record byte offset at `state enabled`; after flush read `[offset, EOF)`, keep lines where field[1] matches `^RP_` AND match this session's filters/time window; write verbatim to `data/sessions/<id>/raw.csv`. Only one active capture at a time (worker lock). Optional **path B** (settings flag): a `sys syslog { include "filter match(\"RP_\"); → file(/var/log/rultracer/...) " }` rule the worker creates and guarantees to restore on teardown.

### Browser parser (parser.js / model.js)
First **strip the syslog prefix** (`/^.*\btmm\[\d+\]:\s+/`), then split the 12-field CSV. Per-occurrence record `{tsMicros, occType, vs, occValue, ctxId, flowId, remote*, local*, domain, kind}` where `tsMicros` is epoch microseconds, `domain∈{TMM,VM}` (EVENT/RULE/CMD→TMM; RULE_VM/CMD_VM/BYTECODE→VM), `kind∈{ENTRY,EXIT,SINGLETON}` (BYTECODE/VAR_MOD are SINGLETON). Within each `flowId` stream, LIFO-stack pairing builds spans with `rawExecTime = exit.ts − entry.ts` (µs), `sumChildren = Σ child raw`, `realExecTime = raw − sumChildren` (self time); singletons attach to the open span as ordered point children; unmatched entries/exits are flagged (suspension/resume can repeat CMD). Build a generic **NestNode** forest `EVENT>RULE>RULE_VM>{CMD_VM>CMD, BYTECODE, VAR_MOD}` per flow (this same tree feeds Phase-3 folded stacks). Expose indices by `flowId` and event name for the grouping selector. **v1 = single-TMM** (VE was single-TMM): ignore `ctxId`/per-TMM partitioning; **multi-TMM grouping, interleaving, and trace layering/overlay are a later phase** (need multi-TMM hardware) — eventual design partitions by TMM (prefix `tmmN`/`ctxId`), builds a forest per TMM, and exposes `singleTmm()`/`interleaved()`/`layers([...])`.

### D3 sequence diagram (seqdiagram.js)
Lifelines L→R: Users · Event · Rule · Command (TMM) ‖ RuleVM · CommandVM (TCL VM), with a visual gutter at the boundary. y = scaled `tsMicros`. Paired spans → activation bars; crossing arrows drawn from pairs (RULE→RULE_VM, CMD_VM→CMD labeled with command name, and symmetric returns); BYTECODE/VAR_MOD as VM-side ticks. `d3.zoom` pan/zoom, hover tooltip, click-to-select. A shared `selectionState` (timestamp/span id) links scrubber + table + diagram (cross-highlight); the table replays VAR_MOD/CMD up to the cursor to show current variable values + latest command results. `toMermaid(span)` (single-flow entry/exit slice) stubbed for Phase 5.

### Persistence (store.js)
`/var/config/rest/iapps/rultracer/data/`: `sessions/<id>/{manifest.json, raw.csv|blob ref, parsed.json?}`, `blobs/<sha256>`, `audit.jsonl`, `settings.json` (`retentionMaxSessions:20`, `retentionMaxBytes:524288000`, `capturePath:"A"|"B"`). Manifest records config, publisher `{reused,created}`, syslog-include backup (path B), capture `{startOffset, startWallclock, flowIds, lineCount, bytes, status}`, artifacts, and teardown flags. Prune oldest on finalize until both caps satisfied.

### Packaging / deploy
RPM via `build/build-rpm.sh` (dynamic `.spec`, noarch; `%files` = `nodejs/`, `presentation/`, `manifest.json` with `{"tags":["IAPP"]}`). Install: upload to `/var/config/rest/downloads/` then `POST /mgmt/shared/iapp/package-management-tasks {operation:INSTALL,...}`, poll task to `FINISHED`. Gotchas (rulbased): `HOME=/var/tmp` for tmsh; `cp`-then-`chown --reference` into restnoded dirs (never `mv`); no stray temp files in `nodejs/lib/`. **Worker JS is strict ES5 (Node 6.9.1): no const/let/arrow/template-literals; implement `_mkdirp` (no `fs.mkdir` recursive); decimal file modes (`420`) not octal (`0o644`).** UNINSTALL + a purge endpoint reverse every `created/mutated` object across all manifests.

---

## Phased plan

- **Phase 1 — Capture core (v1, goals 1–2).** Helper libs (`tmsh`,`iremote`,`logchain`,`capture`,`store`); InventoryWorker; ProfilerWorker state machine (path A + flush detection + guaranteed teardown); SessionWorker + retention; TrafficWorker; Setup/Capture/Sessions SPA views; RPM build + install/uninstall. **Deliverable:** configure profiler → bounded capture → `raw.csv` + manifest → clean teardown.
- **Phase 2 — Parse + sequence + step-through (v1, goals 3,4,6). ✅ DELIVERED v0.2.0 (tag `phase2`).** `parser.js`/`model.js` (prefix-strip, pairing, durations, NestNode — single-TMM, flow/event grouping); `seqdiagram.js` sequence diagram with crossings; `stepthrough.js` linked table+scrubber w/ variable/command replay; `sourcemap.js` best-effort annotation; grouping selector. **Deliverable:** full v1 usable debugger. *See "Phase 2 delivery & lessons" at the end of this doc for what shipped, addendums (custom SVG instead of D3, call-order lifelines, timing modes, source-coverage rework, modal loader, SVG/PNG export), and lessons learned.*
- **Phase 3 — Flamegraph + diff (goal 5). ✅ DELIVERED v0.3.0 (tag `phase3`).** NestNode→`RPFlame` → vendored d3 + d3-flame-graph flamegraph (aggregated/literal, scope-driven) + a two-capture diff (differential/side-by-side); step-through scroll/control fixes shipped alongside. Seam: `toFolded()`. *See "Phase 3 delivery & lessons" at the end of this doc.*
- **Phase 4 — Cycles-vs-CPU stats (goal 7). ✅ CODE COMPLETE v0.4.0 (headless-validated; on-box validation + tag `phase4` pending).** Reframed during clarifying Q&A: the **authoritative cycles are `ltm rule stats`** (per-event hardware counters), not the rule-profiler trace — the trace µs is overhead-inflated and serves as the per-command source + reconcile comparand. CPU budget = Σ all-core MHz × 1e6 (DevCentral "Evaluating Performance" gist convention). New **Stats** sub-tab with Reset/Snapshot orchestration (user drives the high-volume traffic), snapshot persisted into `manifest.cycles`. Seam used: `SourceMap.commandStats`-style rollup reimplemented in the pure `cycles.js`. *See "Phase 4 delivery & lessons" at the end of this doc.*
- **Phase 5 — Reports + Mermaid export (goal 8). ✅ DELIVERED v0.5.0 (tag `phase5`, on-box validation pending).** Self-contained HTML report (chooser: scope + panel checkboxes) with a hand-rolled static icicle SVG (no d3), the existing self-contained sequence SVG, and the reused Stats/Source DOM; JSON data export; enriched Mermaid (activations, TMM/VM boxes, autonumber, per-event cycle notes). Folded stacks already shipped in Phase 3. New pure seam `reportdata.js`. *See "Phase 5 delivery & lessons" at the end of this doc.*
- **Phase 6 — Multi-TMM & trace layering (deferred from goal-7/viz). ✅ DELIVERED v0.6.0 (tags `phase6` / `phase6.1`; on-box validated).** Pure `RPTmm.partition` seam (by `ctxId`, TMM 0..N by sort); TMM scope dropdown (single-TMM default / interleaved) scoping the flow/event grouping; interleaved flow badges; report TMM chooser; bundled 4-TMM example. Stats stays whole-box. The **diff stays capture-vs-capture** (per-TMM diffs were prototyped and removed; v6.1 added a Clear button + saved-session loader). The `tmmN[pid]` prefix / trailing-field questions remain deferred to real multi-blade hardware. *See "Phase 6 delivery & lessons" at the end of this doc.*
- **Phase 7 — Wrap-up / polish. ✅ DELIVERED v0.7.1 (tag `phase7`, on-box validated).** Inline bytecode opcode tooltips (new pure `opcodes.js` seam — native SVG `<title>` on each bytecode tick + the panel table rendered from one shared map); CSS consolidation (design tokens / shared table+badge rules / global `[hidden]` / `.btn-sm`); security hardening (session-id path-traversal guard, status-badge XSS fix, `tmsh.runBash` contract + `capture.js` path quoting); cleanup pass (dead `API.cpuInfo`, archived phase prompts). *(The earlier docs-only slice was tagged `phase7-docs` at v0.7.0.)*
  - Other deferred polish as it accrues.
- **Phase 8 — Bytecode disassembler. ✅ DELIVERED v0.8.0 (tag `phase8`, on-box validated).** A `tcl::unsupported::disassemble`-backed scratchpad folded into the renamed **"Bytecode reference & disassembler"** panel (now a two-column layout — opcode reference left, disassembler right): paste Tcl → the box's own bytecode, raw-text or structured-table view (checkbox toggle), opcodes cross-linked to the expanded `opcodes.js`. Compile-only; run as the uid-198 worker via `execFile('tclsh')` (NOT the root channel); **opt-in (settings toggle, default OFF)**. Explicitly staying **0.x** until substantial real-world feedback/use. *See "Phase 8 — Bytecode disassembler (spec)" + the "Phase 8 delivery & lessons" at the end of this doc.*

Seams to leave from the start: generic NestNode/folded generation; keep parsing TMM-agnostic so a TMM partition can wrap it later; stub CPU inventory, Mermaid export, and flamegraph tab so later phases are additive, not refactors.

---

## Critical files (to create)

- `nodejs/lib/ProfilerWorker.js` — capture state machine, flush detection, teardown (the core).
- `nodejs/lib/logchain.js` — hybrid publisher detect/create + optional syslog include (path A/B).
- `nodejs/lib/tmsh.js` — direct `tmsh` exec wrapper (`execFile`, `HOME=/var/tmp`, name validation, stderr capture).
- `nodejs/lib/capture.js` — `/var/log/ltm` offset-tail + `RP_` extraction (handle log rotation).
- `nodejs/lib/store.js` — session store + retention.
- `presentation/js/parser.js` — CSV → paired occurrences → NestNode + durations + multi-TMM.
- `presentation/js/seqdiagram.js` — D3 sequence diagram + scrubber/table linkage.
- `build/build-rpm.sh`, `manifest.json` — packaging.

Reusable references: rulbased's worker-discovery, tmsh-via-bash, version-store, and `build-rpm.sh` patterns; campfire's `initHelp`/`logrule`/`svgHelp` algorithms (pairing, NestNode, folded stacks) — reimplemented in JS, not copied (campfire is Python 3.6).

---

## Risks / live-box verification (TMOS 17.1+)

1. **Node/JS version** — CONFIRMED **Node 6.9.1** on the box → worker code must be strict ES5 (rulbased constraints apply: no const/let/arrow/template-literals, no `fs.mkdir` recursive, decimal file modes). No longer an unknown; baked into the build.
2. **Timing source** — RESOLVED on 17.1 VE: **no trailing/cycle field**; the 12th field is local routing-domain and timestamps are **epoch microseconds**. Durations = µs deltas; Phase 4 converts µs→cycles via CPU clock and reconciles with `ltm rule stats`. (Re-check whether multi-blade hardware appends a trailing field.)
3. **Multi-TMM** — **resolved 2026-06-17 on a 4-TMM VE** (full ground-truth capture at `background info/rultracer-solo_test_4-raw.csv`, 4,525 occurrences / 141 flows / all 4 TMMs); build is Phase 6. Findings: the 4 logical TMMs are **threads of one process** (shared pid 11313), so the syslog prefix stays bare `tmm[pid]` and the **partition key is field 5 (`ctxId`) = the per-TMM worker-thread id** (capture shows all 4 distinct values `11313`/`11670`/`11673`/`11674` — main thread == pid; earlier single-TMM VE had `ctxId 22623 ≠ pid 22555`, i.e. a thread id, not the pid and not a 0–3 index). **A flow pins to one TMM** — no flowId spanned two `ctxId`s across all 141 flows → key the partition by `(ctxId, flowId)`. UI label heuristic: sort `ctxId` ascending → `TMM 0..N`. The parser already carries `record.ctxId` (`parser.js:94`). **Still deferred to real multi-blade hardware** (separate `tmm` processes): whether the prefix becomes `tmmN[pid]`, whether a trailing 13th CSV field appears, and the per-TMM start "alert" text.
4. **Syslog routing** — CONFIRMED `local-syslog`→`/var/log/ltm` with a `… tmm[pid]:` prefix. For optional path B confirm the exact program/facility tag and that `include` + `tmsh save sys config` persists/restores; ensure offset-tail survives logrotate (size shrink → reopen).
5. **tmsh invocation** — RESOLVED: worker execs `tmsh -c "…"` directly (root, `execFile`, no shell) so brace-lists need no escaping; no REST `/util/bash` path. Remaining care: `HOME=/var/tmp`, validate interpolated object names, capture stderr/exit code. Confirmed real sequence: `create … event-filter add {…} vs-filter add {…} publisher …` → `modify … occ-mask {…}` → `modify … state enabled` → `start`/`stop`.
6. **Flush detection** — tune poll/stability/timeout so a slow flush isn't truncated.
7. **occ-mask encoding** — CONFIRMED brace-list form works (`occ-mask { cmd cmd-vm event rule rule-vm var-mod bytecode }`); numeric bitmask optional/unneeded.
8. **Concurrency** — enforce single active capture (worker lock).
9. **Privilege/partition** — confirm restnoded can create `rule-profiler` (and path-B `sys syslog include`); handle non-`/Common` names.
10. **Source-map fidelity** — command→handler match is ambiguous when a command repeats; accept and flag.

---

## Verification (end-to-end)

1. **Deploy:** `build/build-rpm.sh` → upload + install via package-management-tasks → confirm workers register (`GET /mgmt/shared/rultracer/inventory` returns VS list) and SPA loads at the uiWorker path.
2. **On-box facts (done — see `background info/example-*`):** Node 6.9.1, 12-field format, epoch-µs timestamps, `local-syslog`→`/var/log/ltm`, brace-list occ-mask, and direct `tmsh` exec all confirmed.
3. **Capture path:** in Setup pick a VS/rule/events, explicitly select occ-mask, set a period; Start; drive traffic with the built-in sender; Stop → confirm a finalized session with non-empty `raw.csv` and that the `rule-profiler` object + any created publisher are gone (`tmsh list ltm rule-profiler`, `... sys log-config publisher`).
4. **Parse/visualize:** open the session → sequence diagram renders TMM↔VM crossings; switch grouping (flow/event); scrub the timeline and confirm table + diagram cross-highlight and variable values update (e.g. `cip=10.1.10.6` at the right point); confirm source annotation maps fired commands to the right event handler.
5. **Multi-TMM (Phase 6, multi-TMM hardware):** confirm per-TMM grouping, single-TMM default, interleaved view, and overlay/layering of two TMMs.
6. **Safety/teardown:** uninstall → confirm no `rultracer_*` profilers or created logging objects remain; kill restnoded mid-capture → confirm the startup sweep removes the orphaned profiler.
7. **Retention:** create > cap sessions / exceed byte cap → confirm oldest pruned.
8. **Later phases:** Phase 3 flamegraph matches sequence-diagram self-times; Phase 4 cycle %-of-CPU reconciles with `ltm rule stats`; Phase 5 HTML report opens standalone with embedded visuals + raw data.

---

## Q&A log (decisions captured during planning)

- **Architecture** → Browser-side rendering (worker only configures/captures/serves).
- **Trace capture** → Dedicated local log file (worker-extracted; see capture mechanism).
- **Logging chain** → Hybrid: detect existing or offer to create.
- **Target scope** → TMOS 17.1+ (single device the extension is installed on).
- **occ-mask defaults** → None; everything explicitly selected in the UI.
- **Capture window** → Customizable period + presets.
- **Sample data** → Live 17.1+ box available for ground-truth capture.
- **Multi-TMM** → Group-by-TMM single view + interleaved/raw + layering. *(Deferred to Phase 6: VE test was single-TMM; needs multi-TMM hardware to build/validate.)*
- **Sequence view** → Custom SVG/D3 primary; Mermaid download for a selected single-TMM entry/exit span.
- **Flamegraph** → d3-flame-graph + diff support.
- **Step-through** → Table + scrubber + sequence, all linked.
- **Cycle stats** → Trace timing + sys CPU + `ltm rule stats`.
- **Capture flow** → Capture-then-analyze.
- **Persistence** → Persist with retention cap.
- **Trace structure** → Configurable grouping (flow / event / TMM).
- **Source mapping** → Fetch + best-effort annotate.
- **v1 scope** → Profiler setup+capture AND parse+sequence+step-through (must-have). Flamegraph, cycle/CPU stats, report = later phases.
- **Report format** → HTML + raw data (JSON/folded/CSV).
- **UI stack** → Vanilla JS, libs vendored, no build.
- **Test traffic** → Built-in HTTP sender primary + in-UI guidance for complex external patterns.
- **Capture bounding** → Both manual stop and auto-stop-at-period.
- **Distribution** → f5devcentral, Apache-2.0.
- **Retention** → Count (~20) + size (~500 MB) cap, adjustable.
- **Name** → rultracer.

---

## Phase 2 delivery & lessons (v0.2.0, tag `phase2`)

### Delivered (goals 3, 4, 6)
- **Parser** (`presentation/js/parser.js`) — strips the syslog prefix (`tmm\d*\[\d+\]:`), splits the 12-field CSV, classifies each occurrence (base / kind / domain / lifeline). Handles **both** prefixed input (fixture, `/var/log/ltm` paste) and the prefix-stripped lines `capture.js` writes to `raw.csv`. `tsMicros` fits in `Number` (no BigInt).
- **Model** (`model.js`) — per-`flowId` LIFO pairing → spans with `raw` / `sumChildren` / `realExecTime` (self time); NestNode forest; bytecode-run collapsing; flow/event indices. Flags `unmatched` spans and tolerates `CMD_VM` with no nested `CMD`.
- **Sequence diagram** (`seqdiagram.js`) — custom SVG. Lifelines in **call order** `Users·Event·Rule·RuleVM·CommandVM·Command` (every arrow a short adjacent step), stark **TMM (teal) / TCL-VM (orange)** contrast, violet TMM↔VM **handoff** arrows. Collapsible bytecodes, even-step ↔ "scale to time" toggle, **Timing** modes (Δ labels / hop brackets, total raw µs), drag-pan + zoom, **responsive** (re-renders to pane width), **SVG/PNG export** (diagram CSS embedded in the SVG so exports are self-contained).
- **Step-through** (`stepthrough.js`) — linked table + scrubber; replays `VAR_MOD` to show variable state + last command at the cursor. Dropped the redundant `lifeline` column; `Self (µs)` with tooltip.
- **Source coverage** (`sourcemap.js`) — per-(rule, event, command) stats `{count, totalRaw, totalSelf}`; green = fired (badged `µs·N×`), dimmed = command token present but not observed (branch not taken), yellow = ambiguous. Collapsible cards labelled with the rule name; legend; auto-annotate (live, debounced); cross-highlight with diagram/step.
- **Orchestration** (`analysis.js`) — flow/event grouping, trace dropdown, modal **Load trace** dialog (paste / bundled example / file: raw `.csv/.txt` or a `rultracer-sessions-*.json` backup → pick a session), Mermaid/SVG/PNG export, single-path cross-highlight.
- **Plumbing** — full-width Analysis view (cap moved off `main` to the form views); `.txt` MIME in `UiWorker`; bundled `presentation/fixtures/`; collapsed **Bytecode reference** panel (opcode table + the "compiled-to-bytecode" explanation + links to the Part 3 and Tcl-disassembler community articles). Version `0.2.0`; `test/phase2.js` zero-dep browser-logic harness.

### Addendums / deviations from the original plan
- **No D3 in Phase 2.** The diagram is hand-rolled SVG; the only D3 needs were scales/zoom which were trivial to hand-roll. **D3 + d3-flame-graph are introduced in Phase 3** where genuinely required.
- **Lifelines reordered to call order, no fixed TMM|VM gutter.** Original sketch grouped TMM left / VM right with a gutter; call-order + colour contrast reads better and keeps every arrow adjacent.
- **Source "map" became source "coverage"** with per-line timing, branch-taken dimming, and cross-highlight — richer than the planned best-effort annotation.

### Lessons learned
- **No JS runtime on the dev Mac.** Node lives only on-box. Validate pure/browser logic headless via **`osascript -l JavaScript`** (JavaScriptCore, ES6) with stubbed `window`/`document`, plus a Python cross-check for algorithms. Keep clientside code Node-6.9.1-safe (no optional chaining / nullish coalescing) so `test/phase2.js` also runs on-box.
- **Headless can't catch visual/interaction bugs.** The modal-stuck-open bug (`.modal{display:flex}` author rule overriding the UA `[hidden]{display:none}`, fixed with `.modal[hidden]{display:none}`) only showed in a real browser. Every visual change needs on-box eyes; budget a deploy+hard-refresh round-trip per iteration.
- **Embed diagram CSS inside the SVG** (`<style>` element) → single source of truth *and* self-contained SVG/PNG export for free.
- **Real captures are messy:** multi-flow, flush-window-truncated/unmatched spans, and `CMD_VM` with no nested `CMD`. The model must flag-and-continue, never assume clean nesting.
- **Source-map double-count:** every native command emits both `CMD_VM` and `CMD`; count by `CMD_VM` (canonical) to avoid 2×.
- **rule-profiler bytecode emits only the opcode mnemonic** — no operand/value. Tcl compiles some commands (`set`, `append`, …) straight to bytecode so they never appear as `CMD`. Values surface via `VAR_MOD` / `CMD_VM`; operands need Tcl's disassembler (documented in the Bytecode reference panel). Not a capture setting, not a parsing gap.
- **RPM `%files` lists every file explicitly** (macOS rpm) — adding a presentation module or fixture means updating both the staging copy and `%files` in `build/build-rpm.sh`.
- **Deploy loop:** `build-rpm.sh <ver> <rel>` → scp to `/shared/images/` → `install-onbox.sh <ver>-<rel>` (in-place upgrade preserves sessions); **hard-refresh** the browser (cached `app.css`/JS will mask changes).

---

## Phase 3 delivery & lessons (v0.3.0, tag `phase3`)

> Status: **SHIPPED.** Logic validated headless (`osascript` JSC + Python cross-check + `test/phase3.js`); the d3 view + step-through fixes validated on-box across iterations (final artifact `rultracer-0.3.0-0008.noarch.rpm`).

### Delivered (goal 5)
- **Flame seam** (`presentation/js/flame.js`, `window.RPFlame`) — pure, no DOM/d3, kept Node-6.9.1-safe. `toFlameUnit(unit)` (literal: one frame per span, an icicle of the selected flow/event) and `toFlameAgg(roots,label)` + `aggregate()` (merge identical call paths, sum inclusive µs + occurrence count). Value = **inclusive raw µs** (d3-flame-graph derives self = width − children); unmatched spans fall back to `sumChildren` so frames still nest. Scope helpers `rootsWhole/rootsByEvent/rootsByFlow`. `toFolded()` = Brendan-Gregg folded stacks carrying **leaf-self µs** (loss-free; Phase 5 report seam). `diffMerge(a,b)` = union of two aggregated trees sized by **B** with per-frame **self-time delta (B−A)**; `maxAbsDelta()` normalises colour.
- **Flame view** (`presentation/js/flamegraph.js`, `window.FlameView`) — wraps the vendored `flamegraph` global. Inverted icicle (root on top), built-in click-to-zoom, `transitionDuration(0)`. Two colour modes via `setColorMapper`: **domain** (teal `#14b8a6` TMM / orange `#ea580c` VM, matching the sequence diagram; root grey) and **diff** (white→red slower-in-B / white→blue faster-in-B, eased so small deltas read). `setLabelHandler` builds the tooltip (total/self µs, ×count, bytecode/var-mod counts, ⚠ unmatched; diff shows A→B + Δself).
- **Bytecode/VAR_MOD pruned from frames** — they are zero-duration SINGLETONs living in `node.points` (not `node.children`), so they are naturally excluded; their **counts** surface in the frame tooltip instead. (They stay fully visible in the sequence diagram + source coverage.)
- **Analysis sub-tabs** (`analysis.js` + `index.html`) — `Sequence | Flamegraph | Diff` switcher; the dense step-through + source-coverage panels stay under **Sequence**. **Flamegraph** tab: mode dropdown (aggregated ⇄ literal) + **mode-aware Scope dropdown** + reset-zoom + **Folded** download. **Diff** tab: **Load comparison…** (reuses the load modal via `state.loadTarget='B'` → paste / bundled example / sessions-`.json` backup) and a differential ⇄ side-by-side view toggle.
- **Scope is the single flamegraph control, mode-aware** — the Scope dropdown decides WHAT to chart (whole / per-event / per-flow); the Mode toggle decides HOW (aggregated single graph vs. literal one-graph-per-event stacked). The dropdown re-orders + re-defaults on a Mode toggle: **aggregated** leads with Whole capture (default); **literal** leads with By flow (default = first flow). Literal is decoupled from the top Trace dropdown / `selectUnit`.
- **Literal mode stacks one flamegraph per event vertically** (`FlameView.renderMany`), each graph's **width ∝ its event's duration** (left-aligned, 12% floor for legibility) so the stack keeps the relative-duration context a single combined graph shows by width. `RPFlame.toFlameNode` flames a single span as its own root.
- **Tooltip** spells out aggregation: `total Xµs · self Yµs · N occurrences (avg …)` (self = a frame's own time = width minus children; count = spans merged).
- **Step-through fixes (shipped alongside)** — replaced row `scrollIntoView` (which scrolled the *window* and lost the scrubber) with a contained `_scrollRowIntoView` inside the table's own box; same fix for source-coverage cross-highlight via `scrollWithin` (no-ops when the panel isn't its own scroller, so the page never jumps); **Prev/Next step buttons** (grouped right of the slider) + Arrow keys + a **sticky scrubber**; a **Follow diagram** toggle (`SeqDiagram.setFollow`) gating the auto-center so the diagram doesn't lurch when you don't want it to.
- **Vendored, no build step** — `presentation/vendor/`: `d3.v7.min.js` (v7.9.0, **ISC**), `d3-flamegraph.min.js` + `.css` (v4, **Apache-2.0**), `LICENSES.md`. Linked in `index.html` (css in `<head>`, js before the app modules); added to `build-rpm.sh` staging + `%files`. License stays permissive (f5devcentral / Apache-2.0). `UiWorker` already served `.js/.css`.
- **Plumbing** — version → `0.3.0` (`configProcessor.js`, `build-rpm.sh` default). `test/phase3.js` (zero-dep, Node-6.9.1-safe) covers literal/aggregate/fold/diff + the d3-flame-graph **nesting invariant** (parent.value ≥ Σ children).

### Addendums / deviations
- **Diff width is sized by the comparison profile (B) only**, coloured by self-time delta — this keeps d3-flame-graph's nesting invariant (`parent.value ≥ Σ children`) intact. Paths that exist only in A (fully removed in B) collapse to width 0 in the differential view; **side-by-side** is the way to see those. (Documented in `flame.js` `diffMerge`.)
- **TMM/VM twin doubling is intentional.** A command renders as `CMD_VM` then nested `CMD` (and `RULE`→`RULE_VM`) with the same label; the gap between the twins' widths *is* the TMM↔VM crossing overhead — the thing this tool exists to surface — so the flame keeps both rather than collapsing them (unlike the source-coverage CMD_VM-canonical de-dup).

### Lessons learned
- **d3-flame-graph v4 has no `differential()` toggle.** Its default colour reads `d.data.delta`; the diff workflow is `merge()`/`computeDelta()`. Rather than depend on the lib's internal merge, all merge/delta math lives in the pure `RPFlame` seam and both colourings are driven by an explicit `setColorMapper` — fully testable headless, no lib coupling.
- **Same headless constraint as Phase 2.** Validated `flame.js` via `osascript -l JavaScript` (JavaScriptCore) reading+eval'ing parser/model/flame + a Python cross-check of the duration arithmetic; `test/phase3.js` runs the same on-box under Node 6.9.1. The d3 **view** (`flamegraph.js`) is loaded only for syntax coverage — every visual/interaction aspect (tooltip wiring, icicle layout, zoom, white-surface contrast, side-by-side grid) still needs an on-box deploy + hard-refresh.
- **Vendored d3 is full (280 KB).** d3-flame-graph only needs a subset, but vendoring full d3 v7 is simpler and still permissive; revisit only if payload size matters on-box.
- **A flamegraph lays siblings out HORIZONTALLY by width — that's the data model.** "Stack vertically" therefore means *separate* flamegraphs, one per root; splitting re-normalises each to full width, so restore the cross-event duration cue by sizing each graph's width ∝ its duration.
- **`scrollIntoView` scrolls the *window*, not just a panel.** It walks every scrollable ancestor, so on a long page it yanks the whole window and pushes your controls off-screen. Scroll *within* the relevant box by setting its `scrollTop` directly (mirror `seqdiagram`), and make the helper a no-op when the element isn't its own scroller. This bit twice — step-table rows and source-coverage lines.
- **The `[hidden]` CSS-specificity trap RECURRED** (first seen as the Phase 2 `.modal[hidden]` bug): `.an-controls label { display:inline-flex }` out-specifies `[hidden]{display:none}`, so toggling the `hidden` attribute didn't hide the Scope label. Any element hidden via the `hidden` attribute needs a matching-or-higher-specificity `[hidden]{display:none}` rule wherever an author rule sets its `display`.
- **Don't couple a panel's behaviour to an unrelated control.** The flamegraph originally read the *top* Trace dropdown in literal mode while exposing its own Scope dropdown — selecting a scope appeared to do nothing. One control per concern (Scope = what, Mode = how), mode-aware defaults, beat two half-wired controls.
- **`grep` is wrapped/aliased oddly in this shell** (misses strings that are present) and BSD `grep` needs `-E` for `|` alternation. Use the Read tool / Python to search the tree.

### Deferred (scheduled for later phases)
- **Mermaid export enrichment → Phase 5 (reports).** Current `toMermaid` is a deliberate minimal arrow list. Mermaid *can* do much more (activation bars from spans, `Note over` for durations/var values, coloured `box` grouping for TMM vs VM, `autonumber`) — that enrichment is report-export work. Mermaid's genuine limits (no time-proportional spacing, no free-form crossing arrows / bytecode ticks, poor scaling) stay exclusive to the SVG/PNG export, so Mermaid remains best for a single event/flow slice.
- **Diff granularity.** The diff compares **whole-capture aggregated** A vs B only. Per-scope diffs (compare one event or flow across captures) are a possible future add; not needed for v1.
- **Literal whole-capture can stack many graphs** (one per event execution across the capture — 20 for the sample session). Left intentionally uncapped; per-flow/per-event scope is the focused view and is the literal default. Capping/collapsing repeats is a possible later polish.
- **Inline bytecode opcode hints** remain a Phase 7 polish item (the flamegraph surfaces bytecode *counts* in tooltips; per-opcode meaning still lives only in the collapsed Bytecode reference panel).

---

## Phase 4 delivery & lessons (v0.4.0 — code complete, on-box validation + tag `phase4` pending)

> Status: **logic validated headless** (JavaScriptCore + Python arithmetic cross-check; `test/phase4.js` mirrors it for on-box Node 6.9.1). The DOM view (`cyclesview.js`) is smoke-tested for render-without-throw only — tables/badges/layout still need an on-box deploy + hard-refresh. The live REST/tmsh paths (CPU MHz, rule-stats envelope, reset-stats) are **unverified on the box** — see "Live-box unknowns" below.

### The reframing (the important part)
Clarifying Q&A flipped the data model from what the kickoff prompt assumed. The user's [iRules Runtime Calculator gist](https://gist.github.com/jasonrahm/f65b3db4280c34bbf23daaaf3b2874e0) (the DevCentral "Evaluating Performance" approach) established that:
- **`ltm rule stats` is the authoritative cycle source** — per **event** it reports `minCycles`/`avgCycles`/`maxCycles` + `totalExecutions`, measured by TMM's own hardware counters. These are accurate ONLY under a high-volume run (100k+ connections) with the **rule-profiler OFF**, because the profiler's syslog logging inflates timings.
- **The rule-profiler trace (µs deltas) is NOT the cycle source** — it's overhead-distorted. It remains the only **per-command** view (rule stats stop at event granularity) and the **reconcile comparand**: the gap between authoritative avgCycles and trace-derived avgCycles *is* the profiler overhead, surfaced honestly.
- **CPU budget = Σ every core's MHz × 1e6** (whole-box), so `%CPU/request = cycles / cpuHz`, `µs = cycles × 1e6 / cpuHz`, `maxReqPerSec = cpuHz / cycles`. Matched to the gist deliberately (locked decision: "Match the gist (all-core budget)").

### Locked decisions (Phase 4 Q&A)
| Question | Decision |
|---|---|
| Timing-test scope | **Orchestrate only** — Reset/Snapshot buttons; the USER drives the 100k+ traffic with any load tool (ab/wrk/…). rultracer never generates the load (on-box generation would compete with TMM and skew the very cycles being measured). |
| %CPU denominator | **Match the gist** — whole-box budget (Σ all-core MHz). |
| Persist | **Into the manifest** — snapshot writes `manifest.cycles`, so a session (and a backup `.json`) carries its cycle data; works offline + feeds the Phase 5 report. |
| Granularity | **Summed + avg/occurrence** per rule/event/command. |
| Placement | **New `Stats` sub-tab** (`Sequence \| Flamegraph \| Diff \| Stats`). |

### Delivered (goal 7)
- **`presentation/js/cycles.js`** (`window.RPCycles`) — the PURE seam (no DOM/d3), Node-6.9.1-safe so `test/phase4.js` runs on-box. `parseCpuinfo`/`cpuFromMhz`, the four gist conversions (`cyclesToMicros`/`microsToCycles`/`pctCpuPerReq`/`maxReqPerSec`), `ruleStatsRows` (authoritative table per rule), `traceEventStats` + `traceCommandStats` (trace-derived rollups; commands counted by **CMD_VM** canonical to avoid the 2× CMD double-count, matching source coverage), and `reconcile` (authoritative vs trace avgCycles + overhead Δ%, surfacing trace-only events rather than dropping them).
- **`presentation/js/cyclesview.js`** (`window.CyclesView`) — DOM view: a standing **caveat banner** (where the numbers come from, profiler-OFF requirement), per-rule **authoritative tables**, a **reconcile table** with a Δ-overhead badge (ok ≤25% / warn ≤100% / bad >100%), and a **trace-derived per-command table** (flagged overhead-inflated/relative; µs-only when no CPU snapshot yet).
- **`nodejs/lib/cpustats.js`** (ES5, shared by both workers) — `cpuInfo()` (reads `/proc/cpuinfo` cpu MHz via `tmsh.runBash`, sums×1e6), `ruleStats(name)` (`GET /mgmt/tm/ltm/rule/<enc>/stats` → per-event), `resetStats(name)` (`tmsh reset-stats ltm rule <name>`), `snapshot(names)` (CPU + per-rule stats + `takenAt`).
- **Worker endpoints** — `InventoryWorker`: `GET /inventory/cpu`, `GET /inventory/rule-stats?rule=`. `SessionWorker`: `POST /sessions/<id>/cycles { action:'reset'|'snapshot', rules:[...] }` (snapshot persists `manifest.cycles`). `api.js`: `cpuInfo`/`ruleStats`/`resetStats`/`snapshotCycles`.
- **Wiring** — `analysis.js` Stats sub-tab; rule names derived from the trace's RULE/RULE_VM spans; Reset/Snapshot **enabled only for a live saved session** (`state.sessionId`) — pasted/backup traces still **display** persisted `manifest.cycles` (read-only). `app.js` passes `sessionId` + `cycles` from the session manifest into `loadRaw`.
- **Plumbing** — version → `0.4.0` (`configProcessor.js`, `build-rpm.sh`); `cpustats.js` / `cycles.js` / `cyclesview.js` added to `%files` (macOS rpm lists every file). `test/phase4.js` (zero-dep, Node-6.9.1-safe) + Python cross-check.

### Live-box unknowns to verify on first deploy (DO NOT assume)
1. **`/proc/cpuinfo` exposes `cpu MHz` on the 17.1 VE.** Some VMs omit it or report a throttled/variable freq. Fallback if absent: `lscpu` or `/mgmt/tm/sys/hardware`. (The gist used `/proc/cpuinfo` on real hardware.)
2. **`ltm rule stats` REST envelope + field names** — `entries[url].nestedStats.entries` with `eventType.description`, `totalExecutions/minCycles/avgCycles/maxCycles{.value}`. Confirm on the box; `parseRuleStats` skips rows without `eventType` (the rule-level aggregate).
3. **`tmsh reset-stats ltm rule <name>`** form and that restnoded (via util/bash root) is allowed to run it.
4. The DOM view's tables/badges/`[hidden]` behaviour — watch the recurring `[hidden]` specificity trap and the `scrollIntoView`-scrolls-window trap if the Stats tables become their own scroll box.

---

## Phase 4.1 — the coupled "Run Test" workflow (v0.4.1 — CODE COMPLETE, on-box validation pending)

> Status: **code complete as v0.4.1, headless syntax-validated, NOT yet committed/tagged or on-box validated.** Phase 4 shipped the cycles *primitives* (reset / snapshot / rule-stats / CPU facts) and a Stats view, but as **three disconnected manual actions** — and the Stats tab was a dead end because its Reset/Snapshot buttons require a live `state.sessionId` that only exists *after* a profiler capture. Phase 4.1 sequences cycles collection and profiler capture into one guided test. The design below records the locked decisions; the **Implemented** subsection at the end records what shipped.

### The reframe (corrects a Phase 4 assumption)
Phase 4 treated authoritative-cycles collection and profiler-trace capture as **independent** flows. They are not — they are **two ordered phases of one test**, and the order is a *correctness constraint*, not a preference:

> `ltm rule stats` are authoritative ONLY when measured with the rule-profiler **OFF** (the profiler's syslog logging inflates the counters). Therefore the cycles window (reset → load → snapshot) must complete **before** the profiler is ever enabled. Snapshotting after a profiler run contaminates the authoritative number.

The profiler run that follows is a *small* run whose trace is the per-command view and the reconcile comparand — never the authoritative cycle source.

### The canonical 8-step sequence
1. **Reset** the rule-under-test stats (`cpustats.resetStats`) — zeroes the counters, scoping the window.
2. **High-volume load** (≈200k requests, profiler OFF) — see *Load generation* below.
3. **Snapshot** authoritative cycles (`cpustats.snapshot` → `manifest.cycles`) — CPU facts + per-event rule stats.
4. **Enable** the rule-profiler (`engine.start`).
5. **Small run** (default 25 connections, user-configurable) to populate the trace.
6. **Disable** the rule-profiler (`engine.stop`).
7. **Collect** the profiler logs (`engine.stop` already reads `/var/log/ltm`, extracts, writes raw).
8. **Finalize** the session for analysis (already done by `engine.stop`).

Steps 1+3 are the **cycles phase**; steps 4–7 are the **trace phase**. A test may run **either phase alone or both** (locked: "either as an option or both together").

### Architecture decision — browser-orchestrated, session created up front
- **The browser drives the sequence** by calling existing endpoints in order. Rejected a server-side state machine: the external-load pause (step 2) would force the server into an "awaiting-load" waiting-state plus a "continue" signal endpoint — i.e. reinventing browser coordination with extra server state and indefinite timers. The pause is trivial in the UI (it just sits between snapshot and profiler-start until the user clicks **Continue**).
- **Safety net stays server-side.** `CaptureEngine`'s `safetyMaxMs` timer + startup orphan-sweep already guarantee the profiler is torn down even if the tab closes mid-run — so browser orchestration is crash-safe.
- **The session is created at step 1, not step 4.** This is the key wiring fix. Today `engine.start` calls `store.createSession`; for the coupled flow the session must exist *before* the cycles phase so the early snapshot persists into it (losing a 200k-request snapshot to a tab reload is unacceptable, so we persist early rather than holding it in browser memory). `engine.start` gains an optional `cfg.sessionId`: when present it **attaches** to that session instead of creating one. Both phases then write into one manifest.

### UX — one "Run Test" panel with two toggles
- ☑ **Authoritative cycles** (reset → *[load]* → snapshot)
- ☑ **Profiler trace** (enable → N conns → disable → collect)

Both on = full 8 steps; either alone = that half. On Start the session shell is created; the Stats tab then reads its live data path (finally non-empty). Pasted/backup traces keep displaying persisted `manifest.cycles` read-only, as today.

### Load generation — per-run choice (locked decision)
The high-volume load source is chosen **per run**:
- **External + pause/confirm (default).** rultracer never generates it. After reset, the UI pauses with load instructions; the user drives ab/wrk/etc. off-box, then clicks **Continue** to snapshot. Matches the original "orchestrate only" decision and keeps the measurement clean (on-box generation competes with TMM and inflates the cycles being measured).
- **On-box generation (explicit override).** For quick/dirty runs where purity doesn't matter, allow rultracer to fire the load itself. **Open work this requires** (do not assume the current `TrafficWorker` suffices): (a) the **100-request cap** must be raised/parameterized for a high-volume mode; (b) `TrafficWorker` currently fires **serially** (recursive `fire()`), so 200k serial requests would be unusably slow — a high-volume mode needs bounded concurrency; (c) surface a standing **skew warning** in the UI whenever this mode feeds an authoritative snapshot.
- The **small profiler run** (step 5, default 25) always uses the built-in `TrafficWorker` (well under the 100 cap) regardless of the high-volume choice.

### Required changes (contained)
- `engine.start`: accept optional `cfg.sessionId` → attach instead of create; manifest status lifecycle gains a pre-profiler phase (e.g. `measuring`).
- A way to create the session shell at step 1 (reuse `store.createSession` via a `SessionWorker` POST, or a thin "begin test" call) and to run `reset`/`snapshot` against it (the `/cycles` endpoints already key by session id).
- `TrafficWorker`: high-volume mode (raised/parameterized cap + bounded concurrency); keep the ≤100 serial path for the small run.
- SPA: the Run-Test orchestrator (sequence + pause/confirm + two toggles), the small-run count prompt (default 25), and wiring the Stats tab to the live session.

### Deferred / open
- Manifest shape for carrying both `cycles` and trace in one session is already partly there (`manifest.cycles` + raw); confirm the combined-run manifest needs no new top-level fields beyond a test-config record.
- Whether to re-reset/re-snapshot is **out** — the single pre-profiler snapshot is the authoritative one by construction.
- This is **Phase 4.1**; it does not change the Phase 5 (reports + Mermaid) ordering — reports consume whatever `manifest.cycles` + trace a coupled run produces.

### Implemented (v0.4.1)
- **`engine.start` attaches** — accepts optional `cfg.sessionId`; when present it `updateManifest`s the existing shell to `configuring` instead of `createSession`, so the pre-profiler snapshot lands in the same manifest the trace finalizes.
- **`SessionWorker`** — `POST /sessions/begin { config, name }` creates the shell in status `measuring` and returns `{ sessionId }`; `POST /sessions/<id>/cycles { action:'finalize' }` marks a cycles-only run `finalized` (handled before the rules guard since it needs no rule list).
- **`TrafficWorker`** — `highVolume` mode raises the cap (100 → 1,000,000) and fires with bounded concurrency (default 20, clamp [1,200]) via a `pump()`/`fireOne()` runner, returning an aggregate `{ sent, ok, failed, statuses }` summary; the default ≤100 **serial** path (and its per-request `results[]`) is unchanged for the small profiler run.
- **`api.js`** — `beginTest`, `finalizeSession`; `sendTraffic` already passes `highVolume`/`concurrency` through.
- **SPA orchestrator (`app.js`)** — `runTest()` replaces `startCapture()`: validate → `beginTest` → (cycles: `reset` → external pause+**Continue** or on-box `sendTraffic` → `snapshot`) → (trace: `startCapture` with `sessionId` → existing Stop/poll finalizes; else `finalize`). New `state.testPhase`/`state.testFlow`; the engine-state poll early-returns during the `cycles` phase so it can't wipe the banner or toggle Stop. The small profiler-run default is **25** (`t-count`).
- **Markup/CSS** — Setup gains **Test phases** (cycles / trace toggles) + **High-volume load** (external default / on-box override with VIP+count+concurrency + skew warning); Capture gains the `#cycles-phase` pause banner. `.cycles-banner` sets `display:flex` so it carries an explicit `[hidden]{display:none}` (the recurring specificity trap); `#cycles-opts`/`#onbox-opts` hide safely because `.field` sets no `display`.
- **Plumbing** — version → `0.4.1` (`configProcessor.js`, `build-rpm.sh`). No new files, so `%files` is unchanged.

### Implemented follow-on (Setup restructure + whole-VS aggregate)
- **Setup reordered mode-first** — **Test phases** moved to the top; **VS + iRules stay always-visible** (both phases need the rule selection — cycles reads each rule's `ltm rule stats`). The profiler-only fields (Events, Occurrence types, Capture period, Stop mode, Log publisher) carry a `trace-only` class and hide for a cycles-only test via `syncTracePhase()`; `syncPubModeUi` now also honours the trace toggle (pub-select + its no-publisher warning suppressed when trace is off). `.trace-only[hidden]{display:none}` re-asserts over `.field.inline`'s `display:flex` (the recurring specificity trap). Header/labels reworded ("Configure a test").
- **Max req/s is now per-request only (conceptual fix).** req/s is inherently a *per-request* metric — a request runs *every* event, so its cost is the **sum** of the per-event cycles, and `max req/s = clock ÷ Σ avg cost` (e.g. CLIENT_ACCEPTED 9,082 + HTTP_REQUEST 38,309 = 47,391 cyc → 194K/s). A per-event req/s ("if the box did only this event") is a hypothetical that never happens and reads *higher* than the real combined limit — which is exactly why the total looked smaller than its parts (additive serial cost: total throughput is below even the slowest event, like painting+drying stages). So the view now shows req/s **only on the Total / request row** (and the aggregate card); per-event cells show `—`, with a sub-line explaining why. (Earlier interim step had unified everything on `avgReqPerSec`, but per-event req/s is misleading regardless, so it's omitted.)
- **Stats table styling** — full cell-divider grid (`border` on every `th`/`td`) and centered header labels; the `cy-total` divider uses the accent colour.
- **Whole-VS aggregate** — the Stats page already renders **per-rule** Authoritative + Reconcile tables (and a per-rule "Total / request" row); it now also shows a **headline aggregate** when ≥2 rules are snapshotted. `RPCycles.aggregate(ruleStats, cpuHz)` (pure, tested in `test/phase4.js`) sums each rule's per-request cost (Σ avgCycles across its events) into whole-VS cycles/µs/%CPU/max-req-s plus each rule's share. **Flat sum** — assumes each event fires once per representative request; the caveat is printed in the section sub-line (execution-weighted is a deferred follow-on, the data's already in the snapshot).

### On-box validation checklist (v0.4.1, do FIRST)
1. **Trace-only** run still works end-to-end (the unified `beginTest`→attach path must match old behaviour); session lists + analyzes as before.
2. **Cycles-only, external** — reset → pause banner → drive load → Continue → snapshot → finalize; session shows in Sessions, analyze → Stats shows authoritative numbers, other panes empty/gracefully handle no raw.
3. **Cycles + trace, external** — both phases in one session; Stats + Sequence/Flamegraph all populated; reconcile table compares authoritative vs trace.
4. **On-box high-volume** — small count first (e.g. 500) to confirm the `pump()` concurrency runner terminates and returns the summary; watch restnoded memory under larger counts.
5. The `[hidden]` behaviour of `#cycles-opts`/`#onbox-opts`/`#cycles-phase` (toggle each), and that the cycles-phase poll-gating doesn't strand the Stop button.

---

## Phase 5 delivery & lessons (v0.5.0, tag `phase5` — on-box validation pending)

> Status: **logic validated headless** (JavaScriptCore via `osascript` + a Python cross-check of the icicle width math; `test/phase5.js` mirrors it for on-box Node 6.9.1). The visual/serialization aspects (serialized SVG fonts/`xmlns`, Blob sizing on large traces, the modal `[hidden]` toggle, inlined-CSS fidelity) still need an on-box deploy + hard-refresh.

### Clarifying Q&A (locked decisions, drove the build)
| Question | Decision |
|---|---|
| Report scope | **Chooser at export time** — whole capture vs a specific flow/event. |
| Panels | **Checkbox chooser** — Sequence / Flamegraph / Stats / Source coverage. |
| Flamegraph in the offline report | **Hand-roll a static icicle SVG** from the `RPFlame` seam (no d3) — fully self-contained, dodges the live-d3 computed-styles/font/`xmlns` gotcha. Interactive zoom is intentionally dropped for the static artifact. |
| Formats shipped | **Self-contained HTML + JSON + enriched Mermaid.** CSV is **out** for v1; **folded** stacks already shipped in Phase 3 and stay as-is. |
| Entry point | An **Export report…** button in the Analysis top bar (where the model + cycles are loaded), opening the chooser modal. |

### Delivered (goal 8)
- **`presentation/js/reportdata.js`** (`window.RPReportData`) — the PURE seam (no DOM/d3/fetch), strict **ES5/Node-6.9.1-safe** so `test/phase5.js` runs on-box. Four functions: `flameSvg(tree,opts)` (static icicle, CSS embedded in a `<style>`, `<title>` hover text, domain colours), `mermaid(unit,opts)` (the enriched diagram), `toJSON(o)` (structured export string), `htmlDoc(o)` (assembles the final self-contained HTML, escapes the JSON island).
- **Enriched Mermaid** — `autonumber`, activation bars (`->>+`/`-->>-`), `box` grouping TMM vs TCL VM, per-return self-µs labels, and a per-event `Note over` carrying authoritative cycles when a snapshot exists. Stays a **single flow/event slice** (Mermaid's sweet spot); the SVG export keeps the time/crossing detail Mermaid can't render. Replaced the old minimal arrow list in `analysis.js`.
- **`analysis.js` wiring** — the Export-report modal (format + scope + panel checkboxes); HTML generation **fetches `css/app.css`** for fidelity, renders the live `SeqDiagram` / `CyclesView` / `SourceMap` **off-screen** and lifts their markup, then stitches via `RPReportData`. The button enables once a trace loads (incl. cycles-only sessions). Pasted/backup traces export too (Stats read-only from `manifest.cycles`).
- **Plumbing** — version → `0.5.0`; `reportdata.js` added to `%files` (macOS rpm lists every file) and the index.html script tag (before `analysis.js`); `test/phase5.js` (zero-dep, Node-6.9.1-safe) + Python cross-check.

### Lessons learned / decisions
- **Reuse live DOM by rendering off-screen, don't re-author it.** Stats and Source coverage already have polished DOM renderers (`CyclesView`, `SourceMap`); the report parks a container at `left:-99999px` with an **explicit width** (so the responsive renderers size correctly), renders into it, lifts `innerHTML`, and discards it. Zero divergence, no duplicated rendering logic. The off-screen host **must have real layout** — a `display:none` or detached node would give the responsive code a 0-width pane.
- **Inline `app.css` (fetched) for the reused DOM; embed per-SVG CSS for the visuals.** The sequence/flamegraph SVGs each carry their own `<style>` so they're self-contained regardless; the Stats/Source HTML relies on app.css, so the report fetches and inlines it (one async dependency, always available because UiWorker serves it). This keeps the report in sync with the app automatically.
- **A static icicle beats serializing live d3.** Hand-rolling the SVG from the pure `RPFlame` tree (the same `seqdiagram` self-contained pattern) sidesteps every live-d3 export gotcha (computed styles vs stylesheet, web-font availability, missing `xmlns`) and drops the 280 KB d3 from the artifact. The only cost is losing interactive zoom — acceptable for a shareable file.
- **Mermaid `box` groups must be contiguous in participant-declaration order.** Call order is TMM→VM→TMM (Command is TMM again after the VM hop), so Command gets its **own second TMM box** rather than trying to put it in a non-contiguous TMM group. Two TMM boxes is fine and preserves the left-to-right call order.
- **Strip the XML PI before embedding an SVG inline.** `seqdiagram._exportSvgString()` prepends `<?xml …?>`, which is invalid inside an HTML body — the report strips it.
- **Escape `</script>` in the JSON data island** (`<\/script>`), or the embedded JSON terminates the script element early.
- **Whole-capture scope has no single sequence diagram** (it's inherently one flow/event slice). For `scope = whole`, the report renders the **on-screen selected unit** labelled "(representative slice)"; Stats/flamegraph/source aggregate cleanly at whole-capture. Cycles-only sessions (empty model, no selected unit) skip the sequence panel gracefully.
- **Pure/DOM split = headless coverage.** `flameSvg`/`mermaid`/`toJSON`/`htmlDoc` are pure string/object builders (geometry, enrichment, escaping, assembly — all tested under JSC + the Python width cross-check); only the off-screen stitching + app.css fetch are browser-only and deferred to on-box eyes. Same constraint as Phases 2–4.

### On-box validation checklist (v0.5.0, do FIRST)
1. **HTML report opens fully offline** — generate it, then open the downloaded file with **no running iApp / no network**: the static icicle SVG renders with the right fonts/`xmlns`, the embedded sequence SVG renders, and the Stats/Source tables keep their styling from the inlined app.css.
2. **Scope + panel chooser** — whole vs a specific flow/event changes the diagram + flamegraph; unchecking panels omits them; JSON format produces valid `.json`.
3. **Pasted/backup + cycles-only traces** — export works without a live session (Stats from persisted `manifest.cycles`; cycles-only sessions omit the sequence panel without erroring).
4. **Large-trace Blob sizing** — a big capture's report downloads without truncation/limits (and the embedded JSON island doesn't bloat it unusably).
5. **Enriched `.mmd`** renders in a Mermaid viewer (boxes, activations, autonumber, per-event cycle notes).
6. The `[hidden]` toggle on `#rep-dialog`/`#rep-panels` (the recurring CSS-specificity trap) and the JSON-format dimming of `#rep-panels`.

### Deferred (later phases)
- **CSV rollups** — out of v1 (HTML + JSON + Mermaid shipped). The per-command/per-event data is already in the cycles seam if wanted later.
- **Whole-capture Mermaid** — Mermaid stays a single-slice export; the SVG handles the whole-capture detail.
- **Per-event execution-weighted aggregate in the report** — inherits the Phase 4.1 flat-sum caveat (data's in the snapshot).

---

## Phase 6 delivery & lessons (v0.6.0 / v0.6.1 — DELIVERED, tags `phase6` / `phase6.1`, on-box validated)

> Status: **shipped and on-box validated.** Logic validated headless (JavaScriptCore + Python cross-check against the real 4-TMM fixture; `test/phase6.js` mirrors it for on-box Node 6.9.1). DOM surface verified in a real browser on the box against a live 4-TMM capture: the TMM scope dropdown (TMM 0–3 + All, ascending sort, per-TMM flow counts), interleaved flow badges in the Trace dropdown, the report TMM chooser, the diff Clear + saved-session loader, and that single-TMM captures keep the dropdown hidden.

### Ground truth confirmed (re-verified this phase)
The bundled fixture `background info/rultracer-solo_test_4-raw.csv` (4,525 occurrences, all 12-field) holds **4 ctxIds `11313`/`11670`/`11673`/`11674`** (main thread == pid 11313 sorts lowest → TMM 0) across **141 flows**, balanced **35/33/36/37**, with **0 flows spanning two ctxIds**. So the locked design holds: partition by `ctxId`, label `TMM 0..N` by ascending sort, flows pin to one TMM.

### Delivered (the multi-TMM / trace-layering deferral)
- **`presentation/js/tmm.js`** (`window.RPTmm`) — the PURE seam, ES5/Node-6.9.1-safe. `partition(records)` → TMM list `{ctxId,index,label,records,flowCount,occCount}` sorted ascending; `flowTmmMap(tmms)` → `flowId→'TMM n'` for badging; `cmpCtx`. The parser/model are untouched — `RPModel.build` just consumes a partition's record subset, staying TMM-agnostic underneath.
- **TMM scope selector** (`an-tmm`, next to *Group by*) — **separate dropdown that scopes the flow/event grouping**, not a third grouping axis (keeps "which TMM" orthogonal to "how to group within it"). Options: each `TMM n · k flow(s)` (raw ctxId + occ count on hover) + **All TMMs (interleaved)**. **Hidden for single-TMM captures** → existing sessions behave byte-identically. Default = **single-TMM (first TMM)** per the locked decision; switching rebuilds a memoised per-scope model and re-renders Sequence/Flamegraph/Source/trace dropdown.
- **Interleaved view badges flows with their TMM** (`· TMM n`) in the trace dropdown so a flow's owner is visible when all TMMs are shown.
- **Stats stays whole-box** (locked) — authoritative `ltm rule stats` + CPU budget are whole-box hardware counters, so the rule list and the trace-derived rollup read `wholeModel()` regardless of the in-view TMM.
- **Diff is unchanged from v0.5.0: capture-vs-capture only (whole A vs whole B).** TMM was deliberately kept OUT of the diff — per-TMM diffs added load/use confusion without a real payoff (flows pin to one TMM and load is balanced, so per-TMM forests are near-identical and cross-capture per-TMM is noise). Per-TMM analysis lives where it's useful: the Sequence/Flamegraph tabs via the top TMM dropdown. *(A TMM-vs-TMM overlay and then per-side TMM scopes were both prototyped and removed during Phase 6 review — the diff stays one clean concept.)* Two small keepers shipped on the diff: a **Clear** button (drops comparison B) and the saved-session loader below.
- **Load saved on-box sessions from the trace dialog** — the load modal (baseline A *and* comparison B) gained an `API.listSessions()`-backed picker, so an existing session can be diffed/opened without exporting/re-importing a backup. Hidden offline / when there are no sessions.
- **Report TMM chooser** (`rep-tmm`) — defaults to the in-view TMM; like the Scope dropdown it scopes **only the diagram + flamegraph** (Stats/Source/JSON stay whole-capture). Header gains a TMMs row; section titles get the TMM suffix.
- **Bundled 4-TMM example** — fixture promoted to `presentation/fixtures/example-multitmm.csv` with a **Load 4-TMM example** button in the load modal (works for baseline A and comparison B); added to `build-rpm.sh` staging (`*.csv`) + `%files`.
- **Plumbing** — version → `0.6.0` (`configProcessor.js`, `build-rpm.sh` default, report `REPORT_VERSION`); `tmm.js` script tag + `%files`; `[hidden]` re-asserted for the new `.an-controls[hidden]` (diff row) and `.modal-label[hidden]` (report TMM) — the recurring specificity trap. `test/phase6.js` (zero-dep, Node-6.9.1-safe) + Python cross-check.

### Addendums / deviations
- **Per-scope model cache** rather than rebuilding on every switch: `modelForScope('all' | ctxId)` memoises `RPModel.build`. `'all'` == the whole capture == today's behavior, so a single-TMM capture's `'all'` and its lone-TMM scope are the same cached object.
- **`flowGroup`/`eventGroup`/`scopeUnit`/`scopeRoots` gained an optional model param** so the report can target a TMM-scoped model while the live flamegraph keeps using `state.model`. `scopeRoots(val)` now delegates to `scopeRootsOf(model,val)`.

### Still deferred to real multi-blade hardware (separate `tmm` processes)
The fixture is a VE where the 4 TMMs are **threads of one process**. Unconfirmed on multi-blade: whether the syslog prefix becomes `tmmN[pid]:` (the parser's `PREFIX_RE` already matches both), whether a trailing 13th CSV field appears, and the per-TMM start "alert" text. The partition is keyed on `ctxId` today; a future build can swap the key source to the prefix without touching callers.

### On-box validation — DONE (v0.6.x, verified in-browser against a live 4-TMM capture)
1. ✅ **Single-TMM capture unchanged** — the `an-tmm` dropdown stays hidden; the Sequence tab behaves exactly as v0.5.0.
2. ✅ **Multi-TMM** — TMM dropdown shows TMM 0–3 (+ All) with per-TMM flow counts, ascending sort; default lands on the first TMM; *All TMMs (interleaved)* badges each Trace-dropdown flow with `· TMM n`.
3. ✅ **Diff (capture-vs-capture)** — whole-A-vs-whole-B as in v0.5.0; *Load comparison…* can pick a saved on-box session; **Clear** drops comparison B. No TMM controls on the diff.
4. ✅ **Report TMM chooser** — appears only for multi-TMM; scopes diagram + flamegraph; Stats/Source/JSON stay whole-capture.
5. ✅ **Folded button** — plain `.folded` download (browser-dependent save dialog), not an in-app modal.
6. The recurring **`[hidden]` specificity** trap on `#an-tmm-wrap` / `#rep-tmm-wrap` — handled (`.an-controls label[hidden]` / `.modal-label[hidden]`).

---

## Phase 8 — Bytecode disassembler (spec — 0.8.0, NOT yet built)

> Status: **DELIVERED v0.8.0** (tag `phase8`, on-box validated). The spec below is
> preserved as written; what actually shipped is recorded in **"Phase 8 delivery &
> lessons"** at the very end of this doc. Explicitly **staying 0.x** until
> substantial real-world feedback and use; not labeled "v1". This is the first
> phase past the original 8 goals — a net-new feature, not polish.

### Why

`ltm rule-profiler` deliberately drops the **operand** being pushed: the live trace
shows `push1` but never `# "3"`. The collapsed bytecode panel already tells users (in
its Further Reading link) to *"use Tcl's disassembler to recover the literals/operands
the trace omits."* This feature bakes that workflow into the UI: paste a Tcl snippet,
get the **box's own** bytecode back, with operands intact — the static "what the
compiler produced" companion to the live "what actually ran" in the sequence diagram.
It reuses the Phase 7 `opcodes.js` map to annotate the output.

Example (run on-box today): `tcl::unsupported::disassemble script { expr 3 * 4 }` →
`push1 0  # "3"` … `concat1 5` … `exprStk` … `done`.

### Locked decisions (from clarifying Q&A)

| Area | Decision |
|---|---|
| Version | **0.8.0**; **NOT** labeled "v1". Staying 0.x until lots of feedback/use. |
| UI home | **Expand the collapsed "Bytecode reference" panel** → rename to **"Bytecode reference & disassembler"**. The static opcode table stays as a section within it. |
| Input (0.8.0) | **Free-form paste box (scratchpad) only.** Works with no capture loaded. Pulling/abstracting the real loaded iRule, clicked-bytecode-tick jump, and source-selection were all liked but **deferred**: iRule extension commands (`[Module::cmd]`) must be hand-abstracted to literal values, and auto-stubbing them is too much overhead for now. |
| Extension-command help | **Guidance + tooltips only.** An inline note + tooltips tell users to replace extension calls like `[HTTP::host]` with a literal value (e.g. `"example.com"`) before disassembling. No automation, no source coupling. |
| `when { }` blocks | **Auto-strip the handler wrapper and disassemble the body, WITH warnings.** (`when` is itself an iRule command — tclsh treats it as unknown and the body as a string literal, so only the body is worth compiling.) **NOT** just `when EVENT {` — modifiers (`priority N`, `timing on\|off`) legally sit between the event and the body brace, so capture to the **first `{` after the `when` header**. See **"`when`-block extraction (precise rule)"** below. Warn what was stripped; warn on multiple handlers / unbalanced braces. |
| Output | **Two views, checkbox toggle** (mirrors the existing "Collapse bytecodes" toggle): (1) **raw** tclsh-style text; (2) **structured table** (pc · opcode · operands · the `# literal` comment), opcodes cross-linked to `opcodes.js` tooltips. |
| Execution | `child_process.execFile('tclsh', …)` as the **uid-198 worker** — **NOT** the `util/bash` root channel. Unlike `tmsh`, `tclsh` has no history-file write problem, so plain execFile works and keeps this off root. |
| Safety | `disassemble script $body` **compiles, never executes**. The user body is passed as a **Tcl data variable** (env var or temp file), never interpolated into the command's braces → no brace-escape injection (`} ; exec … ; disassemble script {`). Plus a timeout + input/output size caps. |
| Gating | **Settings toggle, default OFF (opt-in).** New `settings.js` flag (e.g. `disasmEnabled`). The disasm endpoint refuses unless enabled. **In-panel toggle only** — when off, the panel shows a disabled state with an "Enable disassembler" control that persists the flag. **No global Settings view in 0.8.0**; the existing hidden `settings.js` options (retention / publisher mode / max period) stay UI-less for now. |
| Endpoint | New **dedicated `DisasmWorker`** at `POST /mgmt/shared/rultracer/disasm { script }` → `{ ok, output, parsed?, warnings[] }`; clear refusal when the flag is off. New worker means `manifest.json` + `build-rpm.sh` staging/`%files` updates. |
| New pure seam | `presentation/js/disasm.js` (`window.RPDisasm`) parses raw tclsh disassembly → structured rows; **Node-6.9.1-safe**, headless-tested via `test/phase8.js`; added to `build-rpm.sh` staging **and** `%files`. |
| Opcode dictionary | **Expand `opcodes.js` from 7 to a common ~20–40 opcode subset** — the ops that actually appear in typical iRule / `expr` / control-flow disassembly (`exprStk`, `concat1`, `jump`/`jumpTrue`/`jumpFalse`, `pop`, `dup`, `incrScalar`, list ops, …). Unknown opcodes fall back to the raw mnemonic. Keeps both the panel table and the tick tooltips meaningful in the disassembler view. Must cover **both** the live-trace (8.4.6) opcodes and the tclsh (8.5.13) disassembly opcodes — mostly overlapping, but some names diverge (e.g. trace `streq` vs tclsh `eq`). |
| Persistence | Scratchpad is **ephemeral** (not saved into sessions). Optionally remember the last input in `localStorage`. |
| Errors | Surface Tcl **compile errors** verbatim (they're useful feedback). Fail gracefully if `tclsh` or the `tcl::unsupported::disassemble` namespace is absent. |

### Mechanism (server side)

1. Browser POSTs the snippet to `/disasm`. Worker checks the `disasmEnabled` setting; if off, returns a clear "disassembler is disabled" envelope.
2. Worker writes the body to an env var (or a `/var/tmp` temp file) and runs a **fixed** wrapper via `execFile('tclsh', …)` as uid 198: read the body **as data**, then `puts [tcl::unsupported::disassemble script $body]`. Timeout + output cap; clean up any temp file.
3. Worker returns the raw text; the browser optionally parses it with `RPDisasm` for the structured-table view.

The injection-safety hinge: the body is **data passed to** `disassemble`, not text spliced **into** the command, and `disassemble` compiles without executing. So even hostile input is compiled-and-shown, never run — and it runs as uid 198, off the root channel.

### Caveats to surface in the UI

- **Version mismatch (confirmed on-box).** The box's standalone `tclsh` is **Tcl 8.5.13**, but the **iRule engine is Tcl 8.4.6**. Bytecode for common constructs is *close* but **not guaranteed identical** (8.5 changed/added opcodes; 8.5-only syntax won't even run in the 8.4.6 engine). Label the output as *"Tcl 8.5.13 disassembly (approximates the 8.4.6 iRule engine)"* so nobody treats it as the exact iRule bytecode. Corollary: the **live trace (8.4.6)** and the **disassembler (8.5.13)** can print different names for the same op — e.g. the trace's `streq` vs tclsh's `eq` — so the opcode dictionary must cover both.
- **`tclsh` is base Tcl, not the TMM iRule interpreter.** Core constructs (`expr`, `if`, loops, string ops) compile faithfully; iRule **extension commands show as generic `invokeStk`** to an unresolved name (consistent with how the live trace shows them). A one-line UI note sets this expectation.
- **`tcl::unsupported::disassemble` is unsupported** — the namespace could shift across TMOS Tcl versions; fail gracefully if absent.

### Confirmed on-box (2026-06-18) + remaining impl call

- ✅ **`tclsh` = `/usr/bin/tclsh`**, and **uid 198 can exec it** (`sudo -u restnoded /usr/bin/tclsh <<< 'puts hi'` → `hi`). The off-root-channel premise holds.
- ✅ **Tcl 8.5.13**, `::tcl::unsupported` namespace present (`namespace exists` → 1). But see the **8.5.13 (tclsh) vs 8.4.6 (iRule engine)** mismatch caveat above — load-bearing for how we label the output and build the opcode dictionary.
- ✅ **Transport = env var** (`RULTRACER_DISASM_BODY`), fixed wrapper fed on stdin. No temp file.

### Prototype outcomes (2026-06-18, `proto/disasm-proto.js` on-box, Tcl 8.5.13)

A throwaway standalone prototype (run as `restnoded`/uid 198) exercised the exact
exec-wrapper the worker will use. Results that drive the build:

- ✅ **SAFETY PROVEN.** The injection probe body `exec touch /tmp/…` compiled to
  `push1 "exec" / push1 "touch" / push1 "/tmp/…" / invokeStk1 / done` and the file
  was **NOT** created. `disassemble script $body` (body passed as a data env var)
  compiles without executing. **Transport decision locked: env var + stdin wrapper, no temp file.**
- **`when` auto-strip CONFIRMED.** `when HTTP_REQUEST { set x 1 }` compiles `when`
  as a command with the body ` set x 1 ` as an **uncompiled string literal**
  (`push1 2  # " set x 1 "`). To disassemble the body you must extract it first —
  exactly the auto-strip-with-warnings decision.
- **Extension commands compile cleanly.** `[HTTP::host]` becomes its own `Command`
  block: `push1 "HTTP::host" / invokeStk1 1`. So non-abstracted snippets do **not**
  error; abstracting to a literal only matters when you want the result to flow
  into surrounding logic (e.g. a `streq`). Guidance/tooltips suffice.
- **`eq` operator → `streq` opcode** (not `eq`; `eq` is the `==` numeric op). Matches
  the 8.4.6 trace. **`startCommand`** appears 9× — it is a **Tcl 8.5 artifact** the
  8.4.6 iRule engine does not emit, so the dictionary must tag it "not in the trace."

**Disassembly format (for the `disasm.js` parser):**
- Ignore the `ByteCode 0x… refCt …` header line and the multi-column `Commands N:` summary index.
- The `Source "…"` header is **truncated** for long scripts (no ellipsis) — use the per-`Command` `"src"` strings, not the `Source` header, for the source text.
- An optional `Exception ranges N, depth N:` block appears for loops/`catch` — skip it (or surface loop ranges later).
- Parse `Command N: "src"` blocks; each is followed by `    (pc) opcode [operands]  # comment` lines. The `# "literal"` comment is the **recovered operand** the live trace drops (the whole point).
- **Command blocks can be empty** (a container like the `if` line) — the real instructions live under a nested `Command` (e.g. `[HTTP::host]`). The parser must tolerate header-only blocks.
- Some operands carry no `#` comment (`concat1 5`, `invokeStk1 3`, `startCommand +35 1`, `jumpFalse1 +18  # pc 39`, `incrScalarStkImm +1`).
- The `Cmds N, inst N, litObjs N, stkDepth N` summary line is a useful "cost" readout to surface.

**Opcode dictionary seed (16 confirmed empirically from 7 small snippets):**
`appendStk, concat1, done, exprStk, incrScalarStkImm, invokeStk1, jump1, jumpFalse1,
jumpTrue1, loadScalarStk, lt, pop, push1, startCommand, storeScalarStk, streq`.
Curate to ~20–40 by adding the obvious siblings: `push4`, the `4`-offset jumps
(`jump4`/`jumpFalse4`/`jumpTrue4`), the numeric comparisons (`eq`/`neq`/`gt`/`ge`/`le`),
`strneq`, `loadScalar1`/`storeScalar1`, `incrScalarStk`, `lappendStk`, `listIndex`,
`tryCvtToNumeric`, `nop`. Tag `startCommand`/`incrScalarStkImm` as 8.5-isms.

### `when`-block extraction (precise rule)

iRule handlers allow **modifiers between the event name and the body brace**, so the
wrapper is **not** simply `when EVENT {`. All of these are legal, and a standalone
`timing on|off` directive can sit *outside* any handler:

```
timing off
when CLIENT_ACCEPTED priority 300 {
    log local0. "first"
}
when CLIENT_ACCEPTED priority 400 timing on {
    log local0. "second"
}
when CLIENT_ACCEPTED timing on {
    log local0. "third"
}
```

Extraction algorithm (in `disasm.js`):

1. Find a handler header with `/\bwhen\s+[A-Z][A-Z0-9_]*\b[^{]*\{/` — `when`, the event
   name, **then any modifiers** (`priority <n>`, `timing on|off`; the `[^{]*` swallows
   them and the whitespace), **then the first `{`**. (Modifiers contain no braces, so the
   first `{` after the `when` header is always the body's opening brace.)
2. From that `{`, **brace-count** to the matching `}` (handles nested `{…}` in the body).
   That span is the body handed to `disassemble`.
3. **Multiple handlers:** if more than one header matches, warn; for 0.8.0 either
   disassemble each body labeled by its header (`CLIENT_ACCEPTED priority 300`, …) or
   disassemble the first and note the rest (implementation call).
4. **Discard everything outside a handler's braces** — a standalone leading `timing off`
   (or any top-level directive) is not a Tcl body and is simply ignored.
5. **Warn** on unbalanced braces / no matching `}`. Capture the header text to label output.

---

## Phase 8 delivery & lessons (v0.8.0, tag `phase8` — on-box validated)

> Status: **SHIPPED.** Pure seams validated headless (JavaScriptCore via `osascript`
> + `test/phase8.js` for on-box Node 6.9.1); the worker tclsh round-trip and the UI
> validated on-box. The throwaway `proto/disasm-proto.js` was deleted once the
> worker landed (its exec-wrapper was lifted verbatim into `DisasmWorker.js`).

### Locked decisions (clarifying Q&A this phase)
| Question | Decision |
|---|---|
| `disasmEnabled` read/flip endpoint | **On `DisasmWorker`** (no settings GET/POST existed; smallest surface, self-contained). `GET /disasm`→`{enabled}`, `POST {action:'enable'\|'disable'}` flips it. |
| Multiple `when` handlers | **Disassemble each body, labeled by its captured header** (e.g. `CLIENT_ACCEPTED priority 300`). |
| Structured-table view | **Grouped by Command block** (src header + pc/opcode/operands/`# literal` rows); empty/container blocks render header-only. |
| UI extras | **Cost summary line only.** No paste-box prefill, no localStorage remember-last-input. |
| Panel layout (follow-up) | **Two columns** — opcode reference left, disassembler right (`.bc-cols` flex, wraps to a stack on narrow panes). |

### Delivered
- **`opcodes.js` expanded 7 → 34** — seed list + obvious siblings (`push4`, `4`-offset jumps, numeric `eq/neq/lt/gt/le/ge` vs string `streq/strneq`, load/store slots, list/expr ops, `nop`/`dup`/`pop`). New `v85` flag tags 8.5-only opcodes (`startCommand`, `incrScalarStkImm`); new `is85()` accessor; the panel table + the disasm table render a "Tcl 8.5" badge. `streq` (the `eq` operator) and `eq` (numeric `==`) are now distinct rows.
- **`nodejs/lib/DisasmWorker.js`** (ES5, off the root channel) — `GET /disasm`→`{ok,enabled}`; `POST /disasm {script}`→`{ok,output,warnings}` or `{ok,compileError}` (Tcl compile errors surfaced verbatim, `ok:true` so the browser shows them as feedback); `POST /disasm {action}` flips the flag. `execFile('/usr/bin/tclsh')` as uid 198, body in `RULTRACER_DISASM_BODY` env var fed to a fixed stdin wrapper, 5 s timeout, 1 MiB output cap, 256 KiB input cap. Refuses when the flag is off.
- **`presentation/js/disasm.js`** (pure `window.RPDisasm`, Node-6.9.1-safe) — `extractHandlers()` (brace-aware `when`-strip, one labeled body per handler, warns on multiple handlers / discarded outside text / unbalanced braces), `matchBrace()`, and `parse()` (raw tclsh → `{meta:{cmds,inst,litObjs,stkDepth}, commands:[{index,src,instructions:[{pc,opcode,operands,comment}]}], warnings}`; tolerates the truncated `Source` header, the `Commands` index, `Exception ranges` blocks, and empty Command blocks).
- **`presentation/js/disasmview.js`** (`window.DisasmView`) — renders the per-body results in raw (`<pre>`) or structured-table mode; opcodes cross-linked to `RPOpcodes` tooltips, 8.5-isms flagged, compile errors shown per body.
- **UI** (`index.html` + `app.js` + `api.js`) — the renamed two-column panel: paste box, Disassemble button, raw/table checkbox toggle, abstraction guidance, the 8.5.13≈8.4.6 version label, warnings area, cost summary, and the opt-in **Enable disassembler** control (gated on `GET /disasm`). `app.js` orchestrates `extractHandlers` → one `POST /disasm` per body → `parse` → `DisasmView.render`; the mode toggle re-renders from cached results without re-fetching. `api.js` gained `disasmStatus`/`disasm`/`disasmEnable`.
- **`settings.js`** — `disasmEnabled: false` in `DEFAULTS`.
- **Plumbing** — version → `0.8.0` (`configProcessor.js`, `build-rpm.sh`); `DisasmWorker.js` / `disasm.js` / `disasmview.js` added to `%files` (macOS rpm lists every file; staging is wildcard); `disasm.js`/`disasmview.js` script tags in `index.html`. `test/phase8.js` (zero-dep, Node-6.9.1-safe) covers the expanded dictionary + `is85` + when-extraction edge cases + raw-parse; phase7 opcode-meaning assertions updated for the reworded meanings.

### Lessons / decisions
- **The injection-safety hinge held in production:** body-as-env-var-data + a fixed stdin wrapper + `disassemble` compiling-not-executing means even hostile input is compiled-and-shown, never run — and it runs as uid 198, off the root channel (unlike `tmsh`, `tclsh` has no history-file write problem, so plain `execFile` works).
- **Same headless constraint as Phases 2–7.** The pure seams (`opcodes.js`/`disasm.js`) are validated under JavaScriptCore + `test/phase8.js`; the worker round-trip and every visual aspect (two-column layout, table tooltips, `op-85` badge, compile-error styling) needed on-box eyes. The `parse()` parser is tested against a representative fixture, not live 8.5.13 output — the most likely place for a future tweak.
- **No `[hidden]` specificity trap this phase** — Phase 7's global `[hidden]{display:none !important}` already covers the new toggled elements (`#disasm-disabled`/`#disasm-ui`), so setting `display` on them is safe.
- **Changing an opcode's `meaning` string ripples into the tests** — `tip()` is derived from `meaning()`, so the phase7 `tip('push1')` assertion (not just the `meaning()` ones) had to move when the text was reworded. Single source of truth cuts both ways.
