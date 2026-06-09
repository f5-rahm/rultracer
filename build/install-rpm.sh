#!/usr/bin/env bash
# =============================================================================
# install-rpm.sh
#
# Uploads and installs the rultracer RPM on a target BIG-IP. This is the ONLY
# script that requires BIG-IP credentials. Modeled on rulbased's pattern
# (https://github.com/f5-rahm/rulbased).
#
# NOTE: Use the BIG-IP 'admin' account (or another admin-role account).
#       The 'root' OS account is blocked from iControl REST by design.
#
# Usage:
#   bash ./build/install-rpm.sh <host> <user> <rpm-file>
#
# If BIGIP_PASS is unset, you'll be prompted interactively. Set BIGIP_PASS in
# the environment for CI/non-interactive use.
#
# Examples:
#   bash ./build/install-rpm.sh 192.168.1.245 admin build/dist/rultracer-0.1.0-0001.noarch.rpm
#   BIGIP_PASS=secret bash ./build/install-rpm.sh 192.168.1.245 admin <rpm>
#
# Uninstall:
#   BIGIP_PASS=secret bash ./build/install-rpm.sh <host> <user> --uninstall rultracer
# =============================================================================

set -euo pipefail

BIGIP_HOST="${1:?Usage: bash install-rpm.sh <host> <user> <rpm-file>}"
BIGIP_USER="${2:?Usage: bash install-rpm.sh <host> <user> <rpm-file>}"
ARG3="${3:?Usage: bash install-rpm.sh <host> <user> <rpm-file> | --uninstall <package>}"

if [ -z "${BIGIP_PASS:-}" ]; then
  if [ ! -t 0 ]; then
    echo "ERROR: BIGIP_PASS is not set and stdin is not a TTY."
    echo "  Either set BIGIP_PASS=<password> in the environment,"
    echo "  or run the script from an interactive terminal."
    echo "  NOTE: use the BIG-IP admin account, not root."
    exit 1
  fi
  printf "Password for %s@%s: " "${BIGIP_USER}" "${BIGIP_HOST}"
  read -rs BIGIP_PASS
  echo ""
  if [ -z "${BIGIP_PASS:-}" ]; then echo "ERROR: password cannot be empty"; exit 1; fi
fi

BIGIP_URL="https://${BIGIP_HOST}/mgmt"
TASK_URL="${BIGIP_URL}/shared/iapp/package-management-tasks"

check_auth() {
  local response="$1"; local step="$2"
  if echo "$response" | grep -q "401 Unauthorized"; then
    echo ""
    echo "ERROR: 401 Unauthorized at step: ${step}"
    echo "  Most likely cause: using 'root' instead of an admin-role account."
    echo "  BIG-IP blocks root from iControl REST by design."
    echo "  Try: ./build/install-rpm.sh ${BIGIP_HOST} admin <rpm>"
    exit 1
  fi
  if echo "$response" | grep -q "<!DOCTYPE\|<html"; then
    echo ""
    echo "ERROR: BIG-IP returned an HTML error page at step: ${step}"
    echo "Response: ${response}"
    exit 1
  fi
}

json_field() {
  local body="$1"; local field="$2"
  echo "$body" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('${field}',''))" 2>/dev/null || true
}

poll_task() {
  local id="$1"; local label="$2"
  local attempts=0; local max=40
  while [ $attempts -lt $max ]; do
    sleep 5
    attempts=$((attempts + 1))
    local body
    body="$(curl -sk -u "${BIGIP_USER}:${BIGIP_PASS}" "${TASK_URL}/${id}")"
    check_auth "$body" "task status poll"
    local status; status="$(json_field "$body" status)"
    [ -z "$status" ] && status="UNKNOWN"
    echo "    [${attempts}/${max}] ${label} ${status}"
    if [ "$status" = "FINISHED" ]; then return 0; fi
    if [ "$status" = "FAILED" ]; then
      echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
      return 1
    fi
  done
  echo "ERROR: ${label} timed out after $((max*5))s — check /var/log/restnoded/restnoded.log"
  return 1
}

