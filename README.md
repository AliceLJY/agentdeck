# cc-remote-term

A web-based remote terminal for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) CLI. Access either agent from any device — phone, tablet, or desktop — over your local network or Tailscale.

**A real terminal, not a chat wrapper.** xterm.js + node-pty + tmux run the upstream CLI interactively, exactly as it behaves in your local terminal. Layered on top is an optional **chat view** — the same live session rendered as clean, scrollable message bubbles, so reading long replies and typing on a phone feel native, without giving up the real terminal underneath.

[中文 README](./README_CN.md)

## Features

- **Two backends, one UI** — Spawn a Claude Code session or a Codex session from the same browser; each session is tagged with its backend (blue for Claude, emerald for Codex)
- **History browser** — Cross-backend history view: browse every Claude Code and Codex session that exists on your disk, side by side, and resume any of them in one click
- **Real terminal** — xterm.js renders the full terminal experience: colors, cursor, scrollback, links
- **Chat view** — Flip any live session into a structured chat: message bubbles, rendered Markdown, collapsible tool-call strips, auto-scroll that pauses when you scroll up. It reads the CLI's own transcript file, so it holds the complete, scrollable record — the terminal viewport can truncate a long reply, the chat view never does. One tap back to the real terminal for TUI prompts and pickers.
- **Send & interrupt from chat** — Type and send straight from the chat view (it writes to the PTY, same as typing in the terminal); a stop button interrupts the running agent. Attach an image or file inline — send a phone screenshot and the agent reads it.
- **Live status in the session list** — Each session shows what it is doing right now (the current tool call while working) or a preview of its last reply when idle, with a pulsing dot for active work.
- **Responsive split layout** — On tablet/desktop the session list is a persistent narrow pane next to the content; on a phone it collapses to a slim icon rail. List and content stay on one screen either way.
- **New-session parameters** — Choose model, reasoning effort, and permission mode (Claude) or reasoning / sandbox (Codex) before spawning; every value is validated against the CLI's own flags.
- **Multi-session** — Click "+" to spawn up to 10 concurrent sessions, switch freely between them
- **tmux-backed persistence** — Sessions survive server restarts; the PTY lives in tmux, the WebSocket just attaches to it
- **Session ring buffer** — 5 MB of output per session is replayed on reconnect, so switching devices doesn't lose context
- **File upload** — Drag & drop onto the terminal, or click the paperclip in either view, to hand files to the running agent
- **Cross-device** — Works on iPhone, iPad, Android, and desktop browsers via Tailscale
- **iPad / iOS-friendly** — Touch key bar (Esc, Tab, Ctrl+C, arrows) and IME fixes for iOS 26
- **Dark/Light theme** — Follows system preference, toggleable in sidebar
- **Token auth** — The token is never embedded in the page HTML; supply it via a `?token=` link or the login prompt, and it's remembered per browser
- **Single port** — HTTP + WebSocket on one port (default 3109), simple firewall setup

## Architecture

```
Browser (any device)          Server (your Mac)
┌──────────────────┐         ┌──────────────────────┐
│  xterm.js        │◄──WS──►│  server.ts            │
│  (Terminal UI)   │         │  ├─ Next.js (pages)   │
│  + backend tabs  │         │  ├─ WebSocket server  │
│                  │         │  └─ TerminalManager   │
│  IndexedDB       │         │     ├─ tmux:ccrt-#1   │──► claude (PTY)
│  (session list)  │         │     ├─ tmux:ccrt-#2   │──► codex  (PTY)
└──────────────────┘         │     └─ ...            │
                             │                       │
                             │  History scanner:     │
                             │  ~/.claude/projects/* │
                             │  ~/.codex/sessions/*  │
                             └──────────────────────┘
```

