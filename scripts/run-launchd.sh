#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"
# shellcheck source=token-lib.sh
source "$SCRIPT_DIR/token-lib.sh"

agentdeck_load_token
export AGENTDECK_TOKEN="$AGENTDECK_TOKEN_VALUE"
unset AGENTDECK_TOKEN_VALUE
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
cd "$ROOT"
exec "$ROOT/node_modules/.bin/tsx" server.ts
