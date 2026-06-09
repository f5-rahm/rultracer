#!/bin/bash
# =============================================================================
# install-onbox.sh
#
# Iterative installer for rultracer, run ON the BIG-IP. Designed for envs
# where iControl REST file-transfer is unavailable (UDF, proxied networks)
# and RPMs land in /shared/images/ via scp.
#
# Default behavior is INSTALL-in-place (upgrade): if rultracer is already
# installed, we just POST INSTALL with the new package and let the iApps LX
# framework replace it. This preserves /var/config/rest/iapps/rultracer/data/
# across upgrades because plain RPM upgrade only touches files in %files.
# UNINSTALL (which wipes the whole package directory tree, including data/)
# is opt-in via --reinstall.
#
# Usage (on the BIG-IP):
#   /shared/images/install-onbox.sh <version-release> [--reinstall]
#
# Examples:
#   /shared/images/install-onbox.sh 0.1.0-0015               # in-place upgrade
#   /shared/images/install-onbox.sh 0.1.0-0015 --reinstall   # wipe + install
#
# Iteration workflow (from your laptop):
#   ./build/build-rpm.sh 0.1.0 0016
#   scp -O -P <port> build/dist/rultracer-0.1.0-0016.noarch.rpm \
#       root@<host>:/shared/images/
#   ssh -p <port> root@<host> /shared/images/install-onbox.sh 0.1.0-0016
# =============================================================================

set -euo pipefail

VERREL="${1:?usage: $0 <version-release> [--reinstall]   e.g. 0.1.0-0015}"
MODE="${2:-upgrade}"
case "$MODE" in
  --reinstall|reinstall) MODE=reinstall ;;
  upgrade|"")            MODE=upgrade ;;
  *) echo "ERROR: unknown mode: $MODE (use --reinstall to force UNINSTALL+INSTALL)"; exit 1 ;;
esac

PKG="rultracer"
RPM="${PKG}-${VERREL}.noarch.rpm"
SRC="/shared/images/${RPM}"
DST_DIR="/var/config/rest/downloads"
DST="${DST_DIR}/${RPM}"
PKG_DIR="/var/config/rest/iapps/${PKG}"

API="http://localhost:8100/mgmt/shared/iapp/package-management-tasks"
PKG_LIST="http://localhost:8100/mgmt/shared/iapp/global-installed-packages"
CURL="curl -s -u admin:"

# ---- helpers --------------------------------------------------------------
json_field() {
  python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('$1', ''))
except Exception:
    pass
"
}

poll_task() {
  local id="$1" label="$2"
  local i=0
  while [ $i -lt 60 ]; do
    sleep 3
    i=$((i+1))
    local body status
    body=$($CURL "$API/$id")
    status=$(echo "$body" | json_field status)
    [ -z "$status" ] && status="?"
    printf "  [%2d/60] %s: %s\n" "$i" "$label" "$status"
    case "$status" in
      FINISHED) return 0 ;;
      FAILED)
        echo "  --- task body ---"
        echo "$body" | python -m json.tool 2>/dev/null || echo "$body"
        return 1
        ;;
    esac
  done
  echo "ERROR: $label timed out after 3 minutes"
  return 1
}

list_installed_rultracer() {
  $CURL "$PKG_LIST" 2>/dev/null | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for p in d.get('items', []):
        name = p.get('packageName') or p.get('name') or ''
        if name.startswith('${PKG}'):
            print(name.replace('.noarch', '').strip())
except Exception:
    pass
" 2>/dev/null || true
}

uninstall_existing() {
  local installed; installed=$(list_installed_rultracer)
  if [ -z "$installed" ]; then echo "    none installed."; return 0; fi
  for OLDPKG in $installed; do
    echo "==> Uninstalling existing: $OLDPKG"
    local resp id
    resp=$($CURL "$API" -H 'Content-Type: application/json' \
      -d "{\"operation\":\"UNINSTALL\",\"packageName\":\"$OLDPKG\"}")
    id=$(echo "$resp" | json_field id)
    if [ -n "$id" ]; then
      poll_task "$id" "uninstall" || echo "  (uninstall task failed -- continuing)"
    else
      echo "  (no task id returned; response was: $resp)"
    fi
  done
}

# ---- 0. preflight ---------------------------------------------------------
[ -f "$SRC" ] || { echo "ERROR: $SRC not found (scp it there first)"; exit 1; }
[ -d "$DST_DIR" ] || mkdir -p "$DST_DIR"

