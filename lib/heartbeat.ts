/**
 * WebSocket heartbeat: detects zombie connections that never emitted 'close'
 * (phone browser backgrounded, network switch, killed tab). Without this,
 * TerminalManager keeps `session.ws` set forever, `cleanupIdle()` never sees
 * the session as disconnected, and dead sessions pile up to MAX_SESSIONS.
 *
 * Standard ws ping/pong pattern: every sweep pings all clients; a client that
 * did not answer since the previous sweep is terminated. terminate() fires the
 * 'close' event, which detaches the session so idle cleanup can reclaim it.
 * Browsers answer pings at the protocol level — no client code needed.
 */

export const HEARTBEAT_INTERVAL = 30_000; // zombie detected in ≤ 2 intervals

export interface HeartbeatSocket {
  isAlive?: boolean;
  ping(): void;
  terminate(): void;
}

type PongEmitter = HeartbeatSocket & {
  on(event: 'pong', listener: () => void): unknown;
};

/** Call from the wss 'connection' handler before any other setup. */
export function trackConnection(ws: PongEmitter): void {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
}

/**
 * One heartbeat pass: terminate sockets that missed the previous ping,
 * mark the rest as pending and ping them. Returns how many were terminated.
 */
export function sweep(clients: Iterable<HeartbeatSocket>): number {
  let terminated = 0;
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      terminated++;
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  return terminated;
}

export function startHeartbeat(
  wss: { clients: Iterable<HeartbeatSocket> },
  intervalMs: number = HEARTBEAT_INTERVAL,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const terminated = sweep(wss.clients);
    if (terminated > 0) {
      console.log(`[cc-terminal] Heartbeat: terminated ${terminated} zombie connection(s)`);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
