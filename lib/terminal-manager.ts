import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { RingBuffer } from './ring-buffer';
import { SessionInfo, MAX_SESSIONS, IDLE_TIMEOUT, DEFAULT_COLS, DEFAULT_ROWS } from './types';

interface TerminalSession {
  id: string;
  pty: pty.IPty;
  ws: WebSocket | null;
  buffer: RingBuffer;
  createdAt: number;
  lastActivity: number;
  title: string;
  alive: boolean;
  /** Disposable handle for pty.onData listener */
  dataDisposable: pty.IDisposable;
}

class TerminalManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Every 5 minutes, kill idle sessions (no WS attached + no activity for 30 min)
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), 5 * 60 * 1000);
  }

  create(id: string, cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum sessions (${MAX_SESSIONS}) reached. Close an existing session first.`);
    }

    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists.`);
    }

    const now = Date.now();
    const shell = 'claude';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || '/',
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      } as Record<string, string>,
    });

    const session: TerminalSession = {
      id,
      pty: ptyProcess,
      ws: null,
      buffer: new RingBuffer(),
      createdAt: now,
      lastActivity: now,
      title: new Date(now).toLocaleTimeString(),
      alive: true,
      dataDisposable: { dispose: () => {} }, // placeholder, set below
    };

    // Initially detached: buffer all output
    session.dataDisposable = ptyProcess.onData((data: string) => {
      session.lastActivity = Date.now();
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'output', data }));
      } else {
        session.buffer.write(data);
      }
    });

    // Handle PTY process exit
    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[cc-terminal] PTY exited for session ${id} with code ${exitCode}`);
      session.alive = false;

      // Notify attached WS
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({
          type: 'exit',
          sessionId: id,
          code: exitCode,
        }));
      }

      // Clean up after a short delay to let exit message be sent
      setTimeout(() => {
        this.sessions.delete(id);
      }, 1000);
    });

    this.sessions.set(id, session);
    console.log(`[cc-terminal] Session created: ${id} (${this.sessions.size}/${MAX_SESSIONS})`);

    return this.toSessionInfo(session);
  }

  attach(sessionId: string, ws: WebSocket): void {
    const session = this.getSession(sessionId);

    // Replay buffered output
    const buffered = session.buffer.read();
    if (buffered.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: buffered }));
      session.buffer.clear();
    }

    // Set ws reference -- the onData handler already checks session.ws
    session.ws = ws;
    session.lastActivity = Date.now();
  }

  detach(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return; // silently ignore if session doesn't exist

    session.ws = null;
    session.lastActivity = Date.now();
    // From now on, onData handler will route output to ring buffer
  }

  write(sessionId: string, data: string): void {
    const session = this.getSession(sessionId);

    // Auto-detect session title from first non-empty user input
    if (session.title === new Date(session.createdAt).toLocaleTimeString()) {
      const trimmed = data.replace(/[\r\n]/g, '').trim();
      if (trimmed.length > 0) {
        session.title = trimmed.length > 50 ? trimmed.slice(0, 50) : trimmed;
      }
    }

    session.lastActivity = Date.now();
    session.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.getSession(sessionId);
    session.pty.resize(cols, rows);
    session.lastActivity = Date.now();
  }

  kill(sessionId: string): void {
    const session = this.getSession(sessionId);

    console.log(`[cc-terminal] Killing session: ${sessionId}`);

    try {
      session.pty.kill();
    } catch {
      // PTY may already be dead
    }

    session.alive = false;
    session.dataDisposable.dispose();
    this.sessions.delete(sessionId);
  }

  list(): SessionInfo[] {
    const result: SessionInfo[] = Array.from(this.sessions.values()).map(
      (session) => this.toSessionInfo(session),
    );
    // Sort by createdAt descending (newest first)
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  getSessionTitle(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session ? session.title : '';
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private getSession(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found.`);
    }
    if (!session.alive) {
      throw new Error(`Session ${sessionId} has exited.`);
    }
    return session;
  }

  private toSessionInfo(session: TerminalSession): SessionInfo {
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      attached: session.ws !== null,
      alive: session.alive,
    };
  }

  private cleanupIdle(): void {
    const now = Date.now();
    const entries = Array.from(this.sessions.entries());
    for (let i = 0; i < entries.length; i++) {
      const [id, session] = entries[i];
      // Only clean up sessions that are detached (no WS) and idle past timeout
      if (!session.ws && (now - session.lastActivity) > IDLE_TIMEOUT) {
        console.log(`[cc-terminal] Cleaning up idle session: ${id}`);
        this.kill(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    const ids = Array.from(this.sessions.keys());
    for (let i = 0; i < ids.length; i++) {
      this.kill(ids[i]);
    }
  }
}

export const terminalManager = new TerminalManager();
