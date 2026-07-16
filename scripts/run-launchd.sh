#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${CC_TERMINAL_KEYCHAIN_SERVICE:-com.cc-remote-term.web.token}"
ACCOUNT="${CC_TERMINAL_KEYCHAIN_ACCOUNT:-$(id -un)}"
TOKEN="$(/usr/bin/security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w)"

if [ "${#TOKEN}" -lt 32 ]; then
  echo "[cc-terminal] Keychain token is missing or too short. Run npm run token:init." >&2
  exit 1
fi

export CC_TERMINAL_TOKEN="$TOKEN"
unset TOKEN
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
cd "$ROOT"
exec "$ROOT/node_modules/.bin/tsx" server.ts
