#!/usr/bin/env bash
# =============================================================================
# build-rpm.sh
#
# Builds the rultracer iApps LX RPM locally using rpmbuild. No BIG-IP
# connection or credentials required. Modeled on rulbased's macOS-friendly
# pattern (https://github.com/f5-rahm/rulbased).
#
# Prerequisites:
#   macOS:        brew install rpm
#   RHEL/CentOS:  sudo yum install rpm-build
#   Ubuntu:       sudo apt install rpm
#
# Usage:
#   ./build/build-rpm.sh [VERSION] [RELEASE]
#
# Examples:
#   ./build/build-rpm.sh              # defaults: 0.2.0-0001
#   ./build/build-rpm.sh 0.2.0 0003
#
# Output:
#   build/dist/rultracer-<VERSION>-<RELEASE>.noarch.rpm
# =============================================================================

set -euo pipefail

VERSION="${1:-0.5.0}"
RELEASE="${2:-0002}"
APP_NAME="rultracer"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_ROOT="$SCRIPT_DIR/.rpmbuild"
DIST_DIR="$SCRIPT_DIR/dist"

echo "==> Building ${APP_NAME}-${VERSION}-${RELEASE}.noarch.rpm"

mkdir -p "$DIST_DIR"
mkdir -p "$BUILD_ROOT"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

# ---------------------------------------------------------------------------
# Stage source files into the rpmbuild BUILD directory.
# ---------------------------------------------------------------------------
STAGE="$BUILD_ROOT/BUILD/${APP_NAME}"
rm -rf "$STAGE"
mkdir -p "$STAGE/nodejs/lib"
mkdir -p "$STAGE/presentation/css"
mkdir -p "$STAGE/presentation/js"
mkdir -p "$STAGE/presentation/fixtures"
mkdir -p "$STAGE/presentation/vendor"
mkdir -p "$STAGE/build"

cp "$SRC_DIR/manifest.json"          "$STAGE/"
cp "$SRC_DIR/block_template.json"    "$STAGE/"
cp "$SRC_DIR/nodejs/index.js"        "$STAGE/nodejs/"
cp "$SRC_DIR/nodejs/lib/"*.js        "$STAGE/nodejs/lib/"
cp "$SRC_DIR/presentation/index.html" "$STAGE/presentation/"
cp "$SRC_DIR/presentation/css/"*.css  "$STAGE/presentation/css/"
cp "$SRC_DIR/presentation/js/"*.js    "$STAGE/presentation/js/"
cp "$SRC_DIR/presentation/fixtures/"*.txt "$STAGE/presentation/fixtures/"
cp "$SRC_DIR/presentation/vendor/"*    "$STAGE/presentation/vendor/"

cp "$SRC_DIR/build/post-install.sh" "$STAGE/build/"
chmod 0755 "$STAGE/build/post-install.sh"

echo "    Staged files:"
find "$STAGE" -type f | sed 's|^|      |'

# ---------------------------------------------------------------------------
# Generate the SPEC file.
#
# STAGE is interpolated as a literal absolute path so rpmbuild does not need
# to resolve %{_builddir} — this avoids a macOS rpmbuild (Homebrew) quirk
# where %{_builddir} expands to a "<n>-<version>-build" subdirectory rather
# than the BUILD root we staged into.
#
# %install copies "${STAGE}/." (not "${STAGE}/*") to avoid shell-glob trouble
# inside the SPEC. %files lists every shipped file explicitly so macOS rpm
# does not complain about untracked files.
# ---------------------------------------------------------------------------
SPEC_FILE="$BUILD_ROOT/SPECS/${APP_NAME}.spec"

cat > "$SPEC_FILE" << SPEC
Name:       ${APP_NAME}
Version:    ${VERSION}
Release:    ${RELEASE}
Summary:    rultracer — visual debugger and profiler for iRules
License:    Apache-2.0
BuildArch:  noarch
Vendor:     f5devcentral

%description
rultracer is an iApps LX extension that wraps the tmsh-only ltm rule-profiler
into a visual iRules debugger and profiler: configure the profiler, capture
trace output, and analyse it as a TMM<->TCL VM sequence diagram, step-through,
flamegraph, and report — all served from the BIG-IP.

%install
mkdir -p %{buildroot}/var/config/rest/iapps/${APP_NAME}
cp -r ${STAGE}/. %{buildroot}/var/config/rest/iapps/${APP_NAME}/

%post
MARKER="/var/config/rest/iapps/${APP_NAME}-post-install.log"
{
  echo "=== ${APP_NAME} %post scriptlet run ==="
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  echo "uid=\$(id -u) whoami=\$(whoami)"
} > "\$MARKER" 2>&1 || true

