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
- **Phase 4 — Cycles-vs-CPU stats (goal 7).** Durations are µs deltas (no cycle field on 17.1 VE); convert µs→cycles via `/mgmt/tm/sys` CPU clock/core count and reconcile with `ltm rule stats`. Seam: InventoryWorker CPU stub.
- **Phase 5 — Reports + Mermaid export (goal 8).** Self-contained HTML + JSON/folded/CSV; wire `toMermaid()` to download. Seam: serializable model, disabled Mermaid button present.
- **Phase 6 — Multi-TMM & trace layering (deferred from goal-7/viz; needs multi-TMM hardware).** Partition by TMM, single-TMM/interleaved/overlay views, `layers([...])`; confirm the per-TMM line tagging and `ctxId` meaning on real hardware.
- **Phase 7 — Wrap-up / polish (optional, end of project).** Small quality-of-life adds deferred to keep earlier phases clean:
  - **Inline bytecode opcode hints** — hover tooltip (and/or opt-in verbose label) on each bytecode tick mapping the mnemonic to its meaning (`push1` → "push a literal", etc.), reusing the opcode table already in the collapsed "Bytecode reference" panel. Kept off-screen for now by request; promote to inline if desired.
  - Other deferred polish as it accrues.

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
