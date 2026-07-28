#!/bin/bash

agentdeck_load_token() {
  local home="${HOME:?HOME is required}"
  # AGENTDECK_* is the current spelling; CC_TERMINAL_* and the old config
  # directory are the pre-rename ones, honoured so an upgrade in place still
  # finds the token it already has.
  local token_file="${AGENTDECK_TOKEN_FILE:-${CC_TERMINAL_TOKEN_FILE:-}}"
  if [ -z "$token_file" ]; then
    token_file="$home/.config/agentdeck/token"
    [ -f "$token_file" ] || token_file="$home/.config/cc-remote-term/token"
  fi
  local mode owner

  if [ -L "$token_file" ] || [ ! -f "$token_file" ]; then
    echo "[agentdeck] Token file is missing or is a symbolic link ($token_file). Run npm run token:init." >&2
    return 1
  fi
  if ! mode="$(/usr/bin/stat -f '%Lp' "$token_file" 2>/dev/null)" || \
    ! owner="$(/usr/bin/stat -f '%u' "$token_file" 2>/dev/null)"; then
    echo "[agentdeck] Token file metadata could not be verified." >&2
    return 1
  fi
  if [ "$owner" != "$(id -u)" ] || [ "$mode" != "600" ]; then
    echo "[agentdeck] Token file must be owned by the current user with mode 600." >&2
    return 1
  fi

  AGENTDECK_TOKEN_VALUE="$(<"$token_file")"
  if ! [[ "$AGENTDECK_TOKEN_VALUE" =~ ^[0-9a-f]{64}$ ]]; then
    unset AGENTDECK_TOKEN_VALUE
    echo "[agentdeck] Token file must contain exactly one 64-character hex token." >&2
    return 1
  fi
}
