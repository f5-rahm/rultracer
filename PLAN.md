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
- **Phase 2 — Parse + sequence + step-through (v1, goals 3,4,6).** `parser.js`/`model.js` (prefix-strip, pairing, durations, NestNode — single-TMM, flow/event grouping); `seqdiagram.js` D3 diagram with crossings; `stepthrough.js` linked table+scrubber w/ variable/command replay; `sourcemap.js` best-effort annotation; grouping selector. **Deliverable:** full v1 usable debugger.
- **Phase 3 — Flamegraph + diff (goal 5).** NestNode→folded → vendored d3-flame-graph; diff view comparing two captures. Seam: `toFolded()`.
- **Phase 4 — Cycles-vs-CPU stats (goal 7).** Durations are µs deltas (no cycle field on 17.1 VE); convert µs→cycles via `/mgmt/tm/sys` CPU clock/core count and reconcile with `ltm rule stats`. Seam: InventoryWorker CPU stub.
- **Phase 5 — Reports + Mermaid export (goal 8).** Self-contained HTML + JSON/folded/CSV; wire `toMermaid()` to download. Seam: serializable model, disabled Mermaid button present.
- **Phase 6 — Multi-TMM & trace layering (deferred from goal-7/viz; needs multi-TMM hardware).** Partition by TMM, single-TMM/interleaved/overlay views, `layers([...])`; confirm the per-TMM line tagging and `ctxId` meaning on real hardware.

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
3. **Multi-TMM** — VE is single-TMM, so **deferred to Phase 6**. On multi-TMM hardware confirm per-TMM line tagging (prefix `tmmN`), the `ctxId` (field 5) meaning vs the prefix pid, flowId uniqueness across TMMs, and the per-TMM start "alert" text.
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
