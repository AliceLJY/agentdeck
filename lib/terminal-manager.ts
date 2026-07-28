import * as pty from 'node-pty';
import * as path from 'path';
import { WebSocket } from 'ws';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import {
  buildBackendCommand,
  normalizeBackend,
  type HistoryBackend,
} from './backends';
import { claudeProjectsRoot, projectIdFromCwd } from './history-index';
import { RingBuffer } from './ring-buffer';
import { SessionStore } from './session-store';
import {
  SessionInfo,
  MAX_SESSIONS,
  IDLE_TIMEOUT,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  TerminalCreateOptions,
} from './types';

/** All our tmux sessions use a dedicated socket to avoid polluting user's tmux */
const TMUX_SOCKET = 'ccrt';
const TMUX_PREFIX = 'ccrt';

interface TerminalSession {
  id: string;
  backend: HistoryBackend;
  tmuxName: string;
  cwd: string;
  resumeSessionId: string | null;
  pty: pty.IPty | null;          // null when recovered but client hasn't attached yet
  ws: WebSocket | null;
  streamOutput: boolean;
  buffer: RingBuffer;
  createdAt: number;
  lastActivity: number;
  title: string;
  alive: boolean;
  dataDisposable: pty.IDisposable | null;
}

export type TerminalManagerStore = Pick<
  SessionStore,
  'loadAll' | 'remove' | 'save' | 'updateTitle'
>;

export interface TerminalManagerOptions {
  home?: string;
  store?: TerminalManagerStore;
  tmuxPath?: string;
  startCleanupTimer?: boolean;
}

