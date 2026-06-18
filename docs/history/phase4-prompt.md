# Phase 4 kickoff prompt — Cycles-vs-CPU stats (PLAN.md goal 7)

Paste this into a fresh session to start Phase 4. The repo is clean at tag `phase3`, v0.3.0.

---

Start Phase 4 of rultracer: **Cycles-vs-CPU stats (PLAN.md goal 7)**.

Before writing code, review context: read `PLAN.md` (esp. the phased plan, goal 7, the "How rule-profiler works" timing notes, and risk #2 "Timing source"), the "Phase 3 delivery & lessons" section at the end, the auto-loaded memory (`project_phase3-implemented` has the flamegraph/model module map + APIs), and `git show phase3`. The repo is clean at tag `phase3`, v0.3.0. Then ask clarifying / architectural / style questions before building (my usual flow), and bump to **0.4.0**.

**What Phase 4 is:** the rule-profiler trace carries **timestamps in epoch microseconds** — there is **no cycle field** on the 17.1 VE (confirmed; the 12-field format has no trailing cycle/CPU column). Durations are µs deltas (`tsExit − tsEntry`), already computed in the model as `raw` (inclusive) and `realExecTime` (self). Goal 7 turns those µs into **CPU cycles** and a **%-of-CPU view**, and reconciles with the box's own `ltm rule stats`:

- Fetch CPU facts from the box: clock speed (Hz/MHz) and core count via `/mgmt/tm/sys` (e.g. `/mgmt/tm/sys/hardware`, `/mgmt/tm/sys/cpu`, or `clock`/`host-info` — verify the exact REST path + field on the live box; this is unverified).
- Convert: `cycles ≈ µs × (clockHz / 1e6)`. Surface per-span / per-command / per-event/rule **cycle counts** and **% of a core's budget over the capture window** (capture window wall-clock is in the manifest).
- Reconcile against `ltm rule stats` (REST: confirm the endpoint, likely `/mgmt/tm/ltm/rule/stats` or per-rule `.../stats`) — it reports cycles/executions per rule/event; cross-check our derived numbers and show both with the discrepancy. Treat as best-effort: rule-profiler adds overhead (lab-only), so expect divergence and surface it honestly rather than hiding it.

**Seams already in place / to build:**
- The model (`window.RPModel`) already has `raw` (inclusive µs) and `realExecTime` (self µs) per span, plus `flows`/`eventIndex` and `RPFlame.aggregate`/`commandStats`-style rollups to reuse. **Do not re-parse or re-time** — add a cycle/CPU layer on top.
- PLAN names an "InventoryWorker CPU stub" as the seam, but it was **not actually built in Phase 1–3** — `InventoryWorker.js` has no CPU fetch yet. You'll add a CPU-info fetch there (REST GET to `/mgmt/tm/sys/...`), exposed via the existing `api.js` client, plus a stats fetch for `ltm rule stats`.
- The capture **manifest** records `startWallclock` / offset; capture-window duration is needed to compute %-of-CPU. Confirm what's persisted and add window seconds if missing.

**Where it lives in the UI:** decide with me — likely a new **Stats** sub-tab in the Analysis view (alongside `Sequence | Flamegraph | Diff`), or a column/overlay in the existing step-through / source-coverage. The cycle numbers should also feed the Phase 5 report.

**Hard constraints / lessons carried from Phase 2–3:**
- **No Node/JS runtime on the dev Mac.** Validate pure logic headless with `osascript -l JavaScript` (JavaScriptCore, ES6) using stubbed `window`/`document`, plus a Python cross-check of the arithmetic. Keep test-harness-exercised browser code **Node-6.9.1-safe** (no optional chaining / nullish) so `node test/phase4.js` runs on-box; add a Phase 4 test alongside `test/phase3.js`.
- **Worker code is strict ES5 (restnoded Node 6.9.1)** — `InventoryWorker.js` additions: no const/let/arrow/template-literals, decimal file modes, etc.
- **Headless can't catch visual/DOM bugs** — every visual change needs an on-box deploy + hard-refresh per iteration. Watch the `[hidden]` CSS-specificity trap (`[hidden]{display:none}` must out-specify any author `display` rule) and the `scrollIntoView`-scrolls-the-window trap (scroll within the panel's own box).
- **Live-box unknowns to verify first** (don't assume): exact REST path + field names for CPU clock/core count; the `ltm rule stats` REST shape and its cycle/units semantics; whether multi-blade hardware appends a trailing cycle field to the trace (the VE did not). Surface assumptions; reconcile, don't fabricate.
- `grep` is wrapped oddly in this shell and BSD `grep` needs `-E` for `|` — use Read / Python to search.

**Deploy loop (UDF box):** `./build/build-rpm.sh 0.4.0 0001` ; `scp -O -P 47001 build/dist/rultracer-0.4.0-0001.noarch.rpm root@<udf-host>:/shared/images/` ; `ssh -p 47001 root@<udf-host> /shared/images/install-onbox.sh 0.4.0-0001` ; then hard-refresh. Bump the release number each on-box iteration.

**Likely things to clarify with me first:** the %-of-CPU denominator (single core vs all cores vs the TMM that ran it — and we're single-TMM for now); whether to show cycles per-occurrence or summed; how prominently to show the rule-profiler-overhead caveat; the reconcile UX (side-by-side derived-vs-`rule stats`, or a single number with a discrepancy badge); and where the Stats view lives (new sub-tab vs. augmenting existing panels).