# Session/state directory under /shared/ -- survives iApps LX INSTALL (which
# wipes the entire package tree under /var/config/rest/iapps/<pkg>/ even on
# in-place upgrade). %post runs as root, so it can create the directory and
# hand it to restnoded for runtime read/write.
DATA_DIR="/shared/${APP_NAME}/data"
SESSIONS_DIR="\$DATA_DIR/sessions"
# Ensure /shared/<APP>/ exists too -- only its data/ subtree is restnoded-owned.
mkdir -p "/shared/${APP_NAME}" 2>>"\$MARKER" || true
if [ ! -d "\$SESSIONS_DIR" ]; then
  mkdir -p "\$SESSIONS_DIR"
  touch "\$DATA_DIR/audit.jsonl"
  logger -t ${APP_NAME} "Data directory initialised at \$DATA_DIR"
  echo "data_dir_created=\$DATA_DIR" >> "\$MARKER"
else
  COUNT=\$(ls -1 "\$SESSIONS_DIR" 2>/dev/null | wc -l)
  echo "data_dir_preexisting=\$DATA_DIR (sessions: \$COUNT preserved)" >> "\$MARKER"
fi

# restnoded runs as uid 198; chown so the workers can read/write at runtime.
chown -R 198:498 "\$DATA_DIR" 2>>"\$MARKER" || echo "data_dir_chown_failed" >> "\$MARKER"
chmod 0750       "\$DATA_DIR" 2>>"\$MARKER" || echo "data_dir_chmod_failed" >> "\$MARKER"

echo "=== %post complete ===" >> "\$MARKER"

# Do NOT bigstart restart restnoded — the iApps LX framework handles that.
# If %post is silently skipped (some TMOS versions), run build/post-install.sh
# via SSH to complete setup.
exit 0

%preun
if [ "\$1" = "0" ]; then
  logger -t ${APP_NAME} "Package removed — session data retained at /shared/${APP_NAME}/data (delete manually if desired)"
fi
exit 0

%files
/var/config/rest/iapps/${APP_NAME}/manifest.json
/var/config/rest/iapps/${APP_NAME}/block_template.json
/var/config/rest/iapps/${APP_NAME}/nodejs/index.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/InventoryWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/ProfilerWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/SessionWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/TrafficWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/UiWorker.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/capture.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/configProcessor.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/cpustats.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/engine.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/iremote.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/logchain.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/logger.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/profiler.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/restutil.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/settings.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/store.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/tmsh.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/util.js
/var/config/rest/iapps/${APP_NAME}/nodejs/lib/validate.js
/var/config/rest/iapps/${APP_NAME}/presentation/index.html
/var/config/rest/iapps/${APP_NAME}/presentation/css/app.css
/var/config/rest/iapps/${APP_NAME}/presentation/js/api.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/app.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/parser.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/model.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/flame.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/cycles.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/seqdiagram.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/stepthrough.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/sourcemap.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/flamegraph.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/cyclesview.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/reportdata.js
/var/config/rest/iapps/${APP_NAME}/presentation/js/analysis.js
/var/config/rest/iapps/${APP_NAME}/presentation/vendor/d3.v7.min.js
/var/config/rest/iapps/${APP_NAME}/presentation/vendor/d3-flamegraph.min.js
/var/config/rest/iapps/${APP_NAME}/presentation/vendor/d3-flamegraph.css
/var/config/rest/iapps/${APP_NAME}/presentation/vendor/LICENSES.md
/var/config/rest/iapps/${APP_NAME}/presentation/fixtures/example-logs.txt
/var/config/rest/iapps/${APP_NAME}/presentation/fixtures/example-irule.txt
%attr(0755, -, -) /var/config/rest/iapps/${APP_NAME}/build/post-install.sh
SPEC

# ---------------------------------------------------------------------------
# Run rpmbuild
# ---------------------------------------------------------------------------
echo "==> Running rpmbuild..."
rpmbuild \
  --define "_topdir $BUILD_ROOT" \
  --define "_builddir $BUILD_ROOT/BUILD" \
  --define "_rpmdir $BUILD_ROOT/RPMS" \
  -bb "$SPEC_FILE" \
  2>&1 | sed 's/^/    /'

# Target the exact filename this run was supposed to produce; using a wildcard
# would pick up stale RPMs from previous iterations and ship the wrong version.
EXPECTED_RPM="${APP_NAME}-${VERSION}-${RELEASE}.noarch.rpm"
RPM_FILE=$(find "$BUILD_ROOT/RPMS" -name "$EXPECTED_RPM" | head -1)
if [ -z "$RPM_FILE" ]; then
  echo "ERROR: ${EXPECTED_RPM} not found in $BUILD_ROOT/RPMS — check rpmbuild output above"
  exit 1
fi

cp "$RPM_FILE" "$DIST_DIR/"
DIST_RPM="$DIST_DIR/$(basename "$RPM_FILE")"

echo ""
echo "==> Build complete: $DIST_RPM"
echo ""
echo "Install on BIG-IP:"
echo "  BIGIP_PASS=<password> ./build/install-rpm.sh <host> <user> $DIST_RPM"
