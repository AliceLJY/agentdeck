#!/bin/bash
# Build and restart cc-terminal in production mode
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[agentdeck] Building..."
npm run build

echo "[agentdeck] Restarting..."
LABEL="com.agentdeck.web"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  # bootout + bootstrap, not `kickstart -k`: kickstart races the outgoing
  # process for the listening socket, and the failure mode is the deceptive
  # one — launchd reports the job as started while nothing is bound to the
  # port and the log gains no new lines.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 3
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "[agentdeck] Restarted (bootout + bootstrap)."
else
  echo "[agentdeck] $LABEL is not loaded; bootstrap the LaunchAgent first." >&2
  exit 1
fi
