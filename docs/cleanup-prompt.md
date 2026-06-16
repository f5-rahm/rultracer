# Cleanup phase kickoff prompt — docs reorg + canonical deploy procedure

Paste this into a fresh session for the cleanup/polish pass. Run it after the
latest feature phase ships; the repo should be clean at its tag. This is a
docs-and-hygiene pass — bump only a patch version (or none) unless code changes.

---

Start the rultracer **cleanup phase**: documentation reorganization + a canonical
deploy procedure. No new features. Before editing, read `PLAN.md`, `README.md`,
and the auto-loaded memory; the repo is clean at the latest phase tag.

## 1. Canonical deploy procedure (capture the manual steps that live only in my head)

Add a single authoritative deploy section — in `README.md` under **Usage**, or a
new `docs/deploy.md` linked from the README. **Anonymize** the host and port as
`<host>` / `<port>` (no real UDF hostnames). It must include the **one-time
preflight** that's currently a manual step before the *first* install on a box:

```bash
# ── One-time, before the FIRST install on a given BIG-IP ──────────────────────
# iApps LX wipes the package dir (/var/config/rest/iapps/rultracer/) on EVERY
# install, so persistent session data lives under /shared/rultracer/. Create it
# once and hand it to the worker's user (restnoded, uid 198) so the worker can
# create its data subdir there:
ssh -p <port> root@<host> 'mkdir -p /shared/rultracer && chown restnoded:restnoded /shared/rultracer'

# ── Each deploy ───────────────────────────────────────────────────────────────
./build/build-rpm.sh <version> <release>
scp -O -P <port> build/dist/rultracer-<version>-<release>.noarch.rpm \
    root@<host>:/shared/images/
ssh -p <port> root@<host> /shared/images/install-onbox.sh <version>-<release>
# then hard-refresh the browser UI. Bump <release> each on-box iteration.
```

- Verify the exact worker user/group on the box (memory: workers run as **uid 198**;
  the data dir under `/shared/rultracer/` is created by the worker, so it must own
  the parent). Confirm `restnoded:restnoded` is correct before publishing it.
- **Consider eliminating the manual step:** `install-onbox.sh`'s preflight is
  supposed to provision `/shared/rultracer` as root — check why it still needs a
  manual `mkdir`/`chown` (likely it creates the dir but doesn't `chown` it to the
  worker). If safe, fold the `mkdir -p` + `chown restnoded:restnoded` into the
  preflight so the one-time step disappears, and update the doc to match. See the
  `feedback_shared-data-needs-preflight` memory for the install-wipe context.

## 2. Slim the README to **usage + features only**

`README.md` should describe what rultracer is, its features, and how to install/
use/deploy it — nothing about the build-out history. Remove the phase-by-phase
narrative, the "viable/goal" tables, the design rationale, and the
delivery/lessons commentary.

## 3. Move all planning/phase info into `PLAN.md`

Anything stripped from the README that's planning, phase history, goals, risks,
or design rationale belongs in `PLAN.md` (which already holds the phased plan and
the per-phase "delivery & lessons" sections). Consolidate — don't duplicate; if
PLAN already covers it, just delete it from the README.

## Constraints / conventions
- Phases commit straight to `main` + an annotated tag; tags map to versions
  (phase3→v0.3.0, phase4.1→v0.4.1). A docs-only cleanup can be a patch bump or no
  bump — confirm with me.
- New presentation/JS files must be added to `build-rpm.sh` staging + `%files`
  (not relevant for a docs-only pass, but check if any code moves).
- No Node on the dev Mac; validate any touched JS seam via `osascript -l JavaScript`.
