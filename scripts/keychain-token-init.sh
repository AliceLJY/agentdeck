#!/bin/bash
set -euo pipefail

SERVICE="${CC_TERMINAL_KEYCHAIN_SERVICE:-com.cc-remote-term.web.token}"
ACCOUNT="${CC_TERMINAL_KEYCHAIN_ACCOUNT:-$(id -un)}"
TOKEN="$(openssl rand -hex 32)"

if ! command -v pbcopy >/dev/null 2>&1; then
  unset TOKEN
  echo "[cc-terminal] pbcopy is required to initialize the macOS Keychain token." >&2
  exit 1
fi

printf '%s' "$TOKEN" | pbcopy
echo "[cc-terminal] A new token is on the clipboard. Paste it into each hidden Keychain prompt."

# Passing a password with security(1)'s -w VALUE form exposes it in process
# arguments. The prompt form keeps it out of argv and terminal logs.
if ! /usr/bin/security add-generic-password \
  -U \
  -a "$ACCOUNT" \
  -s "$SERVICE" \
  -w; then
  unset TOKEN
  echo "[cc-terminal] Could not store the token in login Keychain." >&2
  exit 1
fi

if ! STORED_TOKEN="$(/usr/bin/security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null)" || \
  [ "$STORED_TOKEN" != "$TOKEN" ]; then
  unset TOKEN STORED_TOKEN
  echo "[cc-terminal] Keychain verification failed." >&2
  exit 1
fi
unset STORED_TOKEN

unset TOKEN
echo "[cc-terminal] New token stored in login Keychain and kept on the clipboard."
