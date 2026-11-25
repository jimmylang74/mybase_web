#!/usr/bin/env bash
# =============================================================================
# build_deb.sh — build an Ubuntu/Debian .deb for Web of Mybase Knowledge Server
#
# Usage:
#   ./build_deb.sh
#
# Output:
#   ./dist/mybase_<version>_<arch>.deb
#
# Design notes:
#   * Application is installed to /opt/mybase.
#   * The service runs with WorkingDirectory=/opt/mybase and "--data data",
#     so user data lives in /opt/mybase/data — exactly the same relative
#     layout as the existing source checkout / running service.
#   * ./data/ user content is NEVER copied into the .deb. Only empty
#     directories are created by the package maintainer scripts.
#   * An existing, unmanaged /etc/systemd/system/mybase.service (or
#     /lib/systemd/system/mybase.service) blocks a fresh install, so the
#     currently running service cannot be overwritten by accident.
# No application source files are modified by this script.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

for tool in dpkg-deb dpkg python3; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: required tool not found: $tool" >&2
        exit 1
    }
done

[ -f VERSION ] || { echo "ERROR: VERSION file not found" >&2; exit 1; }
[ -f mybase.py ] || { echo "ERROR: mybase.py not found" >&2; exit 1; }

RAW_VERSION="$(tr -d '[:space:]' < VERSION)"
DEB_VERSION="${RAW_VERSION#v}"
if [[ ! "$DEB_VERSION" =~ ^[0-9] ]]; then
    echo "ERROR: cannot derive Debian version from VERSION='$RAW_VERSION'" >&2
    exit 1
fi

PKG_NAME="mybase"
ARCH="${ARCH:-$(dpkg --print-architecture)}"
OUT_DIR="$SCRIPT_DIR/dist"
DEB_FILE="$OUT_DIR/${PKG_NAME}_${DEB_VERSION}_${ARCH}.deb"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mybase-deb.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
STAGE="$WORK_DIR/${PKG_NAME}_${DEB_VERSION}_${ARCH}"

mkdir -p "$STAGE/DEBIAN" \
         "$STAGE/etc/default" \
         "$STAGE/lib/systemd/system" \
         "$STAGE/opt/mybase"

# -----------------------------------------------------------------------------
# Application files. Copy explicitly so ./data/ can never slip into the .deb.
# -----------------------------------------------------------------------------
cp -p mybase.py VERSION requirements.txt "$STAGE/opt/mybase/"
cp -p README.md "$STAGE/opt/mybase/" 2>/dev/null || true
for dir in web models pdf_fonts doc; do
    if [ -d "$dir" ]; then
        cp -a "$dir" "$STAGE/opt/mybase/"
    fi
done

# Strip Python bytecode / caches from the staging tree.
find "$STAGE/opt/mybase" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE/opt/mybase" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete 2>/dev/null || true

if [ -e "$STAGE/opt/mybase/data" ]; then
    echo "ERROR: user data directory was accidentally staged; aborting" >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# systemd unit
# -----------------------------------------------------------------------------
cat > "$STAGE/lib/systemd/system/mybase.service" <<'UNIT'
[Unit]
Description=Web of Mybase Knowledge Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mybase
Group=mybase
WorkingDirectory=/opt/mybase
Environment=PYTHONUNBUFFERED=1
Environment=HOME=/var/lib/mybase
EnvironmentFile=-/etc/default/mybase
ExecStart=/opt/mybase/venv/bin/python /opt/mybase/mybase.py $MYBASE_ARGS
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$STAGE/lib/systemd/system/mybase.service"

# -----------------------------------------------------------------------------
# Configuration (dpkg conffile — preserved across upgrades)
# -----------------------------------------------------------------------------
cat > "$STAGE/etc/default/mybase" <<'DEFAULT'
# Extra arguments passed to /opt/mybase/mybase.py.
# "data" is relative to WorkingDirectory=/opt/mybase => /opt/mybase/data.
# Use an absolute path here if you want to store data elsewhere, e.g.
#   MYBASE_ARGS="--port 9999 --data /var/lib/mybase/data"
MYBASE_ARGS="--port 9999 --data data"

# Set to 1 to skip pip install of Python dependencies (offline installs).
MYBASE_SKIP_PIP=0

# Set to 1 to install/upgrade without auto-starting the service.
MYBASE_NO_START=0
DEFAULT
chmod 0644 "$STAGE/etc/default/mybase"

printf '/etc/default/mybase\n' > "$STAGE/DEBIAN/conffiles"

# -----------------------------------------------------------------------------
# Maintainer scripts
# -----------------------------------------------------------------------------
cat > "$STAGE/DEBIAN/preinst" <<'PREINST'
#!/bin/sh
set -e

