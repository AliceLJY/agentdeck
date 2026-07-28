#!/bin/bash
# Build and restart cc-terminal in production mode
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[agentdeck] Building..."
npm run build

echo "[agentdeck] Restarting..."
LABEL="com.agentdeck.web"
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
  echo "[agentdeck] Restart requested through launchd."
else
  echo "[agentdeck] $LABEL is not loaded; bootstrap the LaunchAgent first." >&2
  exit 1
fi