- **server.ts** — Custom HTTP server serving Next.js pages + WebSocket upgrade on `/ws/terminal`
- **TerminalManager** — Manages tmux-backed PTY lifecycles, ring buffers, attach/detach per session
- **backends.ts** — Picks the right CLI (`claude` or `codex`) and builds the right argv, including `--resume` semantics for each
- **history-index.ts** — Scans both `~/.claude/projects/*/` (Claude Code) and `~/.codex/sessions/*/` (Codex) and renders a unified history browser
- **transcript-hub.ts / transcript-parser.ts / session-discovery.ts** — The read-side chat layer: finds the transcript file the CLI writes for a live session, tails it incrementally, parses it into structured messages + metadata (model, tokens, branch, tool calls), and streams them to the chat view. The CLI and terminal path stay untouched.
- **WebSocket protocol** — JSON messages: `create` / `attach` / `input` / `resize` / `kill` / `list` (terminal), plus `chat_attach` / `chat_event` / `chat_input` / `interrupt` / `watch_status` (chat + live status)

## Quick Start

### Prerequisites

- Node.js 20+ (or Bun)
- tmux (`brew install tmux` on macOS)
- At least one of:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — looked up at `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`
  - [Codex CLI](https://github.com/openai/codex) — looked up at `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, `~/.local/bin/codex`

  You can install only one if you only need that backend; the UI will just fail to spawn the missing one.

- macOS (node-pty prebuilds are darwin-arm64; Linux should also work with rebuild)

### Install & Run

```bash
git clone https://github.com/AliceLJY/cc-remote-term.git
cd cc-remote-term
npm install

# Generate a random token
export CC_TERMINAL_TOKEN=$(openssl rand -hex 24)
echo "CC_TERMINAL_TOKEN=$CC_TERMINAL_TOKEN" > .env.local
echo "Your token: $CC_TERMINAL_TOKEN"

# Build & start
npm run build
npm start
```

Open `http://localhost:3109?token=YOUR_TOKEN` in your browser. The token is saved in your browser, so afterwards you can open the page without `?token=`. Opening with no token shows a login prompt. The sidebar's "+" button creates a new terminal; on the home screen, the All / CC / Codex filter selects which backend new terminals start with.

### Remote Access (Tailscale)

If you have [Tailscale](https://tailscale.com/) installed, the server auto-detects your Tailscale IP on startup:

```
[cc-terminal] Tailscale: http://100.x.x.x:3109
```

Access from any device on your Tailnet: `http://100.x.x.x:3109?token=YOUR_TOKEN`

### Auto-start (macOS launchd)

Drop a plist like this into `~/Library/LaunchAgents/com.cc-remote-term.web.plist`, then `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.cc-remote-term.web.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cc-remote-term.web</string>
  <key>WorkingDirectory</key><string>/Users/YOU/Projects/cc-remote-term</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/npm</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_TERMINAL_TOKEN</key><string>YOUR_TOKEN_HERE</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/cc-remote-term.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/cc-remote-term.err.log</string>
</dict>
</plist>
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CC_TERMINAL_TOKEN` | (required) | Auth token for WebSocket connections |
| `PORT` | `3109` | Server port |
| `NODE_ENV` | `development` | Set to `production` for optimized builds |

Session limits (in `lib/types.ts`):

| Constant | Default | Description |
|---|---|---|
| `MAX_SESSIONS` | 10 | Maximum concurrent PTY sessions |
| `IDLE_TIMEOUT` | 30 min | Auto-kill detached idle sessions |
| `RING_BUFFER_SIZE` | 5 MB | Output history per session (replayed on attach / reconnect) |

## Tech Stack

- **Frontend**: Next.js 16 (App Router), React 19, Tailwind CSS 4, xterm.js 6
- **Backend**: Custom Node.js HTTP server, WebSocket (ws), node-pty, tmux (for session persistence)
- **Storage**: IndexedDB (client-side session list); session metadata persisted in `~/.cc-remote-term-sessions.json`

## Acknowledgements

Inspired by [Happy](https://github.com/slopus/happy).

## License

MIT