# Refuse a fresh install if an existing mybase.service is not owned by this
# package. This protects an already running service (e.g. a source checkout
# installed manually) from being silently replaced.
if [ "$1" = "install" ]; then
    for unit in /etc/systemd/system/mybase.service /lib/systemd/system/mybase.service; do
        if [ -e "$unit" ]; then
            owner="$(dpkg-query -S "$unit" 2>/dev/null | head -n 1 || true)"
            case "$owner" in
                "mybase: "*) ;;
                *)
                    echo "ERROR: $unit already exists and is not managed by the mybase package." >&2
                    echo "Refusing to overwrite it, so the existing mybase.service is not affected." >&2
                    echo "To replace it intentionally, rename/remove that unit first and retry." >&2
                    exit 1
                    ;;
            esac
        fi
    done
fi
PREINST

cat > "$STAGE/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e

APP=/opt/mybase
DATA="$APP/data"
VENV="$APP/venv"
SERVICE_HOME=/var/lib/mybase

# /etc/default/mybase is a conffile; keep user edits on upgrade.
if [ -r /etc/default/mybase ]; then
    . /etc/default/mybase
fi

# ---- service account --------------------------------------------------------
if ! getent group mybase >/dev/null 2>&1; then
    addgroup --system mybase >/dev/null
fi
if ! getent passwd mybase >/dev/null 2>&1; then
    adduser --system --ingroup mybase --home "$SERVICE_HOME" \
            --no-create-home --disabled-login mybase >/dev/null
fi

# ---- mutable directories (NOT shipped in the .deb) --------------------------
mkdir -p "$DATA/db/index_db" "$DATA/mybase" "$DATA/user" "$SERVICE_HOME"
chown -R mybase:mybase "$DATA" "$SERVICE_HOME"
chmod 0750 "$DATA" "$SERVICE_HOME"

# mybase.py writes its log to BASE_DIR/mybase.log (= /opt/mybase/mybase.log).
touch "$APP/mybase.log"
chown mybase:mybase "$APP/mybase.log"
chmod 0640 "$APP/mybase.log"

# ---- Python virtualenv ------------------------------------------------------
if [ ! -x "$VENV/bin/python" ]; then
    python3 -m venv "$VENV"
fi

DEPS_OK=1
if [ "${MYBASE_SKIP_PIP:-0}" != "1" ]; then
    if ! "$VENV/bin/python" -m pip install --no-cache-dir -r "$APP/requirements.txt"; then
        DEPS_OK=0
        echo "WARNING: failed to install Python dependencies; mybase.service may not start." >&2
    fi
else
    DEPS_OK=0
fi

# ---- enable / start service -------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable mybase.service >/dev/null 2>&1 || true

    if [ -d /run/systemd/system ] && [ "$DEPS_OK" = "1" ] && \
       [ "${MYBASE_NO_START:-0}" != "1" ]; then
        systemctl start mybase.service || \
            echo "WARNING: mybase.service failed to start; check 'journalctl -u mybase'." >&2
    fi
fi

echo "mybase installed."
echo "  Application : $APP"
echo "  User data   : $DATA (created empty; existing content is preserved)"
echo "  Config      : /etc/default/mybase"
echo "  Service     : mybase.service (enabled)"
POSTINST

cat > "$STAGE/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
if command -v systemctl >/dev/null 2>&1; then
    systemctl stop mybase.service >/dev/null 2>&1 || true
fi
PRERM

cat > "$STAGE/DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
    if command -v systemctl >/dev/null 2>&1; then
        systemctl disable mybase.service >/dev/null 2>&1 || true
        systemctl daemon-reload >/dev/null 2>&1 || true
    fi
fi

if [ "$1" = "purge" ]; then
    rm -rf /opt/mybase/venv /opt/mybase/mybase.log /var/lib/mybase
    # NOTE: /opt/mybase/data is intentionally kept — it belongs to the user.
fi
POSTRM

chmod 0755 "$STAGE/DEBIAN/preinst" "$STAGE/DEBIAN/postinst" \
           "$STAGE/DEBIAN/prerm" "$STAGE/DEBIAN/postrm"

# -----------------------------------------------------------------------------
# Control file (Installed-Size computed from the staged tree)
# -----------------------------------------------------------------------------
INSTALLED_KB="$(du -sk "$STAGE" | awk '{print $1}')"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $DEB_VERSION
Section: net
Priority: optional
Architecture: $ARCH
Depends: adduser, ca-certificates, python3 (>= 3.10), python3-venv, systemd | systemd-sysv
Installed-Size: $INSTALLED_KB
Maintainer: Mybase <admin@localhost>
Description: Web of Mybase Knowledge Server
 A self-hosted knowledge base server with full-text search and OCR support.
 Installs to /opt/mybase and enables mybase.service.
 User data in /opt/mybase/data is created on install and is not bundled.
EOF

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------
mkdir -p "$OUT_DIR"
dpkg-deb -Zxz -z6 --build --root-owner-group "$STAGE" "$DEB_FILE" >/dev/null

echo "Created: $DEB_FILE"
echo "Version: $DEB_VERSION   Arch: $ARCH"
echo "Size:    $(du -h "$DEB_FILE" | awk '{print $1}')"
echo "Data dir at install: /opt/mybase/data (empty; no ./data content packaged)"
