# rultracer — System Architecture

A distilled map of how rultracer fits together. For the exhaustive design
rationale and the phase-by-phase history, see [PLAN.md](../PLAN.md).

rultracer has three layers, all living **on the BIG-IP**:

```
  Browser SPA  ──HTTP──▶  iControl LX RestWorkers  ──util/bash + REST──▶  TMOS
 (presentation/)         (nodejs/lib, restnoded)        (tmsh, iControl, /var/log/ltm)
```

The on-box workers drive the `ltm rule-profiler`, capture its trace stream, and
persist it as a session. The browser fetches a finalized session and does **all
parsing and visualization client-side** — the workers ship raw CSV, not models.

---

## 1. On-box workers (`nodejs/lib`)

restnoded, **Node 6.9.1 → conservative ES5**. Six RestWorkers expose REST routes;
the rest are plain helper modules used directly by the workers. All workers mount
under `/mgmt/shared/rultracer/*` (except the config processor and UI server).

### RestWorkers

| Worker | REST path | Role |
|--------|-----------|------|
| **ConfigProcessor** | `/mgmt/shared/iapp/processors/rultracer` | iApps LX manifest lifecycle (BIND/UNBOUND). Effectively a no-op — rultracer keeps no block state; the real init happens in `onStart`. |
| **ProfilerWorker** | `/mgmt/shared/rultracer/profiler` | The capture state machine front door. `GET` → status; `POST {action: 'start'\|'stop'\|'teardown', config}`. Delegates to `CaptureEngine` (`engine.js`). |
| **SessionWorker** | `/mgmt/shared/rultracer/sessions` | CRUD over persisted sessions: list, get manifest, get raw CSV, begin, import/export, delete, and POST a Phase-4 cycles snapshot. |
| **InventoryWorker** | `/mgmt/shared/rultracer/inventory` | Setup-view data: virtual servers + attached iRules, event names per rule, log publishers, CPU info, and `ltm rule stats`. |
| **TrafficWorker** | `/mgmt/shared/rultracer/traffic` | HTTP/HTTPS request generator to drive traffic against a VIP — serial (default) or high-volume bounded-concurrency mode. |
| **UiWorker** | `/mgmt/shared/rultracer/ui` | Static SPA server (`index.html`, `js/`, `css/`). `isPassThrough` for sub-path routing. |

### Helper modules

| Module | Role |
|--------|------|
| **engine.js** | `CaptureEngine` — the 5-state orchestrator (idle → configuring → capturing → stopping/flushing → finalized). Sequences profiler setup, trace start/stop, flush detection, and session finalize. |
| **profiler.js** | Builds & runs the `tmsh ltm rule-profiler` commands; manages the profiler object lifecycle (create/start/stop/delete) and sweeps orphans on startup. |
| **capture.js** | Reads rule-profiler CSV lines out of `/var/log/ltm` (via the root bash channel); handles log rotation and timestamp/offset-based session filtering. |
| **store.js** | Filesystem session persistence under `/shared/rultracer/data/sessions/<id>/` (`manifest.json` + `raw.csv`); retention pruning by count and bytes. |
| **logchain.js** | Log-publisher management — auto-detect/reuse/create `rultracer_pub`, verify local-syslog routing. |
| **cpustats.js** | Parses `/proc/cpuinfo` (per-core MHz) and `ltm rule stats` (per-event cycles); reconciles authoritative vs trace-derived cycles (Phase 4). |
| **tmsh.js** | Runs tmsh via `POST /mgmt/tm/util/bash` (as **root**, sidestepping the uid-198 history-file failure). See the file header for the quoting layers. |
| **iremote.js** | GET-only iControl REST client on `localhost:8100` (trusted channel) for reads. |
| **settings.js** | Persisted config: retention limits, publisher mode, max capture period. |
| **validate.js** | Validates tmsh object names, iRule event names, and occurrence masks before they're interpolated into commands. |
| **restutil.js** | Response envelopes (ok/fail), URI/query parsing, package-relative dir resolution (`dataDir = /shared/rultracer/data`). |
| **util.js** | `fs` promise wrappers, recursive mkdir/rm, file I/O (Node 6.9.1 has no `fs.promises`). |
| **logger.js** | Wrapper over `f5-logger` (console fallback), `[rultracer]` prefix. |

> **Why `util/bash` for writes?** The worker runs as uid 198; on TMOS 21.x tmsh
> can't write its history file from that uid and fails fatally. POSTing to
> `/mgmt/tm/util/bash` runs the command as root and avoids it entirely. Reads stay
> on the GET-only `iremote` client. (See `tmsh.js` and the README runtime notes.)

---

## 2. Browser SPA (`presentation/js`)

Modern-browser ES6+, **no build step**. Split into pure logic seams (no DOM —
headless-testable) and DOM/view modules.

### Pure logic seams (tested headless via `test/phaseN.js`)