export class TerminalManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null;
  private store: TerminalManagerStore;
  private tmuxPath: string;
  private home: string;
  private tmuxConf: string;
  private enrichedEnv: Record<string, string>;

  constructor(options: TerminalManagerOptions = {}) {
    this.home = options.home ?? process.env.HOME ?? '/Users/USER';
    this.store = options.store ?? new SessionStore();
    this.tmuxPath = options.tmuxPath ?? this.findTmux();
    this.tmuxConf = path.join(process.cwd(), 'lib', 'tmux.conf');
    this.enrichedEnv = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
      PATH: `${this.home}/.local/bin:${this.home}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
    };

    this.cleanupTimer = options.startCleanupTimer === false
      ? null
      : setInterval(() => this.cleanupIdle(), 5 * 60 * 1000);
  }

  // ─── Startup Recovery ───

  async init(): Promise<void> {
    try {
      const output = this.tmuxExec(['list-sessions', '-F', '#{session_name}']);
      if (!output.trim()) return;

      const savedMeta = this.store.loadAll();
      let recovered = 0;

      for (const tmuxName of output.trim().split('\n')) {
        if (!tmuxName.startsWith(`${TMUX_PREFIX}-`)) continue;
        const id = tmuxName.replace(`${TMUX_PREFIX}-`, '');

        // Check if pane process is still alive
        if (!this.isPaneAlive(tmuxName)) {
          console.log(`[cc-terminal] Removing dead tmux session: ${tmuxName}`);
          this.tmuxExecSafe(['kill-session', '-t', tmuxName]);
          this.store.remove(id);
          continue;
        }

        const meta = savedMeta[id];
        const backend = normalizeBackend(meta?.backend);
        // Recovered sessions predate this process — recover the CLI's cwd from
        // tmux so transcript discovery can still find their session files.
        const paneCwd = this.tmuxExecSafe(
          ['display-message', '-t', tmuxName, '-p', '#{pane_current_path}'],
        ).trim();
        this.sessions.set(id, {
          id,
          backend,
          tmuxName,
          cwd: paneCwd || this.home,
          resumeSessionId: meta?.resumeSessionId || null,
          pty: null,
          ws: null,
          streamOutput: false,
          buffer: new RingBuffer(),
          createdAt: meta?.createdAt || Date.now(),
          lastActivity: Date.now(),
          title: meta?.title || new Date().toLocaleTimeString(),
          alive: true,
          dataDisposable: null,
        });

        recovered++;
        console.log(`[cc-terminal] Recovered: ${tmuxName} (${backend}) → "${meta?.title || '(untitled)'}"`);
      }

      if (recovered > 0) {
        console.log(`[cc-terminal] Recovered ${recovered} session(s) from tmux`);
      }
    } catch {
      console.log('[cc-terminal] No existing tmux sessions found');
    }
  }

  // ─── Session Lifecycle ───

  create(
    id: string,
    cols: number = DEFAULT_COLS,
    rows: number = DEFAULT_ROWS,
    options: TerminalCreateOptions = {},
  ): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum sessions (${MAX_SESSIONS}) reached. Close an existing session first.`);
    }
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists.`);
    }

    const tmuxName = `${TMUX_PREFIX}-${id}`;
    const now = Date.now();
    const cwd = this.resolveCwd(options.cwd);
    const backend = normalizeBackend(options.backend);
    const title = this.resolveTitle(options.title, now);
    const resumeId = this.resolveResumeId(options.resumeSessionId);
    let holderPid: string | null = null;

    // `claude --resume` looks the session up under the CURRENT cwd's project
    // dir. Resuming from the wrong directory makes the CLI print "No
    // conversation found" and exit — surface a real error instead.
    if (resumeId) {
      if (options.cwd && cwd !== options.cwd) {
        throw new Error(
          `Cannot resume here: working directory ${options.cwd} does not exist on this machine.`,
        );
      }
      if (backend === 'claude') {
        const transcript = path.join(claudeProjectsRoot(), projectIdFromCwd(cwd), `${resumeId}.jsonl`);
        if (!existsSync(transcript)) {
          throw new Error(
            `Cannot resume: session ${resumeId.slice(0, 8)}… has no transcript under ${cwd} — it may belong to another machine or directory.`,
          );
        }
        holderPid = findResumeHolder(resumeId);
      }
    }
    const backendExecutable = this.findBackendExecutable(backend);
    let backendArgs = buildBackendCommand({
      backend,
      executable: backendExecutable,
      cwd,
      resumeSessionId: resumeId,
      model: options.model,
      permissionMode: options.permissionMode,
      effort: options.effort,
      sandbox: options.sandbox,
      reasoningEffort: options.reasoningEffort,
    });

    // Session held by a live bg agent (daemon serving the desktop app / TG
    // bridge): a fresh `--resume` prints a refusal and dies within a second.
    // The CLI offers no non-interactive attach (verified on 2.1.218), so fall
    // back to the interactive agents picker in this same terminal — selecting
    // the session there takes it over for real.
    if (holderPid) {
      backendArgs = [backendExecutable, 'agents'];
    }

    // Create detached tmux session running the selected CLI with correct env.
    const envCmd = `env PATH=${shellQuote(this.enrichedEnv.PATH)} TERM=xterm-256color FORCE_COLOR=1 HOME=${shellQuote(this.home)} ${backendArgs.map(shellQuote).join(' ')}`;
    this.tmuxExec(['new-session', '-d', '-s', tmuxName, '-x', String(cols), '-y', String(rows), '-c', cwd, envCmd]);

    // Spawn PTY bridge
    const ptyProcess = this.spawnBridge(tmuxName, cols, rows);

    const session: TerminalSession = {
      id,
      backend,
      tmuxName,
      cwd,
      resumeSessionId: resumeId,
      pty: ptyProcess,
      ws: null,
      streamOutput: false,
      buffer: new RingBuffer(),
      createdAt: now,
      lastActivity: now,
      title,
      alive: true,
      dataDisposable: null,
    };

    if (holderPid) {
      session.buffer.write(
        `\x1b[33m该会话正被后台 agent 持有（pid ${holderPid}，桌面 app / TG bridge 正在用它）。\r\n` +
        `已打开 agents 列表——选中目标会话回车即可接管（接管后原端会失去它）；Esc 退出。\x1b[0m\r\n\r\n`,
      );
    }

    this.setupPtyHandlers(session);
    this.sessions.set(id, session);
    this.store.save(id, {
      backend: session.backend,
      title: session.title,
      createdAt: now,
      resumeSessionId: resumeId,
    });

    console.log(`[cc-terminal] Created: ${id} (${backend}) → tmux:${tmuxName} cwd=${cwd}${holderPid ? ' [agents-picker fallback]' : ''} (${this.sessions.size}/${MAX_SESSIONS})`);
    return this.toSessionInfo(session);
  }

  attach(sessionId: string, ws: WebSocket, streamOutput = true): void {
    const session = this.getSession(sessionId);

    // If another client already owns this session, tell it that it has been
    // taken over and demote it to read-only — mutating operations are rejected
    // from now on (see assertOwner()). Without this, the old device writes blind.
    if (session.ws && session.ws !== ws && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.send(JSON.stringify({ type: 'taken_over' })); } catch {}
    }

    // Lazy PTY: spawn bridge if not yet connected (recovered session)
    if (!session.pty) {
      const ptyProcess = this.spawnBridge(session.tmuxName, DEFAULT_COLS, DEFAULT_ROWS);
      session.pty = ptyProcess;
      this.setupPtyHandlers(session);
      console.log(`[cc-terminal] Spawned PTY bridge for recovered session: ${sessionId}`);
    }

    // Terminal views receive the raw PTY stream (including replay). Chat and
    // control sockets only claim ownership; their transcript/status channels
    // already carry what they render.
    if (streamOutput) {
      const buffered = session.buffer.read();
      if (buffered.length > 0) {
        ws.send(JSON.stringify({ type: 'output', data: buffered }));
      }
    }

    session.ws = ws;
    session.streamOutput = streamOutput;
    session.lastActivity = Date.now();
  }

  detach(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Only the current owner may detach. Prevents a stale connection's close
    // (after it was taken over) from clearing the new owner's ws.
    if (session.ws !== ws) return;
    session.ws = null;
    session.streamOutput = false;
    session.lastActivity = Date.now();
  }

  write(sessionId: string, data: string, ws: WebSocket): void {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ws);

    // Auto-detect title from first input.
    if (session.title === new Date(session.createdAt).toLocaleTimeString()) {
      const trimmed = titleFromInput(data);
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

  resize(sessionId: string, cols: number, rows: number, ws: WebSocket): void {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ws);
    if (session.pty) {
      session.pty.resize(cols, rows);
    }
    // Also resize tmux window so it matches
    this.tmuxExecSafe(['resize-window', '-t', session.tmuxName, '-x', String(cols), '-y', String(rows)]);
    session.lastActivity = Date.now();
  }

  kill(sessionId: string, ws: WebSocket): void {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ws);
    this.killSession(session);
  }

  private killSession(session: TerminalSession): void {
    const sessionId = session.id;

    console.log(`[cc-terminal] Killing: ${sessionId}`);

    if (session.pty) {
      try { session.pty.kill(); } catch {}
    }
    if (session.dataDisposable) {
      session.dataDisposable.dispose();
    }

    this.tmuxExecSafe(['kill-session', '-t', session.tmuxName]);
    session.alive = false;
    this.store.remove(sessionId);
    this.sessions.delete(sessionId);
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map((s) => this.toSessionInfo(s))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getSessionTitle(id: string): string {
    return this.sessions.get(id)?.title || '';
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  // ─── PTY Bridge ───

  private spawnBridge(tmuxName: string, cols: number, rows: number): pty.IPty {
    return pty.spawn(this.tmuxPath, ['-L', TMUX_SOCKET, '-u', 'attach-session', '-t', tmuxName], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.home,
      env: this.enrichedEnv,
    });
  }

  private setupPtyHandlers(session: TerminalSession): void {
    if (!session.pty) return;

    session.dataDisposable = session.pty.onData((data: string) => {
      session.lastActivity = Date.now();
      // Strip Device Attributes responses that leak when tmux queries xterm.js
      // DA1: \x1b[?...c  DA2: \x1b[>...c  DA3: \x1b[=...c
      const cleaned = data
        .replace(/\x1b\[\?[\d;]*c/g, '')
        .replace(/\x1b\[>[\d;]*c/g, '')
        .replace(/\x1b\[=[\d;]*c/g, '');
      if (cleaned.length === 0) return;
      session.buffer.write(cleaned);
      if (session.ws && session.streamOutput && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'output', data: cleaned }));
      }
    });

    session.pty.onExit(({ exitCode }) => {
      console.log(`[cc-terminal] PTY bridge exited: ${session.id} (code ${exitCode})`);

      const tmuxAlive = this.isTmuxSessionAlive(session.tmuxName);
      const paneAlive = tmuxAlive && this.isPaneAlive(session.tmuxName);

      if (paneAlive) {
        // tmux session still alive — bridge can reconnect later
        console.log(`[cc-terminal] tmux:${session.tmuxName} still alive, bridge can reconnect`);
        session.pty = null;
        session.dataDisposable = null;
      } else {
        // Claude exited — session is dead
        console.log(`[cc-terminal] Session ${session.id} is dead`);
        session.alive = false;

        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          // A CLI dying right after spawn usually printed the reason (bad
          // flag, session held elsewhere, …) — replay its last words as
          // plain text, since the raw stream flashed by too fast to read.
          const shortLived = Date.now() - session.createdAt < 15_000;
          const lastOutput = shortLived
            ? stripTerminalNoise(session.buffer.read()).split('\n').slice(-6).join('\n')
            : '';
          session.ws.send(JSON.stringify({
            type: 'exit', sessionId: session.id, code: exitCode,
            ...(lastOutput ? { lastOutput } : {}),
          }));
        }

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
    const result = spawnSync('which', ['tmux']);
    if (result.status === 0) return result.stdout.toString().trim();
    throw new Error('tmux not found. Install via: brew install tmux');
  }

  private tmuxExec(args: string[]): string {
    return execFileSync(
      this.tmuxPath,
      ['-L', TMUX_SOCKET, '-f', this.tmuxConf, ...args],
      { env: this.enrichedEnv as NodeJS.ProcessEnv, timeout: 5000 },
    ).toString();
  }

  private tmuxExecSafe(args: string[]): string {
    try { return this.tmuxExec(args); } catch { return ''; }
  }

  private isTmuxSessionAlive(tmuxName: string): boolean {
    try { this.tmuxExec(['has-session', '-t', tmuxName]); return true; } catch { return false; }
  }

  private isPaneAlive(tmuxName: string): boolean {
    try {
      return this.tmuxExec(['list-panes', '-t', tmuxName, '-F', '#{pane_dead}']).trim() === '0';
    } catch { return false; }
  }

  // ─── Utilities ───

  private getSession(id: string): TerminalSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found.`);
    if (!session.alive) throw new Error(`Session ${id} has exited.`);
    return session;
  }

  private assertOwner(session: TerminalSession, ws: WebSocket): void {
    if (session.ws !== ws) {
      throw new Error(`Session ${session.id} is not attached to this connection.`);
    }
  }

  private toSessionInfo(s: TerminalSession): SessionInfo {
    return {
      id: s.id, backend: s.backend, title: s.title, cwd: s.cwd,
      resumeSessionId: s.resumeSessionId, createdAt: s.createdAt,
      lastActivity: s.lastActivity, attached: s.ws !== null, alive: s.alive,
    };
  }

  private findBackendExecutable(backend: HistoryBackend): string {
    if (backend === 'codex') {
      return this.findExecutable('codex', [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(this.home, '.local', 'bin', 'codex'),
      ]);
    }

    return this.findExecutable('claude', [
      path.join(this.home, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ]);
  }

  private findExecutable(name: string, candidates: string[]): string {
    for (const p of candidates) {
      if (spawnSync('test', ['-x', p]).status === 0) return p;
    }
    const result = spawnSync('which', [name], { env: this.enrichedEnv as NodeJS.ProcessEnv });
    if (result.status === 0) return result.stdout.toString().trim();
    throw new Error(`${name} not found in PATH`);
  }

  private resolveCwd(cwd: string | undefined): string {
    if (!cwd || !path.isAbsolute(cwd) || !existsSync(cwd)) return this.home;
    return cwd;
  }

  private resolveResumeId(resumeSessionId: string | undefined): string | null {
    if (!resumeSessionId) return null;
    return /^[A-Za-z0-9_-]+$/.test(resumeSessionId) ? resumeSessionId : null;
  }

  private resolveTitle(title: string | undefined, createdAt: number): string {
    const trimmed = title?.replace(/\s+/g, ' ').trim();
    if (!trimmed) return new Date(createdAt).toLocaleTimeString();
    return trimmed.length > 50 ? trimmed.slice(0, 50) : trimmed;
  }

  private cleanupIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions.entries()) {
      if (!s.ws && (now - s.lastActivity) > IDLE_TIMEOUT) {
        console.log(`[cc-terminal] Cleaning up idle session: ${id}`);
        this.killSession(s);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    // Kill bridges but leave tmux alive for recovery
    for (const s of this.sessions.values()) {
      if (s.pty) { try { s.pty.kill(); } catch {} }
      if (s.dataDisposable) s.dataDisposable.dispose();
    }
    this.sessions.clear();
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type ProcessGrep = (pattern: string) => string;

const defaultProcessGrep: ProcessGrep = (pattern) => {
  const result = spawnSync('pgrep', ['-f', pattern], { timeout: 2000 });
  return result.status === 0 ? result.stdout.toString() : '';
};

/**
 * A session already loaded by another live process (a daemon-managed
 * background agent serving the desktop app or the TG bridge, or another
 * terminal here) makes any new `claude --resume` print "currently running
 * as a background agent" and exit within a second — which the user only
 * sees as a terminal that dies instantly. Detect the holder up front.
 *
 * Matches both invocation shapes: `--resume <sessionId>` (interactive CLI)
 * and `--resume /path/to/<sessionId>.jsonl` (daemon bg agents).
 * Fails open: if pgrep is missing or errors, resume proceeds and the CLI
 * reports the conflict itself.
 */
export function findResumeHolder(
  resumeId: string,
  processGrep: ProcessGrep = defaultProcessGrep,
): string | null {
  try {
    // Pattern must not start with "-" or pgrep parses it as a flag.
    const pid = processGrep(`resume[ =].*${resumeId}`).trim().split('\n')[0];
    return pid || null;
  } catch {
    return null;
  }
}

/**
 * The first real input doubles as the session title. Reuses the transcript
 * stripper rather than a lighter one: a terminal answers the CLI's colour
 * query with `\x1b]10;rgb:…`, and that reply arrives here as *input* — drop
 * only the control chars and the visible `]10;rgb:…` becomes the title.
 * Bracketed-paste wrappers and a bare Esc (interrupt) fall away the same way.
 */
export function titleFromInput(data: string): string {
  return stripTerminalNoise(data).replace(/\s+/g, ' ').trim();
}

/**
 * Reduce raw PTY output to the readable text lines a dying CLI printed —
 * strips CSI/OSC escape sequences and control chars so the message can be
 * replayed outside a terminal emulator.
 */
export function stripTerminalNoise(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, '')      // CSI sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()][0-9A-B]/g, '')                // charset selection
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[a-zA-Z<>=]/g, '')                 // bare ESC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')        // control chars (keep \n \t)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
}
