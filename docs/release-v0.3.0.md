# v0.3.0 — Four-agent deck with device approval

AgentDeck now treats the browser as a real deck for multiple AI coding CLIs,
with a safer public-access boundary and a terminal that behaves reliably on a
phone. This is a backward-compatible minor release: it adds capabilities and
keeps the pre-rename settings and data paths working.

## Highlights

- Adds Kimi Code and Antigravity (`agy`) alongside Claude Code and Codex, with
  matching launch, resume, history, labels, filters, and UI colors.
- Replaces the old mobile sidebar flow with top session tabs and recent-session
  navigation, plus touch scrolling, long-press selection, Markdown copy actions,
  and terminal resizing that survives orientation and panel changes.
- Adds an approved-device layer on top of the shared token. New browsers wait
  for a one-time approval, revoked devices lose open sessions, sensitive HTTP
  routes enforce the same guard, and damaged allowlists fail closed.
- Fixes stale or misclaimed resumes, terminal history replay, duplicate mobile
  input, dead sessions redirecting the active view, and Agy sessions launching
  the wrong backend.
- Makes the launchd wrapper rebuild before start so a restarted service cannot
  silently serve an old frontend bundle.

## Compatibility and upgrade

No destructive migration is required. Existing `CC_TERMINAL_*` environment
variables, the old token location, tmux socket naming, and saved session paths
remain supported.

```bash
git pull --ff-only
npm ci
npm run build
```

Restart the existing process after the build. The first browser connection then
waits for device approval. Approve it from the Telegram alert, or list and
approve pending devices with `npm run device` on the host. AgentDeck now binds
to `127.0.0.1` by default; an frp client on the same host needs no change, while
direct Tailscale or LAN access must set `AGENTDECK_HOST` before restart.

## Verification

- 144 automated tests
- TypeScript typecheck
- Next.js production build
- Production dependency audit at the high-severity gate
- Clean install and local unauthenticated HTTP smoke

No tag or GitHub Release is created by this preparation commit.
