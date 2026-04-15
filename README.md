# cc-remote-term

A web-based remote terminal for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Access Claude Code from any device — phone, tablet, or desktop — over your local network or Tailscale.

**Not a chat wrapper.** This is a real terminal emulator (xterm.js + node-pty) that runs Claude Code interactively, exactly as it works in your local terminal.

## Features

- **Real terminal** — xterm.js renders the full terminal experience: colors, cursor, scrollback, links
- **Multi-session** — Click "+" to spawn unlimited Claude Code sessions, switch freely between them
- **Session persistence** — Switch away and come back; output history is preserved via ring buffer (1MB)
- **File upload** — Drag & drop files or click the paperclip button to send files to Claude Code
- **Cross-device** — Works on iPhone, iPad, Android, and desktop browsers via Tailscale
- **iPad-friendly** — Touch key bar (Esc, Tab, Ctrl+C, arrows) for devices without physical keyboards
- **Dark/Light theme** — Follows system preference, toggleable in sidebar
- **Token auth** — Simple token-based authentication to protect your terminal
- **Auto-start** — Ships with a launchd plist for macOS auto-start on boot
- **Single port** — HTTP + WebSocket on one port (default 3099), simple firewall setup

## Architecture

```
Browser (any device)          Server (your Mac)
┌──────────────────┐         ┌────────────────────┐
│  xterm.js        │◄──WS──►│  server.ts          │
│  (Terminal UI)   │         │  ├─ Next.js (pages) │
│                  │         │  ├─ WebSocket server │
│  IndexedDB       │         │  └─ TerminalManager │
│  (session list)  │         │     ├─ node-pty #1  │──► claude (PTY)
└──────────────────┘         │     ├─ node-pty #2  │──► claude (PTY)
                             │     └─ ...          │
                             └────────────────────┘
```

- **server.ts** — Custom HTTP server serving Next.js pages + WebSocket upgrade on `/ws/terminal`
- **TerminalManager** — Manages PTY lifecycles, ring buffers, attach/detach per session
- **WebSocket protocol** — JSON messages: `create`, `attach`, `input`, `resize`, `kill`, `list`

## Quick Start

### Prerequisites

- Node.js 20+ (or Bun)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`~/.local/bin/claude`)
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

Open `http://localhost:3099?token=YOUR_TOKEN` in your browser.

### Remote Access (Tailscale)

If you have [Tailscale](https://tailscale.com/) installed, the server auto-detects your Tailscale IP on startup:

```
[cc-terminal] Tailscale: http://100.x.x.x:3099
```

Access from any device on your Tailnet: `http://100.x.x.x:3099?token=YOUR_TOKEN`

### Auto-start (macOS launchd)

```bash
# Edit the plist template
cp scripts/com.cc-remote-term.web.plist ~/Library/LaunchAgents/

# Update paths and token in the plist, then:
launchctl load ~/Library/LaunchAgents/com.cc-remote-term.web.plist
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CC_TERMINAL_TOKEN` | (required) | Auth token for WebSocket connections |
| `PORT` | `3099` | Server port |
| `NODE_ENV` | `development` | Set to `production` for optimized builds |

Session limits (in `lib/types.ts`):

| Constant | Default | Description |
|---|---|---|
| `MAX_SESSIONS` | 10 | Maximum concurrent PTY sessions |
| `IDLE_TIMEOUT` | 30 min | Auto-kill detached idle sessions |
| `RING_BUFFER_SIZE` | 5 MB | Output history per session (replayed on attach / reconnect) |

## Tech Stack

- **Frontend**: Next.js 16 (App Router), React 19, Tailwind CSS 4, xterm.js 6
- **Backend**: Custom Node.js HTTP server, WebSocket (ws), node-pty
- **Storage**: IndexedDB (client-side session list)

## Acknowledgements

Thanks to [Happy](https://github.com/slopus/happy) for the inspiration.

## License

MIT
