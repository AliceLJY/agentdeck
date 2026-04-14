import * as pty from 'node-pty';
import * as path from 'path';
import { WebSocket } from 'ws';
import { execFileSync, spawnSync } from 'child_process';
import { RingBuffer } from './ring-buffer';
import { SessionStore } from './session-store';
import { SessionInfo, MAX_SESSIONS, IDLE_TIMEOUT, DEFAULT_COLS, DEFAULT_ROWS } from './types';

/** All our tmux sessions use a dedicated socket to avoid polluting user's tmux */
const TMUX_SOCKET = 'ccrt';
const TMUX_PREFIX = 'ccrt';

interface TerminalSession {
  id: string;
  tmuxName: string;
  pty: pty.IPty | null;          // null when recovered but client hasn't attached yet
  ws: WebSocket | null;
  buffer: RingBuffer;
  createdAt: number;
  lastActivity: number;
  title: string;
  alive: boolean;
  dataDisposable: pty.IDisposable | null;
}

class TerminalManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private store: SessionStore;
  private tmuxPath: string;
  private home: string;
  private tmuxConf: string;
  private enrichedEnv: Record<string, string>;

  constructor() {
    this.home = process.env.HOME || '/Users/USER';
    this.store = new SessionStore();
    this.tmuxPath = this.findTmux();
    this.tmuxConf = path.join(process.cwd(), 'lib', 'tmux.conf');
    this.enrichedEnv = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
      PATH: `${this.home}/.local/bin:${this.home}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
    };

    // Every 5 minutes, kill idle sessions
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), 5 * 60 * 1000);
  }

  // ─── Startup Recovery ───

  /**
   * Called once on server startup. Discovers tmux sessions that survived
   * a server restart and restores them into the session map.
   */
  async init(): Promise<void> {
    try {
      const output = this.tmuxExec(['list-sessions', '-F', '#{session_name}:#{session_activity}']);
      if (!output.trim()) return;

      const savedMeta = this.store.loadAll();
      let recovered = 0;

      for (const line of output.trim().split('\n')) {
        const [tmuxName] = line.split(':');
        if (!tmuxName.startsWith(`${TMUX_PREFIX}-`)) continue;

        const id = tmuxName.replace(`${TMUX_PREFIX}-`, '');

        // Check if the pane is still alive (claude running) vs dead (remain-on-exit)
        const paneAlive = this.isPaneAlive(tmuxName);
        if (!paneAlive) {
          console.log(`[cc-terminal] Removing dead tmux session: ${tmuxName}`);
          this.tmuxExecSafe(['kill-session', '-t', tmuxName]);
          this.store.remove(id);
          continue;
        }

        const meta = savedMeta[id];
        const session: TerminalSession = {
          id,
          tmuxName,
          pty: null,           // Lazy — PTY bridge spawned when client attaches
          ws: null,
          buffer: new RingBuffer(),
          createdAt: meta?.createdAt || Date.now(),
          lastActivity: Date.now(),
          title: meta?.title || new Date().toLocaleTimeString(),
          alive: true,
          dataDisposable: null,
        };

        this.sessions.set(id, session);
        recovered++;
        console.log(`[cc-terminal] Recovered session: ${tmuxName} → "${session.title}"`);
      }

      if (recovered > 0) {
        console.log(`[cc-terminal] Recovered ${recovered} session(s) from tmux`);
      }
    } catch {
      // No tmux server running = no sessions to recover (normal on first boot)
      console.log('[cc-terminal] No existing tmux sessions found');
    }
  }

  // ─── Session Lifecycle ───

  create(id: string, cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum sessions (${MAX_SESSIONS}) reached. Close an existing session first.`);
    }
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists.`);
    }

    const tmuxName = `${TMUX_PREFIX}-${id}`;
    const claude = `${this.home}/.local/bin/claude`;
    const now = Date.now();

    // Create detached tmux session running claude
    // Use env command to ensure correct PATH inside tmux
    const envCmd = `env PATH='${this.enrichedEnv.PATH}' TERM=xterm-256color FORCE_COLOR=1 HOME='${this.home}' ${claude}`;
    this.tmuxExec(['new-session', '-d', '-s', tmuxName, '-x', String(cols), '-y', String(rows), envCmd]);

    // Configure the session
    this.tmuxExecSafe(['set-option', '-t', tmuxName, 'remain-on-exit', 'on']);

    // Spawn PTY bridge (tmux attach)
    const ptyProcess = this.spawnBridge(tmuxName, cols, rows);

    const session: TerminalSession = {
      id,
      tmuxName,
      pty: ptyProcess,
      ws: null,
      buffer: new RingBuffer(),
      createdAt: now,
      lastActivity: now,
      title: new Date(now).toLocaleTimeString(),
      alive: true,
      dataDisposable: null,
    };

    this.setupPtyHandlers(session);
    this.sessions.set(id, session);
    this.store.save(id, { title: session.title, createdAt: now });

    console.log(`[cc-terminal] Created: ${id} → tmux:${tmuxName} (${this.sessions.size}/${MAX_SESSIONS})`);
    return this.toSessionInfo(session);
  }

  attach(sessionId: string, ws: WebSocket): void {
    const session = this.getSession(sessionId);

    // Lazy PTY: if no bridge yet (recovered session), spawn one now
    if (!session.pty) {
      const ptyProcess = this.spawnBridge(session.tmuxName, DEFAULT_COLS, DEFAULT_ROWS);
      session.pty = ptyProcess;
      this.setupPtyHandlers(session);
      console.log(`[cc-terminal] Spawned PTY bridge for recovered session: ${sessionId}`);
    }

    // Replay ring buffer (recent output history)
    const buffered = session.buffer.read();
    if (buffered.length > 0) {
      ws.send(JSON.stringify({ type: 'output', data: buffered }));
    }

    session.ws = ws;
    session.lastActivity = Date.now();
  }

  detach(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.ws = null;
    session.lastActivity = Date.now();
  }

  write(sessionId: string, data: string): void {
    const session = this.getSession(sessionId);

    // Auto-detect session title from first user input
    if (session.title === new Date(session.createdAt).toLocaleTimeString()) {
      const trimmed = data.replace(/[\r\n]/g, '').trim();
      if (trimmed.length > 0) {
        session.title = trimmed.length > 50 ? trimmed.slice(0, 50) : trimmed;
        this.store.updateTitle(sessionId, session.title);
      }
    }

    session.lastActivity = Date.now();
    if (session.pty) {
      session.pty.write(data);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.getSession(sessionId);

    // Resize both PTY bridge and tmux window
    if (session.pty) {
      session.pty.resize(cols, rows);
    }
    this.tmuxExecSafe(['resize-window', '-t', session.tmuxName, '-x', String(cols), '-y', String(rows)]);
    session.lastActivity = Date.now();
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`[cc-terminal] Killing: ${sessionId}`);

    // Kill PTY bridge
    if (session.pty) {
      try { session.pty.kill(); } catch {}
    }
    if (session.dataDisposable) {
      session.dataDisposable.dispose();
    }

    // Kill tmux session (this kills claude inside it)
    this.tmuxExecSafe(['kill-session', '-t', session.tmuxName]);

    session.alive = false;
    this.store.remove(sessionId);
    this.sessions.delete(sessionId);
  }

  list(): SessionInfo[] {
    const result = Array.from(this.sessions.values()).map((s) => this.toSessionInfo(s));
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  getSessionTitle(sessionId: string): string {
    return this.sessions.get(sessionId)?.title || '';
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ─── PTY Bridge ───

  /** Spawn a node-pty process that attaches to an existing tmux session */
  private spawnBridge(tmuxName: string, cols: number, rows: number): pty.IPty {
    return pty.spawn(this.tmuxPath, ['-L', TMUX_SOCKET, 'attach-session', '-t', tmuxName], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.home,
      env: this.enrichedEnv,
    });
  }

  /** Wire PTY output to ring buffer + WebSocket, handle exit */
  private setupPtyHandlers(session: TerminalSession): void {
    if (!session.pty) return;

    session.dataDisposable = session.pty.onData((data: string) => {
      session.lastActivity = Date.now();
      session.buffer.write(data);
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    session.pty.onExit(({ exitCode }) => {
      console.log(`[cc-terminal] PTY bridge exited: ${session.id} (code ${exitCode})`);

      // Check if the tmux session (with claude inside) is still alive
      const tmuxAlive = this.isTmuxSessionAlive(session.tmuxName);
      const paneAlive = tmuxAlive && this.isPaneAlive(session.tmuxName);

      if (paneAlive) {
        // PTY bridge died but claude is still running in tmux — can reattach
        console.log(`[cc-terminal] tmux:${session.tmuxName} still alive, bridge can reconnect`);
        session.pty = null;
        session.dataDisposable = null;
      } else {
        // Claude exited — session is truly dead
        console.log(`[cc-terminal] Session ${session.id} is dead (claude exited)`);
        session.alive = false;

        // Notify attached client
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({
            type: 'exit',
            sessionId: session.id,
            code: exitCode,
          }));
        }

        // Clean up tmux session
        if (tmuxAlive) {
          this.tmuxExecSafe(['kill-session', '-t', session.tmuxName]);
        }

        this.store.remove(session.id);
        setTimeout(() => this.sessions.delete(session.id), 1000);
      }
    });
  }

  // ─── tmux Helpers ───

  private findTmux(): string {
    const candidates = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
    for (const p of candidates) {
      if (spawnSync('test', ['-x', p]).status === 0) return p;
    }
    // Last resort: look in PATH
    const result = spawnSync('which', ['tmux']);
    if (result.status === 0) return result.stdout.toString().trim();
    throw new Error('tmux not found. Install via: brew install tmux');
  }

  /** Execute a tmux command on our dedicated socket. Throws on failure. */
  private tmuxExec(args: string[]): string {
    return execFileSync(
      this.tmuxPath,
      ['-L', TMUX_SOCKET, '-f', this.tmuxConf, ...args],
      { env: this.enrichedEnv as NodeJS.ProcessEnv, timeout: 5000 },
    ).toString();
  }

  /** Execute a tmux command, swallow errors. */
  private tmuxExecSafe(args: string[]): string {
    try {
      return this.tmuxExec(args);
    } catch {
      return '';
    }
  }

  private isTmuxSessionAlive(tmuxName: string): boolean {
    try {
      this.tmuxExec(['has-session', '-t', tmuxName]);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if the main pane process is still running (vs remain-on-exit dead pane) */
  private isPaneAlive(tmuxName: string): boolean {
    try {
      const result = this.tmuxExec(['list-panes', '-t', tmuxName, '-F', '#{pane_dead}']).trim();
      return result === '0';
    } catch {
      return false;
    }
  }

  // ─── Utilities ───

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
    for (const [id, session] of this.sessions.entries()) {
      if (!session.ws && (now - session.lastActivity) > IDLE_TIMEOUT) {
        console.log(`[cc-terminal] Cleaning up idle session: ${id}`);
        this.kill(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    // Kill PTY bridges but leave tmux sessions alive (they'll be recovered on next start)
    for (const session of this.sessions.values()) {
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
      if (session.dataDisposable) {
        session.dataDisposable.dispose();
      }
    }
    this.sessions.clear();
  }
}

export const terminalManager = new TerminalManager();
