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
import { isLoopbackHost, resolveServerHost } from './lib/server-config';
import { authorizeAndNotify, deviceStore, displayIp, PEER_HEADER } from './lib/device-service';

const terminalManager = new TerminalManager();

// Prefix all server logs with an ISO timestamp for easier production debugging.
const LOG_LEVELS: Array<'log' | 'warn' | 'error'> = ['log', 'warn', 'error'];
for (const level of LOG_LEVELS) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => original(`[${new Date().toISOString()}]`, ...args);
}

// Next.js auto-loads .env.local into the client bundle but NOT into this
// custom server process. Without this, dev runs fail with
// "AGENTDECK_TOKEN is not set" unless the user manually exports first.
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
const hostname = resolveServerHost();
const port = parseInt(process.env.PORT || '3109', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// CC_TERMINAL_* names are the pre-rename spelling, still honoured so an
// existing .env.local or exported shell var keeps working after upgrade.
const AGENTDECK_TOKEN = process.env.AGENTDECK_TOKEN || process.env.CC_TERMINAL_TOKEN;

if (!AGENTDECK_TOKEN) {
  console.error('[agentdeck] AGENTDECK_TOKEN is not set. Exiting.');
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
    // Stamp the real transport peer for the route handlers, which cannot reach
    // the socket. Assignment, never append: a client that sends this header
    // itself must not be able to influence the value — that would hand back the
    // X-Forwarded-For spoofing hole this header exists to close.
    req.headers[PEER_HEADER] = req.socket.remoteAddress || '';
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // WebSocket server for terminal connections (noServer = we handle upgrades manually)
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[agentdeck] WebSocket client connected');
    trackConnection(ws);
    handleWebSocket(ws, { terminalManager, transcriptHub });
  });

  // The allowlist is re-read from disk on every lookup, so a revoke landing via
  // the API is visible to the very next sweep — no cross-process signalling
  // needed between the route handlers and this server.
  startHeartbeat(wss, undefined, (deviceId) => deviceStore.get(deviceId)?.status === 'approved');

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = parse(req.url!, true);

    // Route terminal WebSocket upgrades
    if (pathname === '/ws/terminal') {
      // First factor: the shared access token.
      const token = query.token as string | undefined;
      if (token !== AGENTDECK_TOKEN) {
        console.warn('[agentdeck] WS auth failed: invalid token');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Second factor: the device must be on the allowlist. A stolen token
      // alone lands here as an unknown device, gets blocked, and fires the
      // owner alert — this is the real gate; the /api/devices/self pre-flight
      // only exists so the browser can render *why* it was blocked.
      const deviceId = typeof query.deviceId === 'string' ? query.deviceId : null;
      authorizeAndNotify({
        deviceId,
        userAgent: req.headers['user-agent'] ?? null,
        displayMode: typeof query.displayMode === 'string' ? query.displayMode : null,
        peerIp: req.socket.remoteAddress || 'unknown',
        displayIp: displayIp(req.headers, req.socket.remoteAddress),
        now: Date.now(),
      })
        .then((decision) => {
          if (decision.outcome !== 'allow') {
            console.warn(
              `[agentdeck] WS blocked: device ${decision.device.id} is ${decision.outcome}`,
            );
            // 400 for a missing device id: the client must fix its request,
            // whereas 403 would suggest waiting for an approval that can never
            // arrive (approval is keyed by the id that was not sent).
            const status =
              decision.outcome === 'no-device-id' ? '400 Bad Request' : '403 Forbidden';
            socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            // Remember which device this socket belongs to so the heartbeat can
            // close it if that device is revoked later. Authorization otherwise
            // happens only here, at upgrade, and a revocation would never reach
            // a session that is already open.
            (ws as WebSocket & { deviceId?: string }).deviceId = decision.device.id;
            wss.emit('connection', ws, req);
          });
        })
        .catch((err) => {
          console.error('[agentdeck] Device authorization error:', err);
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
      return;
    }

    // In dev mode, let Next.js handle HMR WebSocket upgrades
    if (dev) {
      handleUpgrade(req, socket, head).catch((err) => {
        console.error('[agentdeck] Next.js upgrade error:', err);
        socket.destroy();
      });
      return;
    }

    // In production, reject unknown upgrade requests
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  server.listen(port, hostname, () => {
    console.log(`[agentdeck] Server running at http://${hostname}:${port}`);
    try {
      const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
      let rev = '';
      try {
        rev = require('child_process')
          .execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
          .toString().trim();
      } catch { /* not a git checkout */ }
      console.log(`[agentdeck] Version: ${pkg.version}${rev ? ` (${rev})` : ''}`);
    } catch { /* package.json unreadable */ }
    console.log(`[agentdeck] Mode: ${dev ? 'development' : 'production'}`);
    console.log(`[agentdeck] WebSocket endpoint: ws://${hostname}:${port}/ws/terminal?token=<token>`);

    if (isLoopbackHost(hostname)) {
      console.log('[agentdeck] Remote access disabled; set AGENTDECK_HOST explicitly to enable it.');
    } else {
      // Log Tailscale URL if available
      try {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(interfaces)) {
          if (name.startsWith('utun') || name === 'tailscale0') {
            for (const addr of addrs as any[]) {
              if (addr.family === 'IPv4') {
                console.log(`[agentdeck] Tailscale: http://${addr.address}:${port}`);
              }
            }
          }
        }
      } catch {
        // Tailscale detection is best-effort
      }
    }
  });
});
