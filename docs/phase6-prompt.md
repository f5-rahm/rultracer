# Phase 6 kickoff prompt — Multi-TMM & trace layering (PLAN.md goal-7 deferral)

Paste this into a fresh session to start Phase 6. The repo is clean at tag `phase5`, v0.5.0.

> ✅ **Ground truth captured (2026-06-17) — no longer hardware-gated for the VE case.** The dev box is a **4-TMM VE** (`show sys tmm-info`: TMMs 0.0–0.3, all sharing **one process, pid 11313**). A concurrent-traffic capture (`ab -c 32`) lives at **`background info/raw_capture.txt`** and resolved the unknowns below. **Use that file as the Phase 6 fixture.** One thing is still genuinely deferred to real **multi-blade hardware** (separate `tmm` processes): whether the syslog prefix becomes `tmmN[pid]:` and whether a trailing 13th CSV field appears — design the partition so a future `tmmN`-prefix key can slot in, but build/validate against the VE ground truth now.

---

Start Phase 6 of rultracer: **Multi-TMM & trace layering (the goal-7/visualization deferral, PLAN.md Phase 6)**.

Before writing code, review context: read `PLAN.md` (esp. the "Multi-TMM" locked-decision row, the **"Browser parser"** and **Risks #3** sections, the Phase 6 line in the phased plan, and how v1 "ignores `ctxId`/per-TMM partitioning"), the auto-loaded memory (`project_phase5-implemented` and `project_phase4-implemented` have the module map + the headless-validation workflow), and `git show phase5`. The repo is clean at tag `phase5`, v0.5.0. Then ask clarifying / architectural / style questions before building (my usual flow), and bump to **0.6.0**.

**Confirmed ground truth (from `background info/raw_capture.txt`, a 4-TMM VE under concurrent load):**
- **Partition key = field 5 (`ctxId`) = the per-TMM worker-thread id.** The 4 logical TMMs are *threads of one process* (shared pid 11313), so each has its own thread id; the main thread's id equals the pid. The capture shows **two distinct `ctxId` values** (`11313` over 4 flows, `11674` over 1 flow) — proof the field varies per TMM and is the partition key. (`ab` from one client only reached 2 of the 4 TMMs; the mechanism is what matters.) The earlier single-TMM VE had `ctxId 22623 ≠ pid 22555`, consistent with a thread id, NOT the pid and NOT a 0–3 index.
- **The syslog prefix `tmm[pid]:` is the shared process — useless for splitting TMMs on this box.** Partition by `ctxId`, never the prefix. (On real multi-blade hardware the prefix *may* become `tmmN[pid]:` with separate pids — keep the design able to fall back to a prefix key there; the parser's `PREFIX_RE = /tmm\d*\[\d+\]:\s+/` already matches both forms.)
- **A flow pins to exactly one TMM.** No `flowId` appeared under two `ctxId`s in the capture (flow handles are unique within the shared-memory process). `flowId` alone is sufficient as the connection key, but **key the partition by `(ctxId, flowId)`** for robustness against any theoretical cross-TMM handle reuse on other platforms.
- **Still deferred to multi-blade hardware:** the `tmmN[pid]` prefix question, the possible trailing 13th CSV field (PLAN Risks #2/#3), and the per-TMM start "alert" text. None block the VE build.

**What Phase 6 is (the locked direction from planning):** partition the trace **by TMM**, then offer three views (PLAN.md "Multi-TMM" row + "Browser parser"):
- **single-TMM (default)** — pick one TMM, render exactly as today.
- **interleaved / raw** — all TMMs in one timeline.
- **trace layering / overlay** — `layers([...])` to compare/stack two TMMs' forests.

**Seams already in place / to reuse (do NOT re-parse or re-time; keep them TMM-agnostic underneath):**
- `window.RPParser` already strips `tmm\d*\[\d+\]:` and carries **`record.ctxId`** (field 5, `parser.js:94`) — that **is** the confirmed partition key; no parser change needed to *read* it. Phase 6 partitions records by `ctxId` (compose with `flowId`) before building forests.
- `window.RPModel.build(records)` builds the per-flow NestNode forest; the Phase 6 wrapper should partition records by TMM **first**, then build a forest per TMM (the eventual design in "Browser parser": `singleTmm()` / `interleaved()` / `layers([...])`).
- Everything downstream is already forest-driven and TMM-agnostic: `SeqDiagram`, `StepThrough`, `SourceMap`, `RPFlame` (+ the Phase 3 diff is the natural basis for **overlay/layering**), `RPCycles`, and the Phase 5 `RPReportData` report. A TMM selector should slot in next to the existing **Group by (flow / event)** control.

**Hard constraints / lessons carried from Phase 2–5:**
- **No Node/JS runtime on the dev Mac.** Validate pure logic headless with `osascript -l JavaScript` (JavaScriptCore, ES6) using stubbed `window`/`document`, plus a Python cross-check of any arithmetic. Keep test-harness-exercised browser seams **Node-6.9.1-safe** (no optional chaining / nullish / `**` / arrow-in-shipped-pure-seams) so `node test/phaseN.js` runs on-box; add a `test/phase6.js`. **The multi-TMM fixture already exists** at `background info/raw_capture.txt` (2 distinct `ctxId`s) — use it to test the partition; consider promoting a copy into `presentation/fixtures/` as a bundled multi-TMM example (and add it to `build-rpm.sh` staging + `%files`).
- **Worker code is strict ES5 (restnoded Node 6.9.1)** — if capture/worker changes are needed for multi-TMM, no const/let/arrow/template-literals; decimal file modes.
- **Headless can't catch visual/DOM bugs** — every visual change needs an on-box deploy + hard-refresh per iteration. Watch the recurring `[hidden]` CSS-specificity trap (`[hidden]{display:none}` must out-specify any author `display` rule) and the `scrollIntoView`-scrolls-the-window trap (scroll within the panel's own box).
- `grep` is wrapped oddly in this shell and BSD `grep` needs `-E` for `|` — use Read / Python to search.

**Deploy loop (UDF box):** `./build/build-rpm.sh 0.6.0 0001` ; `scp -O -P <port> build/dist/rultracer-0.6.0-0001.noarch.rpm root@<host>:/shared/images/` ; `ssh -p <port> root@<host> /shared/images/install-onbox.sh 0.6.0-0001` ; then hard-refresh. Bump the release number each on-box iteration. New presentation JS files must be added to `build-rpm.sh` staging + `%files`. (A brand-new box needs the one-time `mkdir -p /shared/rultracer && chown restnoded: /shared/rultracer` preflight — trailing colon, no group named restnoded; see `docs/cleanup-prompt.md`.)

**Likely things to clarify with me first** (the partition key is settled — `ctxId`): how the TMM selector composes with the existing flow/event grouping (a third grouping axis vs. a separate "TMM" dropdown that scopes the others); how a TMM should be *labelled* in the UI (raw `ctxId` thread id like `11313`/`11674` is opaque — map to `TMM 0..N` by sort order? expose the raw id on hover?); what "overlay/layering" should compare (same logical flow across two TMMs? aggregate load balance across TMMs?) and whether it reuses the Phase 3 diff machinery or a new view; whether cycles/Stats should aggregate across TMMs or stay per-TMM (note: `ltm rule stats` + the CPU budget are already whole-box, so Stats likely needs no change); and how multi-TMM surfaces in the Phase 5 report (per-TMM sections vs a TMM chooser at export).
