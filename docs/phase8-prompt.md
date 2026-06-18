# Phase 8 kickoff prompt — Bytecode disassembler (v0.8.0)

Paste this into a fresh session to build Phase 8. The repo should be clean at tag
`phase7` (**v0.7.1**). This is the **first phase past the original 8 goals** — a
net-new feature, not polish. **Stay on 0.x** (target **v0.8.0**); do **not** label
anything "v1" — 1.x waits for substantial real-world feedback/use.

---

Start Phase 8 of rultracer: **the Tcl bytecode disassembler**. Before writing code,
read the **"Phase 8 — Bytecode disassembler (spec)"** section at the end of `PLAN.md`
(the locked-decisions table + the **Prototype outcomes** subsection), skim
`docs/ARCHITECTURE.md`, and read `proto/disasm-proto.js` (the throwaway prototype
whose exec-wrapper is already validated on-box — lift its logic into the worker).
My flow: confirm scope, then code.

## What it is (one paragraph)

`ltm rule-profiler` drops the operand a bytecode pushes (the trace shows `push1`,
never `# "3"`). This feature adds a `tcl::unsupported::disassemble`-backed
**scratchpad** so a user can paste a Tcl snippet and get the box's own bytecode
back **with operands intact** — the static "what the compiler produced" companion
to the live trace. It lives in the (renamed) **"Bytecode reference & disassembler"**
panel and reuses the Phase 7 `opcodes.js` map for tooltips.

## Already validated on-box (do not re-litigate)

- `tclsh` = `/usr/bin/tclsh`; **uid 198 can exec it** (so we use `execFile`, NOT the
  `util/bash` root channel). Tcl **8.5.13**; `tcl::unsupported::disassemble` present.
- **Transport = env var** (`RULTRACER_DISASM_BODY`) with a fixed wrapper on stdin.
  The body is passed as **data** to `disassemble script $body`, never spliced into
  the command. **Injection probe proved safe**: `exec touch …` compiled but did not
  run. `disassemble` compiles, it does not execute.
- **Version caveat (load-bearing):** tclsh is 8.5.13 but the **iRule engine is 8.4.6**.
  Bytecode is *close, not identical* (e.g. `startCommand` is an 8.5-ism not in the
  trace). The UI must label output "Tcl 8.5.13 disassembly (approximates the 8.4.6
  iRule engine)". See PLAN for the confirmed format + the 16-opcode seed list.

## Locked decisions (full table in PLAN.md)

- **Home:** expand the collapsed "Bytecode reference" panel; rename to **"Bytecode
  reference & disassembler"**. The static opcode table stays as a section.
