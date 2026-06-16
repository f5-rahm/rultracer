# rultracer

An F5 BIG-IP iControl LX / iApps LX extension that turns the tmsh-only
`ltm rule-profiler` iRule tracer into a visual debugger and profiler.

It runs **on the BIG-IP**: an on-box Node worker configures the profiler, captures
the trace stream to a per-session file, and serves it to a browser SPA that parses
and visualizes it (TMM ↔ TCL VM sequence diagram, step-through, flamegraph, stats,
report). See [PLAN.md](PLAN.md) for the full design and phased plan.

## Status

- **Phase 1** (capture core): profiler setup + bounded capture + session persistence + teardown.
- **Phase 2** (v0.2.0 — analysis): browser-side trace parser, TMM ↔ TCL VM sequence
  diagram, linked step-through (table + scrubber + variable/command replay), and
  best-effort iRule source mapping. Open a finalized session from **Sessions →
  analyze**, or use **Analysis → Load bundled example / paste** to work offline.
- **Phase 3** (v0.3.0 — flamegraph + diff): interactive flamegraph (vendored
  d3 + d3-flame-graph, no build step) under the **Analysis → Flamegraph** sub-tab —
  aggregated profiler view (scope: whole-capture / per-event / per-flow, identical
  call paths merged) or a literal icicle of the selected trace; frames tinted
  teal/orange by TMM/TCL-VM domain, width = inclusive µs, bytecodes pruned (counts
  in the tooltip), folded-stack export. The **Diff** sub-tab compares a second
  capture against the current one — differential (B sized, frames red/blue by
  self-time delta) or side-by-side.
- **Phase 4** (v0.4.0 — cycles vs CPU): the **Analysis → Stats** sub-tab turns
  the box's own `ltm rule stats` (per-event hardware cycle counters) into the
  DevCentral "Evaluating Performance" tables — cycles → µs, %CPU/request (vs the
  whole-box budget, Σ all-core MHz), and max req/sec. **Reset** zeroes a rule's
  counters; drive a high-volume run (100k+ conns, profiler OFF — its logging
  inflates timings); **Snapshot** reads CPU + stats and persists them on the
  session. A reconcile panel puts the authoritative cycles next to the
  trace-derived numbers (the gap = profiler overhead), plus a trace-derived
  per-command table (the only per-command view).
- **Phase 4.1** (v0.4.1 — guided Run Test): Setup now sequences a whole test as
  one session. Toggle **cycles** and/or **profiler trace**; the cycles phase runs
  first with the profiler OFF — reset, drive the high-volume load (external with a
  pause/Continue, or an on-box override that fires it for you with bounded
  concurrency — flagged as skewing the measurement), then snapshot. The trace
  phase then attaches the profiler to the same session for the small run. A
  cycles-only run finalizes straight to the Stats sub-tab.

## Layout

```
manifest.json         iControl LX package manifest
nodejs/               on-box workers (run in restnoded, Node 6.9.1 -> ES5)
  lib/                shared helpers + RestWorkers
presentation/         browser SPA (vanilla JS, no build step)
build/                RPM build + install scripts
test/                 zero-dependency test harness (node test/unit.js + test/phase2.js + test/phase3.js + test/phase4.js)
presentation/vendor/  vendored d3 (ISC) + d3-flame-graph (Apache-2.0); see vendor/LICENSES.md
docs/                 design docs and on-box runbooks
background info/       source articles, man page, example captures (parser fixtures)
```

## Installing

### With `install-onbox.sh` (iterative dev)

From your laptop, once the RPM is built and scp'd to `/shared/images/` on the BIG-IP:

```bash
ssh root@<bigip> /shared/images/install-onbox.sh <version-release>
```

`install-onbox.sh` does a preflight (creates `/shared/rultracer/data/sessions` with restnoded ownership), runs the package-management-tasks INSTALL, then invokes the packaged `post-install.sh` for belt-and-suspenders verification. Pass `--reinstall` to force UNINSTALL+INSTALL (wipes session data).

### Manual install (F5 GUI, raw REST call, anything else)

If you install the RPM via the F5 GUI or POST `package-management-tasks` directly, **you MUST run the post-install script via SSH** before the workers can write sessions:

```bash
ssh root@<bigip> bash /var/config/rest/iapps/rultracer/build/post-install.sh
```

The iApps LX install pipeline **does not execute RPM `%post` scriptlets** — installed packages show in `/mgmt/shared/iapp/global-installed-packages` but are absent from the system RPM database (`rpm -q rultracer` returns "not installed"), confirming the framework extracts the payload directly and bypasses scriptlet machinery. The restnoded worker process runs as **uid 198**, which cannot create directories under `/shared/` (root:root 0755), so this must be done from a root shell.

`post-install.sh` is idempotent — safe to run repeatedly. It creates `/shared/rultracer/data/sessions/` owned `restnoded:webusers` (198:498) mode 0750, writes an audit log placeholder, and stamps a marker at `/var/config/rest/iapps/rultracer-post-install.log` so you can confirm it ran.

## Runtime constraints

- The worker runs in `restnoded` as **root**; it execs `tmsh` directly
  (`child_process.execFile('tmsh', ['-c', cmd], {env:{HOME:'/var/tmp'}})`) — no
  `/mgmt/tm/util/bash` round-trip, no shell escaping. iControl REST on
  `localhost:8100` is used for reads only.
- restnoded Node.js is **6.9.1**, so worker code is conservative ES5 (no
  arrow functions / template literals / `let`/`const`; `var` + Promises).
- The browser SPA targets modern browsers and may use modern JS.
