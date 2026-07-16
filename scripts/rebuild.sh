#!/bin/bash
# Build and restart cc-terminal in production mode
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[cc-terminal] Building..."
npm run build

echo "[cc-terminal] Restarting..."
LABEL="com.cc-remote-term.web"
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
  echo "[cc-terminal] Restart requested through launchd."
else
  echo "[cc-terminal] $LABEL is not loaded; bootstrap the LaunchAgent first." >&2
  exit 1
fi
