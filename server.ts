import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { handleWebSocket } from './lib/ws-handler';
import { terminalManager } from './lib/terminal-manager';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3099', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const CC_TERMINAL_TOKEN = process.env.CC_TERMINAL_TOKEN;

if (!CC_TERMINAL_TOKEN) {
  console.error('[cc-terminal] CC_TERMINAL_TOKEN is not set. Exiting.');
  process.exit(1);
}

app.prepare().then(async () => {
  await terminalManager.init();
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // WebSocket server for terminal connections (noServer = we handle upgrades manually)
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    console.log('[cc-terminal] WebSocket client connected');
    handleWebSocket(ws);
  });

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
      // Don't destroy the socket -- Next.js HMR needs it
      // Next.js will handle /_next/webpack-hmr upgrades internally
      return;
    }

    // In production, reject unknown upgrade requests
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  server.listen(port, hostname, () => {
    console.log(`[cc-terminal] Server running at http://${hostname}:${port}`);
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
