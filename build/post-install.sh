#!/usr/bin/env bash
# =============================================================================
# post-install.sh
#
# Required post-install / repair script for rultracer on BIG-IP.
#
# The iApps LX install pipeline does NOT execute RPM %post scriptlets —
# installed packages are visible via /mgmt/shared/iapp/global-installed-packages
# but absent from the system RPM database (`rpm -q rultracer` returns "not
# installed"), confirming the framework extracts the RPM payload directly and
# bypasses the scriptlet machinery. As a result, anything that needs root
# privileges to create directories outside the package tree (specifically
# /shared/rultracer/data — where sessions live, owned by restnoded) must be
# done from a root shell. That's what this script is for.
#
# Idempotent — safe to run any time, no-op if everything is already in place.
#
# Usage from a remote admin host:
#   ssh root@<bigip> bash /var/config/rest/iapps/rultracer/build/post-install.sh
#
# Usage on the BIG-IP directly:
#   /var/config/rest/iapps/rultracer/build/post-install.sh
#
# install-onbox.sh calls this automatically after the INSTALL task completes,
# so iterative dev does not require a separate manual step. Run manually if
# you installed the RPM via the F5 GUI / package-management-tasks REST call
# or if anything looks wrong with the data directory.
# =============================================================================

set -euo pipefail

APP_NAME="rultracer"
PKG_DIR="/var/config/rest/iapps/${APP_NAME}"
DATA_DIR="/shared/${APP_NAME}/data"
SESSIONS_DIR="${DATA_DIR}/sessions"
MARKER="/var/config/rest/iapps/${APP_NAME}-post-install.log"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must be run as root (current uid: $(id -u))"
  echo "  From SSH:  ssh root@<bigip> bash ${PKG_DIR}/build/post-install.sh"
  exit 1
fi

echo "==> ${APP_NAME} post-install / repair script"

# Step 1: confirm the package is actually installed
if [ ! -d "${PKG_DIR}" ]; then
  echo "ERROR: package directory ${PKG_DIR} not found"
  echo "  Is the RPM installed? Check:"
  echo "    curl -sk -u admin:\$PW https://localhost/mgmt/shared/iapp/global-installed-packages | grep ${APP_NAME}"
  exit 1
fi
echo "    package directory: ${PKG_DIR}  OK"

# Step 2: /shared/<app>/ -- root creates it, owned root:root 0755 by default,
# which is fine because we only need the data subtree to be restnoded-owned.
if [ ! -d "/shared/${APP_NAME}" ]; then
  mkdir -p "/shared/${APP_NAME}"
  echo "    parent directory: /shared/${APP_NAME}  CREATED"
else
  echo "    parent directory: /shared/${APP_NAME}  already exists"
fi

# Step 3: data + sessions directories -- this is the bit that the worker
# (uid 198) cannot create itself.
if [ ! -d "${SESSIONS_DIR}" ]; then
  mkdir -p "${SESSIONS_DIR}"
  touch "${DATA_DIR}/audit.jsonl"
  echo "    sessions directory: ${SESSIONS_DIR}  CREATED"
else
  COUNT=$(ls -1 "${SESSIONS_DIR}" 2>/dev/null | wc -l)
  echo "    sessions directory: ${SESSIONS_DIR}  already exists (${COUNT} sessions preserved)"
fi

# Step 4: ownership + mode -- always enforce, harmless if already correct.
# 198 = restnoded (the restnoded process user), 498 = webusers
chown -R 198:498 "${DATA_DIR}"
chmod 0750       "${DATA_DIR}"
echo "    ${DATA_DIR} ownership/mode: 198:498 / 0750  OK"

# Step 5: write a marker so we can tell post-install ran (and from where)
{
  echo "=== ${APP_NAME} post-install.sh run ==="
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  echo "uid=$(id -u) user=$(whoami)"
  echo "source=post-install.sh"
  echo "data_dir=${DATA_DIR}"
  echo "sessions_dir=${SESSIONS_DIR}"
  echo "=== done ==="
} >> "${MARKER}"

# Step 6: show current state for the operator
echo ""
echo "==> Current state:"
ls -ld "/shared/${APP_NAME}" "${DATA_DIR}" "${SESSIONS_DIR}" | sed 's|^|    |'
echo ""
echo "==> Done.  Marker written to ${MARKER}"
echo ""
echo "To verify rultracer is responding:"
echo "  curl -sk -u admin:\$PW https://localhost/mgmt/shared/${APP_NAME}/profiler"
