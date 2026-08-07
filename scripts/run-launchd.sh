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

# Build before exec. Without this, `repos-autopull` updates the code every 4h and
# HEAD looks right, but `.next` stays whatever it was — the UI silently serves an
# old build with no error anywhere to notice. Observed twice: 2026-07-30 (~4h
# stale) and 2026-08-07 (mini stuck on an 08-03 build, this machine on 07-19).
#
# A failed build must NOT take the service down: losing the remote entry point is
# worse than serving a stale build that says so in the log. So warn loudly and
# start on whatever `.next` exists. `if` keeps `set -e` from killing us here.
if npm run build; then
  echo "[run-launchd] next build ok — serving current code"
else
  echo "[run-launchd] ⚠️  NEXT BUILD FAILED — starting on the existing .next, which may be STALE." >&2
  echo "[run-launchd]     Fix the build, then bootout+bootstrap to pick up current code." >&2
fi

exec "$ROOT/node_modules/.bin/tsx" server.ts
