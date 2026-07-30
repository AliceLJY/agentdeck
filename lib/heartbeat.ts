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
  /** Which device opened this connection, stamped at upgrade time. It is what
   *  lets a revocation reach a session that is already running. */
  deviceId?: string;
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

export interface SweepResult {
  /** Closed for missing a ping — a dead client the OS never told us about. */
  terminated: number;
  /** Closed because the device is no longer approved. */
  revoked: number;
}

/**
 * One heartbeat pass: drop connections whose device lost approval, terminate
 * sockets that missed the previous ping, then ping the rest.
 *
 * The revocation check lives here because authorization otherwise happens
 * exactly once, at upgrade. Without it "revoke that device" only affected
 * *future* connections, so a stolen phone holding an open session kept working
 * — which is the one scenario the whole feature exists for. Passing the check
 * in keeps this module free of any allowlist dependency.
 */
export function sweep(
  clients: Iterable<HeartbeatSocket>,
  isStillAllowed?: (deviceId: string) => boolean,
): SweepResult {
  let terminated = 0;
  let revoked = 0;
  for (const ws of clients) {
    // Checked before liveness: a revoked device must not get one more round of
    // grace just because its socket is answering pings.
    if (isStillAllowed && ws.deviceId && !isStillAllowed(ws.deviceId)) {
      ws.terminate();
      revoked++;
      continue;
    }
    if (ws.isAlive === false) {
      ws.terminate();
      terminated++;
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  return { terminated, revoked };
}

export function startHeartbeat(
  wss: { clients: Iterable<HeartbeatSocket> },
  intervalMs: number = HEARTBEAT_INTERVAL,
  isStillAllowed?: (deviceId: string) => boolean,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const { terminated, revoked } = sweep(wss.clients, isStillAllowed);
    if (terminated > 0) {
      console.log(`[agentdeck] Heartbeat: terminated ${terminated} zombie connection(s)`);
    }
    if (revoked > 0) {
      console.warn(`[agentdeck] Heartbeat: closed ${revoked} connection(s) of revoked device(s)`);
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
