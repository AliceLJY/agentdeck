#!/bin/bash
set -euo pipefail

SERVICE="${CC_TERMINAL_KEYCHAIN_SERVICE:-com.cc-remote-term.web.token}"
ACCOUNT="${CC_TERMINAL_KEYCHAIN_ACCOUNT:-$(id -un)}"
TOKEN="$(/usr/bin/security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w)"

if [ "${#TOKEN}" -lt 32 ]; then
  echo "[cc-terminal] Refusing to copy a missing or short Keychain token." >&2
  exit 1
fi
if ! command -v pbcopy >/dev/null 2>&1; then
  echo "[cc-terminal] pbcopy is unavailable on this machine." >&2
  exit 1
fi

printf '%s' "$TOKEN" | pbcopy
unset TOKEN
echo "[cc-terminal] Token copied to the clipboard without printing it."
