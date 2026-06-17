# Phase 7 kickoff prompt — Wrap-up / polish (final phase)

Paste this into a fresh session to start Phase 7. The repo should be clean at tag `phase6`, v0.6.0 (Phase 6 multi-TMM shipped).

> Phase 7 is the **optional end-of-project polish** phase from PLAN.md — small quality-of-life adds deliberately deferred to keep Phases 1–6 clean. It is **not** a single feature; it's a menu. Pick with me which items to do (and in what order) before building. All 8 goals are already delivered; this is refinement, not new scope.

---

Start Phase 7 of rultracer: **wrap-up / polish (PLAN.md Phase 7)**.

Before writing code, review context: read `PLAN.md` (esp. the **Phase 7** line in the phased plan, and every **"Deferred (later phases)"** subsection at the ends of the Phase 3 / 5 / 6 delivery write-ups — that's where the backlog lives), the auto-loaded memory (`project_phase6-implemented` has the latest module map + the headless-validation workflow), and `git show phase6`. Then **ask me which polish items to tackle** before building, and bump to **0.7.0** (or `0.6.x` if we agree the changes are minor enough). My usual flow: clarify/confirm scope first, then code.

**Hard constraints / lessons carried from Phases 2–6 (unchanged):**
- **No Node/JS runtime on the dev Mac.** Validate pure logic headless with `osascript -l JavaScript` (JavaScriptCore, ES6) using stubbed `window`/`document`, plus a Python cross-check of any arithmetic. Keep test-harness-exercised pure seams **Node-6.9.1-safe** (no optional chaining / nullish / `**` / arrow in shipped pure seams) so `node test/phaseN.js` runs on-box; add a `test/phase7.js` if a new pure seam appears.
- **Worker code is strict ES5** (restnoded Node 6.9.1) — decimal file modes, no const/let/arrow/template-literals. (Phase 7 is likely browser-only, but note it if any worker change sneaks in.)
- **Headless can't catch visual/DOM bugs** — every visual change needs an on-box deploy + hard-refresh per iteration. Watch the recurring **`[hidden]` CSS-specificity trap** (`[hidden]{display:none}` must out-specify any author `display` rule) and the **`scrollIntoView`-scrolls-the-window trap** (scroll within the panel's own box).
- `grep` is wrapped oddly in this shell and BSD `grep` needs `-E` for `|` — use Read / Python to search.
- **RPM `%files` lists every file explicitly** — any new presentation module / fixture means updating both `build-rpm.sh` staging and `%files`.

**Deploy loop (UDF box):** `./build/build-rpm.sh 0.7.0 0001` ; `scp -O -P <port> build/dist/rultracer-0.7.0-0001.noarch.rpm root@<host>:/shared/images/` ; `ssh -p <port> root@<host> /shared/images/install-onbox.sh 0.7.0-0001` ; then hard-refresh. Bump the release number each on-box iteration.

---

## The Phase 7 backlog (pick from these — none are committed yet)

**A. Inline bytecode opcode hints** *(the headline Phase 7 item from PLAN.md)* — hover tooltip (and/or an opt-in verbose label) on each **bytecode tick** in the sequence diagram mapping the mnemonic to its meaning (`push1` → "push a literal", `storeScalarStk` → "store into a scalar variable", …), reusing the **opcode table already in the collapsed "Bytecode reference" panel** (`index.html`, the `.bc-table`). Kept off-screen so far by request. Single source of truth: drive both the panel table and the tick tooltips from one opcode map. Browser-only; `seqdiagram.js` renders the ticks.

**B. Diff granularity — per-scope diffs.** Today the cross-capture diff compares **whole-capture aggregated** A vs B only. Add the option to diff **one event or flow across captures** (the Phase 6 TMM-overlay already proved the "two arbitrary models into the diff" path — this is the same idea scoped by event/flow instead of by TMM). Reuses `RPFlame.diffMerge` + `FlameView`.

**C. Literal-flamegraph repeat capping/collapsing.** Literal whole-capture can stack many graphs (one per event execution — ~20 for the sample). Left uncapped intentionally; a "collapse repeats / show top N" polish would tame huge captures. `flamegraph.js` `renderMany` + the scope plumbing in `analysis.js`.

**D. CSV report rollups.** Phase 5 shipped HTML + JSON + Mermaid + folded. A per-command / per-event **CSV** export would round out the data formats — the data is already in the `RPCycles`/`RPReportData` seams; this is a formatter + a download wire-up in the report modal.

**E. Whole-capture Mermaid.** Mermaid stays a single-slice export by design (no time-proportional spacing, no free-form crossing arrows). Revisit only if a coarse whole-capture Mermaid is genuinely wanted; the SVG already handles whole-capture detail.

**F. Cleanup pass.** A separate, ready-to-run housekeeping prompt lives at **`docs/cleanup-prompt.md`** (dead code, consistency, the brand-new-box `mkdir -p /shared/rultracer && chown restnoded: …` preflight note, etc.). Can fold into Phase 7 or run standalone.

**G. Anything that accrued during on-box validation** of Phases 4–6 (those were committed with on-box validation left as the user's call — if anything surfaced, fix it here).

---

**Likely things to clarify with me first:** which of A–G to do this session and in what order; whether to bump `0.7.0` or stay on a `0.6.x` point release; for **A**, tooltip-only vs. an opt-in verbose-label toggle in the sequence controls; for **B**, whether per-scope diff is a new control or folds into the existing Scope dropdown semantics; and whether the **cleanup pass (F)** runs as part of Phase 7 or stays its own pass.
