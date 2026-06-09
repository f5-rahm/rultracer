# rultracer

An F5 BIG-IP iControl LX / iApps LX extension that turns the tmsh-only
`ltm rule-profiler` iRule tracer into a visual debugger and profiler.

It runs **on the BIG-IP**: an on-box Node worker configures the profiler, captures
the trace stream to a per-session file, and serves it to a browser SPA that parses
and visualizes it (TMM ↔ TCL VM sequence diagram, step-through, flamegraph, stats,
report). See [PLAN.md](PLAN.md) for the full design and phased plan.

## Status

Phase 1 (capture core): profiler setup + bounded capture + session persistence + teardown.

## Layout

```
manifest.json         iControl LX package manifest
nodejs/               on-box workers (run in restnoded, Node 6.9.1 -> ES5)
  lib/                shared helpers + RestWorkers
presentation/         browser SPA (vanilla JS, no build step)
build/                RPM build + install scripts
test/                 zero-dependency test harness (node test/unit.js)
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
