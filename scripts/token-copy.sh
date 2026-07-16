#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=token-lib.sh
source "$SCRIPT_DIR/token-lib.sh"

cc_terminal_load_token
if ! command -v pbcopy >/dev/null 2>&1; then
  unset CC_TERMINAL_TOKEN_VALUE
  echo "[cc-terminal] pbcopy is unavailable on this machine." >&2
  exit 1
fi

printf '%s' "$CC_TERMINAL_TOKEN_VALUE" | pbcopy
unset CC_TERMINAL_TOKEN_VALUE
echo "[cc-terminal] Token copied to the clipboard without printing it."
