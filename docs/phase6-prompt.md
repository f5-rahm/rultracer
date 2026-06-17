# Phase 6 kickoff prompt — Multi-TMM & trace layering (PLAN.md goal-7 deferral)

Paste this into a fresh session to start Phase 6. The repo is clean at tag `phase5`, v0.5.0.

> ⚠️ **Hardware-gated — read first.** Every capture so far came from a **single-TMM VE**, and the parser/model were deliberately kept TMM-agnostic *pending* a real multi-TMM trace. Phase 6 cannot be validated (and shouldn't be designed in detail) without a **multi-TMM BIG-IP** to capture from. If no multi-TMM hardware is available, **do not build this yet** — instead run the **cleanup pass** (`docs/cleanup-prompt.md`, already written: docs reorg + canonical deploy procedure, docs-only) and/or **Phase 7 wrap-up/polish** (inline bytecode opcode hints + accrued QoL — see PLAN.md "Phase 7"). Confirm hardware availability with me before writing any Phase 6 code.

---

Start Phase 6 of rultracer: **Multi-TMM & trace layering (the goal-7/visualization deferral, PLAN.md Phase 6)**.

Before writing code, review context: read `PLAN.md` (esp. the "Multi-TMM" locked-decision row, the **"Browser parser"** and **Risks #3** sections, the Phase 6 line in the phased plan, and how v1 "ignores `ctxId`/per-TMM partitioning"), the auto-loaded memory (`project_phase5-implemented` and `project_phase4-implemented` have the module map + the headless-validation workflow), and `git show phase5`. The repo is clean at tag `phase5`, v0.5.0. Then ask clarifying / architectural / style questions before building (my usual flow), and bump to **0.6.0**.

**The blocker to resolve up front:** we need a **real multi-TMM capture** to ground the design — several unknowns can only be answered from a live multi-TMM box (do NOT assume; PLAN.md Risks #3):
- **Per-TMM line tagging** — the syslog prefix on multi-TMM hardware is typically `tmmN[pid]:` (vs the VE's bare `tmm[pid]:`). Confirm the exact form and that the parser's prefix-strip (`/^.*\btmm\d*\[\d+\]:\s+/`) already captures `N`.
- **`ctxId` (field 5) meaning** — on the VE it differed from the prefix pid; confirm what it is per TMM and whether it, the prefix `tmmN`, or both is the reliable TMM partition key.
- **flowId uniqueness across TMMs** — is a flowId globally unique, or can two TMMs reuse one? Decides whether the partition key is `tmm` alone or `(tmm, flowId)`.
- **The per-TMM start "alert" text** rule-profiler emits on a multi-TMM run (mentioned in the source articles) — capture a real one.

**What Phase 6 is (the locked direction from planning):** partition the trace **by TMM**, then offer three views (PLAN.md "Multi-TMM" row + "Browser parser"):
- **single-TMM (default)** — pick one TMM, render exactly as today.
- **interleaved / raw** — all TMMs in one timeline.
- **trace layering / overlay** — `layers([...])` to compare/stack two TMMs' forests.

**Seams already in place / to reuse (do NOT re-parse or re-time; keep them TMM-agnostic underneath):**
- `window.RPParser` already strips `tmm\d*\[\d+\]:` and carries `ctxId` per record — the partition key is likely already in the parsed record; confirm against a real trace.
- `window.RPModel.build(records)` builds the per-flow NestNode forest; the Phase 6 wrapper should partition records by TMM **first**, then build a forest per TMM (the eventual design in "Browser parser": `singleTmm()` / `interleaved()` / `layers([...])`).
- Everything downstream is already forest-driven and TMM-agnostic: `SeqDiagram`, `StepThrough`, `SourceMap`, `RPFlame` (+ the Phase 3 diff is the natural basis for **overlay/layering**), `RPCycles`, and the Phase 5 `RPReportData` report. A TMM selector should slot in next to the existing **Group by (flow / event)** control.

**Hard constraints / lessons carried from Phase 2–5:**
- **No Node/JS runtime on the dev Mac.** Validate pure logic headless with `osascript -l JavaScript` (JavaScriptCore, ES6) using stubbed `window`/`document`, plus a Python cross-check of any arithmetic. Keep test-harness-exercised browser seams **Node-6.9.1-safe** (no optional chaining / nullish / `**` / arrow-in-shipped-pure-seams) so `node test/phaseN.js` runs on-box; add a `test/phase6.js`. **You will also need a real multi-TMM fixture** committed under `presentation/fixtures/` (or `background info/`) — without it the partition logic is untestable.
- **Worker code is strict ES5 (restnoded Node 6.9.1)** — if capture/worker changes are needed for multi-TMM, no const/let/arrow/template-literals; decimal file modes.
- **Headless can't catch visual/DOM bugs** — every visual change needs an on-box deploy + hard-refresh per iteration. Watch the recurring `[hidden]` CSS-specificity trap (`[hidden]{display:none}` must out-specify any author `display` rule) and the `scrollIntoView`-scrolls-the-window trap (scroll within the panel's own box).
- `grep` is wrapped oddly in this shell and BSD `grep` needs `-E` for `|` — use Read / Python to search.

**Deploy loop (UDF box):** `./build/build-rpm.sh 0.6.0 0001` ; `scp -O -P <port> build/dist/rultracer-0.6.0-0001.noarch.rpm root@<host>:/shared/images/` ; `ssh -p <port> root@<host> /shared/images/install-onbox.sh 0.6.0-0001` ; then hard-refresh. Bump the release number each on-box iteration. New presentation JS files must be added to `build-rpm.sh` staging + `%files`. (A brand-new box needs the one-time `mkdir -p /shared/rultracer && chown restnoded: /shared/rultracer` preflight — trailing colon, no group named restnoded; see `docs/cleanup-prompt.md`.)

**Likely things to clarify with me first:** whether a multi-TMM box is actually available (gates the whole phase); the TMM partition key (`tmmN` prefix vs `ctxId` vs `(tmm, flowId)`) once we see a real trace; how the TMM selector composes with the existing flow/event grouping (a third grouping axis vs. a separate "TMM" dropdown that scopes the others); what "overlay/layering" should compare (same flow across two TMMs? aggregate load balance across TMMs?) and whether it reuses the Phase 3 diff machinery or a new view; whether cycles/Stats should aggregate across TMMs or stay per-TMM; and how multi-TMM surfaces in the Phase 5 report (per-TMM sections vs a TMM chooser at export).
