#!/bin/bash
# Build and restart cc-terminal in production mode
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[cc-terminal] Building..."
npm run build

echo "[cc-terminal] Restarting..."
# Kill existing process if running
pkill -f "tsx server.ts" 2>/dev/null || true
sleep 1

NODE_ENV=production nohup tsx server.ts > /tmp/cc-terminal.log 2>&1 &
echo "[cc-terminal] Started (PID: $!). Logs: /tmp/cc-terminal.log"
