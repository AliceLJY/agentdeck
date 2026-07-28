#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=token-lib.sh
source "$SCRIPT_DIR/token-lib.sh"

agentdeck_load_token
if ! command -v pbcopy >/dev/null 2>&1; then
  unset AGENTDECK_TOKEN_VALUE
  echo "[agentdeck] pbcopy is unavailable on this machine." >&2
  exit 1
fi

printf '%s' "$AGENTDECK_TOKEN_VALUE" | pbcopy
unset AGENTDECK_TOKEN_VALUE
echo "[agentdeck] Token copied to the clipboard without printing it."
