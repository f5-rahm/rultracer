# Phase 5 kickoff prompt — Reports + Mermaid export (PLAN.md goal 8)

Paste this into a fresh session to start Phase 5. The repo is clean at tag `phase4.1`, v0.4.1.

---

Start Phase 5 of rultracer: **Reports + Mermaid export (PLAN.md goal 8)**.

Before writing code, review context: read `PLAN.md` (esp. the phased plan, goal 8 / "Export report", the **"Phase 4 delivery & lessons"** and **"Phase 4.1"** sections at the end, and the Phase 3 "Deferred → Mermaid export enrichment → Phase 5" note), the auto-loaded memory (`project_phase4-implemented` has the full module map: cycles/stats seam, the coupled Run Test workflow, and the worker/API surface), and `git show phase4.1`. The repo is clean at tag `phase4.1`, v0.4.1. Then ask clarifying / architectural / style questions before building (my usual flow), and bump to **0.5.0**.

> If v0.4.1 hasn't been on-box-validated yet, PLAN.md's "Phase 4.1 → On-box validation checklist" lists what to exercise first — do that before building on top.

**What Phase 5 is:** a human-readable, **self-contained report** for a captured session, plus structured **data exports** and an **enriched Mermaid** diagram. Today there's a *data backup* (`Sessions → Download backup` = a JSON bundle of manifests + raw.csv for re-import) — that is NOT a report. Phase 5 produces a shareable artifact that stands alone without the running iApp.

Scope to settle with me, then build:
- **Self-contained HTML report** — one file a user can open offline: the session metadata, the sequence diagram (SVG), the flamegraph (SVG), and the **Stats / cycles** tables (authoritative `ltm rule stats`, the whole-VS aggregate, the reconcile-vs-trace table — all already rendered by `cyclesview.js` from `manifest.cycles`). Decide: inline everything (CSS + data + the d3-rendered SVGs serialized) so there's no external dependency, vs. embed vendored d3 + re-render on open. Lean self-contained/no-runtime.
- **Structured data exports** — JSON (the model + cycles + manifest), CSV (per-command / per-event rollups from the cycles seam), and **folded stacks** (already exists: `RPFlame.toFolded` / the Flamegraph "Folded" button — reuse, don't reinvent).
- **Mermaid enrichment** — `toMermaid()` is currently a deliberate *minimal arrow list*. Enrich it for the report: activation bars from spans, `Note over` for durations / cycle counts, coloured `box` grouping for TMM vs TCL VM, `autonumber`. Keep Mermaid's genuine limits (no time-proportional spacing, no free-form crossing arrows) exclusive to the SVG/PNG export — Mermaid stays best for a single event/flow slice.

**Seams already in place / to reuse (do NOT re-parse or re-time):**
- `window.RPParser` / `window.RPModel` — the parsed records + NestNode model (`raw` inclusive µs, `realExecTime` self µs, `flows`, `eventIndex`).
- `window.RPFlame` — `toFlameAgg` / `toFolded` / scope helpers (folded export is done).
- `window.RPCycles` — `ruleStatsRows`, `aggregate` (whole-VS), `reconcile`, `traceCommandStats`; `window.CyclesView` renders the Stats DOM.
- `SeqDiagram` + the existing **SVG / PNG / Mermaid** download buttons in the Sequence toolbar (`an-export-svg` / `an-export-png` / `an-mermaid`) — the report should bundle these rather than duplicate the rendering.
- `manifest.cycles` carries persisted authoritative cycles per session (offline-safe); the Sessions `export`/`import` bundle pattern is the model for assembling a self-contained artifact.

**Hard constraints / lessons carried from Phase 2–4:**
- **No Node/JS runtime on the dev Mac.** Validate pure logic headless with `osascript -l JavaScript` (JavaScriptCore, ES6) using stubbed `window`/`document`, plus a Python cross-check of any arithmetic. Keep test-harness-exercised browser seams **Node-6.9.1-safe** (no optional chaining / nullish / `**`) so `node test/phaseN.js` runs on-box; add a `test/phase5.js`.
- **Worker code is strict ES5 (restnoded Node 6.9.1)** — if any report assembly happens server-side, no const/let/arrow/template-literals; decimal file modes. (Prefer doing report assembly **client-side** — the SPA already holds the model + cycles.)
- **Headless can't catch visual/DOM bugs** — every visual change needs an on-box deploy + hard-refresh per iteration. Watch the recurring `[hidden]` CSS-specificity trap (`[hidden]{display:none}` must out-specify any author `display` rule — bit us on `.modal`, `.an-controls label`, `.field.inline`, `.cycles-banner`) and the `scrollIntoView`-scrolls-the-window trap (scroll within the panel's own box).
- **Self-contained HTML gotchas to verify on-box:** serializing a live d3 SVG (computed styles vs. stylesheet, font availability, `xmlns`), Blob/`URL.createObjectURL` download sizing for large traces, and that pasted/backup traces (no live session) still export. The vendored d3 is ~280 KB — decide whether the report embeds it or ships pre-rendered SVG.
- `grep` is wrapped oddly in this shell and BSD `grep` needs `-E` for `|` — use Read / Python to search.

**Deploy loop (UDF box):** `./build/build-rpm.sh 0.5.0 0001` ; `scp -O -P <port> build/dist/rultracer-0.5.0-0001.noarch.rpm root@<host>:/shared/images/` ; `ssh -p <port> root@<host> /shared/images/install-onbox.sh 0.5.0-0001` ; then hard-refresh. Bump the release number each on-box iteration. New presentation JS files must be added to `build-rpm.sh` staging + `%files`. (Existing boxes already have `/shared/rultracer`; a brand-new box needs the one-time `mkdir -p /shared/rultracer && chown restnoded:restnoded /shared/rultracer` preflight — see `docs/cleanup-prompt.md`.)

**Likely things to clarify with me first:** report granularity (whole session vs. a selected flow/event scope vs. a diff of two captures); exactly which panels the HTML report includes (sequence, flamegraph, stats, source-coverage — all or a chooser); self-contained vs. d3-embedded; how the cycles caveats (profiler-overhead, the flat-sum aggregate assumption, "measured vs derived") carry into a static report; which export formats ship in v1 (HTML / JSON / CSV / folded / Mermaid) and where the export entry point lives (an Analysis toolbar "Export report" button vs. a Sessions action); and the Mermaid enrichment ceiling (how much to add before it's better served by the SVG export).