| Module | Role | Test |
|--------|------|------|
| **parser.js** | Parse rule-profiler CSV (syslog-prefixed or raw) into occurrence records (`tsMicros`, `base`, `kind`, `lifeline`, `domain`, `flowId`, `ctxId`, …). | phase2 |
| **opcodes.js** | Tcl bytecode opcode→meaning table; single source for the "Bytecode reference" panel and the seq-diagram tick hover tooltips. | phase7 |
| **model.js** | ENTRY/EXIT pairing into a `NestNode` forest per `flowId`; duration math (raw, sum-of-children, real exec time); unmatched-span detection. | phase2 |
| **flame.js** | NestNode forest → flamegraph shape (`{name, value, children}`), literal per-flow or aggregated by call path; folded-stack export. | phase3 |
| **cycles.js** | CPU facts + cycle↔µs conversions; per-event authoritative (`ltm rule stats`) vs trace-derived stats; %CPU and req/sec derivations. | phase4 |
| **reportdata.js** | Pure report generation: static icicle SVG, Mermaid `sequenceDiagram`, JSON, and full HTML assembly (no live DOM render). | phase5 |
| **tmm.js** | Partition a capture by `ctxId` (worker-thread id) into TMM 0..N; preserve `ctxId` for display. | phase6 |

### DOM / view modules

| Module | Role |
|--------|------|
| **app.js** | SPA controller — view switching (Setup / Capture / Analysis), status polling, modals, event wiring. |
| **api.js** | REST client wrapper (`BASE = /mgmt/shared/rultracer`); `fetch` → JSON; exposes `window.API` (inventory, profilerStatus, startCapture, listSessions, getRaw, …). |
| **analysis.js** | Analysis view orchestrator — wires `parser` → `model` → the views; grouping selector, trace modal (paste/load/export), cross-highlight, Phase 3–6 UI state. |
| **seqdiagram.js** | The custom SVG sequence diagram (six lifelines, TMM/VM domain coloring, responsive layout + export). |
| **stepthrough.js** | Linked table + timeline scrubber; `VAR_MOD` replay for variable state; cursor sync with the diagram. |
| **sourcemap.js** | Annotates iRule source — HIT (µs + count), DIM (unfired branch), AMBIGUOUS (multi-match), per (rule, event, command). |
| **flamegraph.js** | Wraps d3-flame-graph; domain coloring (teal/orange) or diff coloring (red/blue). Not headless-testable (d3 + DOM). |
| **cyclesview.js** | Renders the cycles tables — authoritative → µs/%CPU/req-sec, reconcile vs trace-derived, per-command trace table. |

---

## 3. Capture lifecycle (end to end)

1. **Setup.** Browser `API.inventory()` → `GET /inventory` → `InventoryWorker`
   lists VS, rules, events, publishers, CPU. User picks VS / rules / events /
   period / publisher mode.
2. **Start.** `API.startCapture(config)` → `POST /profiler {action:'start', config}`
   → `CaptureEngine.start()`: ensure publisher (`logchain`), create + enable the
   profiler (`profiler` → `tmsh.runBash` via util/bash), record the `/var/log/ltm`
   start offset (`capture`). State → *capturing* (with an auto-stop timer if a
   period is set).
3. **Traffic (optional).** `API.sendTraffic(opts)` → `POST /traffic` →
   `TrafficWorker` fires requests at the VIP; the profiler logs `RP_*` occurrences
   to `/var/log/ltm`.
4. **Stop + flush.** `API.stopCapture()` → `POST /profiler {action:'stop'}` →
   disable the profiler, then a polling loop (`capture.readFrom`) drains
   `/var/log/ltm` until no new lines arrive. `store.createSession()` writes
   `/shared/rultracer/data/sessions/<id>/` (`manifest.json` + `raw.csv`). State →
   *finalized*.
5. **Teardown.** `API.teardown()` → delete the profiler object; remove the
   publisher only if this run created it. State → *idle*.
6. **Analyze (all client-side).** `API.listSessions()` → `GET /sessions`; pick one;
   `API.getRaw(id)` → `GET /sessions/<id>/raw` returns the CSV. Then
   `parser.parse` → `model.build` → the views: `seqdiagram` + `stepthrough` +
   `sourcemap`; `flame` → flamegraph; `cycles` + `cpustats` → stats; `reportdata`
   → exportable report; `tmm.partition` → per-TMM model switching.

---

## Conventions worth knowing

- **Workers ship raw CSV, models live in the browser.** The on-box side never
  parses the trace — `parser`/`model` and everything downstream are browser-only.
  This keeps the ES5 worker surface small and lets analysis iterate without a redeploy.
- **Pure seams are Node-6.9.1-safe** so `node test/phaseN.js` runs both on a dev
  box (headless) and on the BIG-IP. Node 6.9.1 (V8 5.1) has `const`/`let`/arrow/
  `for-of`/template-literals, but **not** `**`, optional chaining (`?.`), nullish
  (`??`), or async/await — avoid those in shipped pure seams. Some newer seams
  (`tmm.js`, `opcodes.js`) stay `var`/`function`-only by choice; that's extra
  conservatism, not a requirement (`parser.js`/`model.js` use arrows + `const`).
- **Persistent data is under `/shared/rultracer/`**, not the iApps package dir —
  the iApps LX framework wipes `/var/config/rest/iapps/<pkg>/` on every install.
- **The RPM `%files` list is explicit** — adding a presentation module or fixture
  means updating both `build/build-rpm.sh` staging and its `%files` block.
