#!/bin/bash

cc_terminal_load_token() {
  local token_file="${CC_TERMINAL_TOKEN_FILE:-${HOME:?HOME is required}/.config/cc-remote-term/token}"
  local mode owner

  if [ -L "$token_file" ] || [ ! -f "$token_file" ]; then
    echo "[cc-terminal] Token file is missing or is a symbolic link. Run npm run token:init." >&2
    return 1
  fi
  if ! mode="$(/usr/bin/stat -f '%Lp' "$token_file" 2>/dev/null)" || \
    ! owner="$(/usr/bin/stat -f '%u' "$token_file" 2>/dev/null)"; then
    echo "[cc-terminal] Token file metadata could not be verified." >&2
    return 1
  fi
  if [ "$owner" != "$(id -u)" ] || [ "$mode" != "600" ]; then
    echo "[cc-terminal] Token file must be owned by the current user with mode 600." >&2
    return 1
  fi

  CC_TERMINAL_TOKEN_VALUE="$(<"$token_file")"
  if ! [[ "$CC_TERMINAL_TOKEN_VALUE" =~ ^[0-9a-f]{64}$ ]]; then
    unset CC_TERMINAL_TOKEN_VALUE
    echo "[cc-terminal] Token file must contain exactly one 64-character hex token." >&2
    return 1
  fi
}