- **Input (0.8.0):** free-form **paste box only**. No source-coupling / tick-jump yet.
- **Extension commands:** **guidance + tooltips only** ("replace `[HTTP::host]` with a
  literal like `\"example.com\"`"). No auto-stubbing.
- **`when {}` blocks:** **auto-strip the handler wrapper, disassemble the body, WITH
  warnings.** NOT just `when EVENT {` — modifiers (`priority N`, `timing on|off`) legally
  sit between the event and the body brace, and a standalone `timing off` can sit outside
  any handler. Match `/\bwhen\s+[A-Z][A-Z0-9_]*\b[^{]*\{/` (capture to the **first `{`
  after the `when` header**), then **brace-count** to the matching `}`. Warn on multiple
  handlers / unbalanced braces; discard anything outside a handler's braces. Full rule +
  the legal-form examples are in the PLAN.md **"`when`-block extraction (precise rule)"**
  subsection. Confirmed necessary: a raw `when` block compiles its body as a string literal.
- **Output:** two views, **checkbox toggle** (mirror "Collapse bytecodes"): (1) raw
  tclsh text, (2) structured table (pc · opcode · operands · `# literal`), opcodes
  cross-linked to `opcodes.js` tooltips.
- **Gating:** **settings toggle, default OFF (opt-in)**. New `settings.js` flag
  (`disasmEnabled`). **In-panel toggle only** — no global Settings view in 0.8.0.
- **Endpoint:** new dedicated **`DisasmWorker`** at `POST /mgmt/shared/rultracer/disasm`.
- **Opcode dictionary:** expand `opcodes.js` from 7 to a **~20–40 common subset**
  (seed list in PLAN); unknowns fall back to the raw mnemonic; tag the 8.5-isms.

## Build order

1. **`opcodes.js` expansion** (pure seam, already exists). Add the ~20–40 common opcodes
   (PLAN seed list) with meanings; flag `startCommand`/`incrScalarStkImm` as 8.5-only.
   Extend `test/phase7.js` (or fold into `test/phase8.js`) for the new entries.
2. **`DisasmWorker.js`** (`nodejs/lib`, strict ES5). `POST /disasm {script}` →
   `{ ok, output, warnings[] }`. Lift the validated wrapper from `proto/disasm-proto.js`
   (execFile `tclsh`, body via env var, wrapper on stdin, timeout + output cap). Refuse
   with a clear envelope when `settings.disasmEnabled` is false. Register in `manifest.json`.
3. **`disasm.js`** (NEW pure seam, `window.RPDisasm`, Node-6.9.1-safe). Parse raw tclsh
   output → `{ meta:{cmds,inst,stkDepth,…}, commands:[{src, instructions:[{pc,opcode,operands,comment}]}], warnings }`.
   Parser gotchas in PLAN (truncated `Source` header, `Exception ranges` block, empty
   Command blocks, comment-less operands). Also the `when`-strip helper (brace-aware) lives
   here or alongside. **`test/phase8.js`** drives it against captured fixtures.
4. **UI** in `index.html` + `app.js` (+ maybe a small `disasmview.js`): expand the
   `.bc-ref` panel — paste box, Disassemble button, raw/table toggle, the abstraction
   guidance note, the version-mismatch label, warnings area, and the **Enable
   disassembler** control when the flag is off. Wire `API.disasm()` in `api.js`.
5. **`settings.js`**: add `disasmEnabled: false` to `DEFAULTS`; a GET/POST path to read/flip
   it (smallest surface — likely a route on an existing worker or the new one).
6. **Packaging:** add `disasm.js` (+ any `disasmview.js`) and `DisasmWorker.js` to
   `build-rpm.sh` staging **and** `%files`; bump version `0.7.1 → 0.8.0`
   (`configProcessor.js` + `build-rpm.sh` default).

## Hard constraints / lessons (carried from Phases 1–7)

- **Worker code is strict ES5** (restnoded Node 6.9.1): `var`/`function`, no
  arrow/const/let/template-literals, decimal file modes, Promises ok. `DisasmWorker`
  + the `settings` plumbing are workers.
- **Pure seams (`disasm.js`, `opcodes.js`) stay Node-6.9.1-safe** so `node test/phase8.js`
  runs on-box. Forbidden = `**` / optional chaining / nullish / async-await; arrows/const
  are fine but match the file's existing style (`opcodes.js`/`tmm.js` are var/function).
- **No Node on the dev Mac.** Validate pure logic headless via `osascript -l JavaScript`
  (JSC) + `new Function(src)` parse-checks; the worker/tclsh round-trip only proves out
  on-box (the prototype already did).
- **Headless can't catch visual/DOM bugs** — every UI change needs an on-box deploy +
  hard-refresh. Watch the `[hidden]` specificity trap (now handled globally) and the
  `scrollIntoView`-scrolls-the-window trap.
- **RPM `%files` lists every file explicitly** — new worker/seam/view means updating both
  `build-rpm.sh` staging and `%files`.
- **Security:** keep `disasm` OFF the root channel (execFile as uid 198), compile-only,
  body-as-data, timeout + size caps. The `DisasmWorker` is `isPublic` behind restnoded
  auth like the others; the default-OFF flag is the extra gate.

## Deploy loop (UDF box)

`./build/build-rpm.sh 0.8.0 0001` ; `scp -O -P <port> build/dist/rultracer-0.8.0-0001.noarch.rpm root@<host>:/shared/images/` ;
`ssh -p <port> root@<host> /shared/images/install-onbox.sh 0.8.0-0001` ; then hard-refresh.
Bump the release number each on-box iteration.

## Open implementation calls (confirm with me first)

- Where the `disasmEnabled` GET/POST lives (route on `DisasmWorker` vs a tiny settings route).
- Exact `disasm.js` return shape + how the table view renders nested/empty Command blocks.
- Whether to surface the `Cmds/inst/stkDepth` cost summary in the UI (cheap, informative).
- Prefill the paste box with the `expr 3 * 4` example.

**Cleanup:** delete `proto/disasm-proto.js` once the worker lands (it was a throwaway).