# ---------------------------------------------------------------------------
# Uninstall mode
# ---------------------------------------------------------------------------
if [ "$ARG3" = "--uninstall" ]; then
  PKG="${4:?Usage: --uninstall <packageName>}"
  echo "==> Uninstalling ${PKG} from ${BIGIP_HOST}..."
  RESP="$(curl -sk -u "${BIGIP_USER}:${BIGIP_PASS}" \
    -H "Content-Type: application/json" -X POST "${TASK_URL}" \
    -d "{\"operation\":\"UNINSTALL\",\"packageName\":\"${PKG}\"}")"
  check_auth "$RESP" "uninstall task creation"
  ID="$(json_field "$RESP" id)"
  [ -z "$ID" ] && { echo "ERROR: no task id in response: $RESP"; exit 1; }
  poll_task "$ID" "uninstall"
  exit $?
fi

# ---------------------------------------------------------------------------
# Install mode
# ---------------------------------------------------------------------------
RPM_FILE="$ARG3"
if [ ! -f "$RPM_FILE" ]; then echo "ERROR: RPM file not found: $RPM_FILE"; exit 1; fi
RPM_NAME="$(basename "$RPM_FILE")"

echo "==> Uploading ${RPM_NAME} to ${BIGIP_HOST}..."
RPM_SIZE=$(wc -c < "$RPM_FILE" | tr -d ' ')
CONTENT_RANGE="0-$((RPM_SIZE - 1))/${RPM_SIZE}"

UPLOAD_RESPONSE=$(curl -sk \
  -u "${BIGIP_USER}:${BIGIP_PASS}" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Range: ${CONTENT_RANGE}" \
  -H "Content-Length: ${RPM_SIZE}" \
  -H "Connection: keep-alive" \
  -X POST \
  "${BIGIP_URL}/shared/file-transfer/uploads/${RPM_NAME}" \
  --data-binary "@${RPM_FILE}")
check_auth "$UPLOAD_RESPONSE" "file upload"

LOCAL_PATH="$(json_field "$UPLOAD_RESPONSE" localFilePath)"
[ -z "$LOCAL_PATH" ] && LOCAL_PATH="/var/config/rest/downloads/${RPM_NAME}"
echo "    Uploaded to: ${LOCAL_PATH}"

echo "==> Triggering package install task..."
TASK_RESPONSE=$(curl -sk \
  -u "${BIGIP_USER}:${BIGIP_PASS}" \
  -H "Content-Type: application/json" \
  -X POST "${TASK_URL}" \
  -d "{\"operation\":\"INSTALL\",\"packageFilePath\":\"${LOCAL_PATH}\"}")
check_auth "$TASK_RESPONSE" "install task creation"

TASK_ID="$(json_field "$TASK_RESPONSE" id)"
[ -z "$TASK_ID" ] && { echo "ERROR: no task id in response: $TASK_RESPONSE"; exit 1; }
echo "==> Install task ID: ${TASK_ID} — polling..."

poll_task "$TASK_ID" "install" || exit 1

POST_INSTALL_PATH="/var/config/rest/iapps/rultracer/build/post-install.sh"
cat <<DONE

==> Step 2 complete: RPM uploaded and installed.

==> Step 3: (optional) run the post-install/repair script on the BIG-IP if
    %post was skipped by the install pipeline. It's idempotent.

    ssh root@${BIGIP_HOST} bash ${POST_INSTALL_PATH}

==> Step 4: verify workers registered

    ssh root@${BIGIP_HOST} "grep -i rultracer /var/log/restnoded/restnoded.log | tail"
    curl -sk -u ${BIGIP_USER}:'***' ${BIGIP_URL}/shared/rultracer/profiler

==> Step 5: open the UI

    ${BIGIP_URL}/shared/rultracer/ui

DONE