# Provision the persistent data dir under /shared/ BEFORE restnoded reloads,
# because:
#   (a) the iApps LX install pipeline skips RPM %post scriptlets on some TMOS
#       versions (rulbased PLANNING.md lesson learned), so we can't trust it;
#   (b) the restnoded process runs as uid 198, which cannot create directories
#       under /shared/ (root:root 0755). We're root in install-onbox.sh, so we
#       do it here. Idempotent.
SHARED_DATA="/shared/${PKG}/data"
SHARED_SESSIONS="${SHARED_DATA}/sessions"
echo "==> Preflight: ensuring ${SHARED_DATA} exists (restnoded uid 198 can't create under /shared/)"
mkdir -p "${SHARED_SESSIONS}"
[ -f "${SHARED_DATA}/audit.jsonl" ] || touch "${SHARED_DATA}/audit.jsonl"
chown -R 198:498 "/shared/${PKG}"
chmod 0750 "${SHARED_DATA}"
PREEXISTING=$(ls -1 "${SHARED_SESSIONS}" 2>/dev/null | wc -l)
echo "    ${SHARED_DATA}  ready  (sessions on disk: ${PREEXISTING})"

# ---- 1. uninstall path is opt-in -----------------------------------------
if [ "$MODE" = "reinstall" ]; then
  echo "==> --reinstall: removing existing rultracer (this WIPES /var/config/rest/iapps/rultracer/data)"
  echo "    use \"Download backup\" in the Sessions tab first if you want to keep them."
  uninstall_existing
else
  EXISTING=$(list_installed_rultracer)
  if [ -n "$EXISTING" ]; then
    echo "==> Existing install detected: $EXISTING"
    echo "    using in-place upgrade (data/ preserved). Pass --reinstall to wipe."
  else
    echo "==> No existing install -- fresh install."
  fi
fi

# ---- 2. move RPM into the install landing dir -----------------------------
echo "==> Moving $RPM -> $DST_DIR"
mv -f "$SRC" "$DST"
ls -la "$DST" | sed 's/^/    /'

# ---- 3. install (in-place upgrade if a previous version is installed) -----
echo "==> Installing $RPM"
RESP=$($CURL "$API" -H 'Content-Type: application/json' \
  -d "{\"operation\":\"INSTALL\",\"packageFilePath\":\"$DST\"}")
ID=$(echo "$RESP" | json_field id)
[ -n "$ID" ] || { echo "ERROR: install task did not return an id: $RESP"; exit 1; }
echo "    task: $ID"

if ! poll_task "$ID" "install"; then
  echo
  echo "==> INSTALL failed. If the framework rejects in-place upgrade on your TMOS,"
  echo "    re-run with --reinstall to force UNINSTALL+INSTALL (this WIPES data/)."
  exit 1
fi

# ---- 4. run the packaged post-install.sh ----------------------------------
# The iApps LX install pipeline bypasses RPM %post scriptlets, so anything that
# needs root + /shared/ access has to come from a root-shell script. We've
# already done a preflight above, but running the packaged post-install.sh
# matches the rulbased pattern (the script is also the documented manual
# repair path for operators who installed via the F5 GUI or a raw REST call).
POST_INSTALL="${PKG_DIR}/build/post-install.sh"
echo
echo "==> Running packaged post-install.sh"
if [ -f "$POST_INSTALL" ]; then
  chmod +x "$POST_INSTALL" 2>/dev/null || true
  bash "$POST_INSTALL" || echo "  (post-install.sh exit non-zero; check the output above)"
else
  echo "  WARNING: $POST_INSTALL not found -- preflight already ran, but the package may not include post-install.sh."
fi

# ---- 5. verify ------------------------------------------------------------
echo
echo "==> Verification"
echo "    restnoded.log (recent rultracer lines):"
grep -i rultracer /var/log/restnoded/restnoded.log 2>/dev/null | tail -15 | sed 's/^/      /' \
  || echo "      (no matches yet -- restnoded may still be reloading)"
echo
echo "    GET /mgmt/shared/rultracer/profiler:"
$CURL http://localhost:8100/mgmt/shared/rultracer/profiler 2>&1 | sed 's/^/      /'
echo
if [ -f /var/config/rest/iapps/rultracer-post-install.log ]; then
  echo "    %post marker:"
  sed 's/^/      /' /var/config/rest/iapps/rultracer-post-install.log
fi
SESSIONS_DIR=/shared/rultracer/data/sessions
if [ -d "$SESSIONS_DIR" ]; then
  COUNT=$(ls -1 "$SESSIONS_DIR" 2>/dev/null | wc -l)
  echo "    sessions preserved: $COUNT in $SESSIONS_DIR"
fi
echo
HOST=$(hostname -s 2>/dev/null || echo BIGIP)
echo "==> Done.  UI:  https://${HOST}/mgmt/shared/rultracer/ui/"
