#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"
# shellcheck source=token-lib.sh
source "$SCRIPT_DIR/token-lib.sh"

cc_terminal_load_token
export CC_TERMINAL_TOKEN="$CC_TERMINAL_TOKEN_VALUE"
unset CC_TERMINAL_TOKEN_VALUE
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
cd "$ROOT"
exec "$ROOT/node_modules/.bin/tsx" server.ts
