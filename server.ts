import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { handleWebSocket } from './lib/ws-handler';
import { TerminalManager } from './lib/terminal-manager';
import { transcriptHub } from './lib/transcript-hub';
import { trackConnection, startHeartbeat } from './lib/heartbeat';

const terminalManager = new TerminalManager();

// Prefix all server logs with an ISO timestamp for easier production debugging.
const LOG_LEVELS: Array<'log' | 'warn' | 'error'> = ['log', 'warn', 'error'];
for (const level of LOG_LEVELS) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => original(`[${new Date().toISOString()}]`, ...args);
}

// Next.js auto-loads .env.local into the client bundle but NOT into this
// custom server process. Without this, dev runs fail with
// "CC_TERMINAL_TOKEN is not set" unless the user manually exports first.
(() => {
  const envPath = resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || key in process.env) continue;
      process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // Ignore unreadable .env.local
  }
})();

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3109', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const CC_TERMINAL_TOKEN = process.env.CC_TERMINAL_TOKEN;

if (!CC_TERMINAL_TOKEN) {
  console.error('[cc-terminal] CC_TERMINAL_TOKEN is not set. Exiting.');
  process.exit(1);
}

app.prepare().then(async () => {
  await terminalManager.init();
  // Re-attach transcript tracking for sessions recovered from tmux; their
  // files were born after createdAt, so discovery matches them the same way.
  for (const session of terminalManager.list()) {
    transcriptHub.track(session.id, {
      backend: session.backend,
      cwd: session.cwd,
      spawnTimeMs: session.createdAt,
      resumeSessionId: session.resumeSessionId,
    });
  }
  const handleUpgrade = app.getUpgradeHandler();
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // WebSocket server for terminal connections (noServer = we handle upgrades manually)
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[cc-terminal] WebSocket client connected');
    trackConnection(ws);
    handleWebSocket(ws, { terminalManager, transcriptHub });
  });

  startHeartbeat(wss);

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = parse(req.url!, true);

    // Route terminal WebSocket upgrades
    if (pathname === '/ws/terminal') {
      // Token authentication
      const token = query.token as string | undefined;
      if (token !== CC_TERMINAL_TOKEN) {
        console.warn('[cc-terminal] WS auth failed: invalid token');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    // In dev mode, let Next.js handle HMR WebSocket upgrades
    if (dev) {
      handleUpgrade(req, socket, head).catch((err) => {
        console.error('[cc-terminal] Next.js upgrade error:', err);
        socket.destroy();
      });
      return;
    }

    // In production, reject unknown upgrade requests
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  server.listen(port, hostname, () => {
    console.log(`[cc-terminal] Server running at http://${hostname}:${port}`);
    try {
      const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
      let rev = '';
      try {
        rev = require('child_process')
          .execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
          .toString().trim();
      } catch { /* not a git checkout */ }
      console.log(`[cc-terminal] Version: ${pkg.version}${rev ? ` (${rev})` : ''}`);
    } catch { /* package.json unreadable */ }
    console.log(`[cc-terminal] Mode: ${dev ? 'development' : 'production'}`);
    console.log(`[cc-terminal] WebSocket endpoint: ws://${hostname}:${port}/ws/terminal?token=<token>`);

    // Log Tailscale URL if available
    try {
      const os = require('os');
      const interfaces = os.networkInterfaces();
      for (const [name, addrs] of Object.entries(interfaces)) {
        if (name.startsWith('utun') || name === 'tailscale0') {
          for (const addr of addrs as any[]) {
            if (addr.family === 'IPv4') {
              console.log(`[cc-terminal] Tailscale: http://${addr.address}:${port}`);
            }
          }
        }
      }
    } catch {
      // Tailscale detection is best-effort
    }
  });
});
