import * as pty from 'node-pty';
import * as path from 'path';
import { WebSocket } from 'ws';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
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

/** All our tmux sessions use a dedicated socket to avoid polluting user's tmux.
 *  'ccrt' is the pre-rename (cc-remote-term) spelling and stays that way on
 *  purpose: the socket path and session prefix are how a restarted server
 *  finds the tmux sessions it left running. Renaming them would orphan every
 *  live session on upgrade — an invisible internal id is not worth that. */
const TMUX_SOCKET = 'ccrt';
const TMUX_PREFIX = 'ccrt';

/** Thrown by create() when the resume target is held by a live process and
 *  the caller has not confirmed the takeover. ws-handler turns it into a
 *  'resume_held' message so the viewer gets a consent prompt instead of a
 *  silent kick — see the holder block in create(). */
export class ResumeHeldError extends Error {
  constructor(public readonly holderPid: string) {
    super(`Resume target held by pid ${holderPid}`);
    this.name = 'ResumeHeldError';
  }
}

/** How long attach() waits after resizing for the CLI to repaint at the new
 *  width before capturing history and replaying the ring buffer. Claude Code
 *  (and codex/kimi/agy) start their SIGWINCH repaint well under this; going
 *  much higher only delays first paint on every attach. */
const REPAINT_GRACE_MS = 150;

/** Executable lookup order per backend, first existing path wins;
 *  `findExecutable` falls back to `which <backend>` when none of them exist.
 *
 *  Typed as Record<HistoryBackend, …> on purpose: adding an id to
 *  HistoryBackend without adding it here is a compile error. This used to be a
 *  chain of `if (backend === …)` ending in a `claude` fallback, and agy — added
 *  2026-07-30 — fell straight through it, launching `claude` with agy-only
 *  flags (`--conversation`, `--mode`) that claude rejects. Nothing surfaced the
 *  mistake because the fallback's `which claude` succeeds, so there was never
 *  an "agy not found" to notice. Fixed 2026-08-07. */
export function backendExecutableCandidates(home: string): Record<HistoryBackend, string[]> {
  return {
    claude: [
      path.join(home, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ],
    codex: [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(home, '.local', 'bin', 'codex'),
    ],
    // kimi-code installs to ~/.kimi-code/bin, which is not on PATH by default —
    // check there first so a missing PATH entry isn't read as "kimi is not installed".
    kimi: [
      path.join(home, '.kimi-code', 'bin', 'kimi'),
      path.join(home, '.local', 'bin', 'kimi'),
      '/opt/homebrew/bin/kimi',
      '/usr/local/bin/kimi',
    ],
    agy: [
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
      path.join(home, '.local', 'bin', 'agy'),
    ],
  };
}

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
          console.log(`[agentdeck] Removing dead tmux session: ${tmuxName}`);
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
        console.log(`[agentdeck] Recovered: ${tmuxName} (${backend}) → "${meta?.title || '(untitled)'}"`);
      }

      if (recovered > 0) {
        console.log(`[agentdeck] Recovered ${recovered} session(s) from tmux`);
      }
    } catch {
      console.log('[agentdeck] No existing tmux sessions found');
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
    const backendArgs = buildBackendCommand({
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

    // Session held by a live process (daemon serving the desktop app / TG
    // bridge / another terminal): resuming would TAKE IT OVER — CLI ≥2.1.245
    // no longer refuses, it kicks the holder off (standing down, code 4090).
    // That is exactly the polite-confirmation gap Beam's dialog fills, and
    // silently doing it to a production bot's session would cut the bot off.
    // So: refuse here unless the viewer explicitly confirmed (takeover flag);
    // ws-handler turns this into a 'resume_held' prompt. The old fallback —
    // swapping in the `claude agents` picker — is gone: the picker is an
    // agent-task ledger keyed on agent-name records, interactive sessions
    // are not in it, so it could never offer the session being resumed
    // (verified 2026-08-26, the "menu without my session" loop).
    if (holderPid && !options.takeover) {
      throw new ResumeHeldError(holderPid);
    }

    // Claude Code's fullscreen renderer draws the conversation on the alternate
    // screen buffer, which by definition has no scrollback — the history simply
    // is not reachable from the terminal, here or in iTerm2. Its classic
    // renderer streams into the normal buffer instead, which is what makes the
    // transcript scrollable and selectable at all. Forced per session rather
    // than by touching the user's global `tui` setting: fullscreen stays on
    // where it earns its keep (a desktop terminal, where flicker is the
    // problem), and off here, where being able to scroll and copy on a phone
    // matters more. Codex gets the same treatment via its --no-alt-screen flag.
    const rendererEnv = backend === 'claude' ? ' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1' : '';

    // Create detached tmux session running the selected CLI with correct env.
    const envCmd = `env PATH=${shellQuote(this.enrichedEnv.PATH)} TERM=xterm-256color FORCE_COLOR=1 HOME=${shellQuote(this.home)}${rendererEnv} ${backendArgs.map(shellQuote).join(' ')}`;
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
        `\x1b[33m已确认接管：原持有进程（pid ${holderPid}）将被踢下线（standing down）。\x1b[0m\r\n\r\n`,
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

    console.log(`[agentdeck] Created: ${id} (${backend}) → tmux:${tmuxName} cwd=${cwd}${holderPid ? ' [agents-picker fallback]' : ''} (${this.sessions.size}/${MAX_SESSIONS})`);
    return this.toSessionInfo(session);
  }

  async attach(
    sessionId: string,
    ws: WebSocket,
    streamOutput = true,
    dims?: { cols: number; rows: number },
  ): Promise<void> {
    const session = this.getSession(sessionId);

    // A recovered entry whose tmux session is gone is a tombstone, not a
    // session. Spawning a bridge would just die with "can't find session"
    // (exit 1) and bounce the viewer straight back home with a cryptic exit —
    // the four "Session not found" taps of 2026-08-26. Say what happened,
    // hand over what's needed to reopen from history, and bury the entry so
    // the list stops offering it.
    if (!session.pty && !this.isTmuxSessionAlive(session.tmuxName)) {
      try {
        ws.send(JSON.stringify({
          type: 'session_dead',
          sessionId: session.id,
          resumeSessionId: session.resumeSessionId || null,
        }));
      } catch {}
      session.alive = false;
      this.store.remove(session.id);
      this.sessions.delete(session.id);
      return;
    }

    // If another client already owns this session, tell it that it has been
    // taken over and demote it to read-only — mutating operations are rejected
    // from now on (see assertOwner()). Without this, the old device writes blind.
    if (session.ws && session.ws !== ws && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.send(JSON.stringify({ type: 'taken_over' })); } catch {}
    }

    // Lazy PTY: spawn bridge if not yet connected (recovered session)
    if (!session.pty) {
      const ptyProcess = this.spawnBridge(
        session.tmuxName, dims?.cols ?? DEFAULT_COLS, dims?.rows ?? DEFAULT_ROWS,
      );
      session.pty = ptyProcess;
      this.setupPtyHandlers(session);
      console.log(`[agentdeck] Spawned PTY bridge for recovered session: ${sessionId}`);
    }

    // Adopt the attaching client's geometry BEFORE capturing anything. Order
    // matters, and it used to be the other way around — history was captured
    // at the previous client's width and only then was the window resized,
    // which is exactly why every refresh on a phone painted a different set
    // of ghosts. tmux reflows its scrollback on resize-window, so a capture
    // taken after it is laid out for the width the viewer actually has.
    if (dims && dims.cols > 0 && dims.rows > 0) {
      this.applyDims(session, dims.cols, dims.rows);
      if (streamOutput) {
        // The ring buffer holds up to 5MB of raw PTY stream — repaint frames
        // positioned against whatever width the session had before. Replaying
        // those on a narrower xterm is the ghost pile itself, and unlike the
        // tmux grid they can never be reflowed. Drop them: everything they
        // ever painted is already in the scrollback the capture below carries.
        // Then give the CLI one beat to repaint at the new width (SIGWINCH),
        // so the buffer refills with frames laid out for THIS viewer — that
        // replay lands with exact cursor state, no guessing.
        session.buffer.clear();
        await new Promise((resolve) => setTimeout(resolve, REPAINT_GRACE_MS));
      }
    }

    // Terminal views receive the raw PTY stream (including replay). Chat and
    // control sockets only claim ownership; their transcript/status channels
    // already carry what they render.
    if (streamOutput) {
      // Scrollback first (tmux holds it — see captureTmuxHistory), then the
      // live screen from the ring buffer. Sent as two messages on purpose: the
      // history is a one-shot snapshot taken now, while the buffer keeps
      // replaying whatever has streamed since. If the CLI never repainted
      // during the grace period (a plain shell ignoring SIGWINCH), the buffer
      // is still empty — let the capture carry the visible screen instead so
      // the viewer does not land on a blank viewport.
      const includeVisible = session.buffer.size === 0;
      const history = this.captureTmuxHistory(session.tmuxName, 1000, includeVisible);
      if (history.length > 0) {
        ws.send(JSON.stringify({ type: 'output', data: history }));
      }
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
    this.applyDims(session, cols, rows);
    session.lastActivity = Date.now();
  }

  /** Resize both halves of the pipeline — the PTY bridge and the tmux window
   *  behind it. Shared by resize() (owner-checked) and attach() (pre-ownership:
   *  the attaching client is about to become owner, so the check would reject
   *  the one resize that matters most). */
  private applyDims(session: TerminalSession, cols: number, rows: number): void {
    if (session.pty) {
      session.pty.resize(cols, rows);
    }
    this.tmuxExecSafe(['resize-window', '-t', session.tmuxName, '-x', String(cols), '-y', String(rows)]);
  }

  /** Wipe a session's history everywhere the ghosts live: tmux's scrollback
   *  (the reflow fix keeps NEW captures clean, but rows already recorded by
   *  old sessions never heal) and the ring buffer (raw repaint frames). The
   *  visible screen is untouched — the client clears its own scrollback on
   *  the 'history_cleared' ack so both sides stay in step. */
  clearHistory(sessionId: string, ws: WebSocket): void {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ws);
    this.tmuxExecSafe(['clear-history', '-t', session.tmuxName]);
    session.buffer.clear();
    session.lastActivity = Date.now();
  }

  kill(sessionId: string, ws: WebSocket): void {
    const session = this.getSession(sessionId);
    this.assertOwner(session, ws);
    this.killSession(session);
  }

  private killSession(session: TerminalSession): void {
    const sessionId = session.id;

    console.log(`[agentdeck] Killing: ${sessionId}`);

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

  /**
   * Pull a session's scrollback out of tmux so the browser can scroll through it.
   *
   * tmux is the one holding the history here. It is a full terminal emulator,
   * not the passive "session container" the comment in tmux.conf claims: every
   * line goes into its own 50k-line history and only the current screen is ever
   * repainted down the PTY. The browser's xterm therefore sees repaints and
   * nothing else, and ends up with an empty scrollback — measured on a fresh
   * session, tmux held 209 lines while xterm held 0. "The terminal will not
   * scroll" was always "there is nothing above the fold to scroll to".
   *
   * `-e` keeps the colours, `-J` rejoins wrapped lines, and `-E -1` stops one
   * line short of the visible screen — the ring-buffer replay that follows this
   * already carries that screen, and without the cutoff every attach would show
   * it twice. When the ring buffer has nothing to replay (cleared on attach and
   * the CLI did not repaint within the grace period — e.g. a plain shell that
   * ignores SIGWINCH), pass includeVisible to let the capture carry the screen
   * itself, or the viewer would land on an empty viewport.
   */
  private captureTmuxHistory(tmuxName: string, lines = 1000, includeVisible = false): string {
    try {
      const endArgs = includeVisible ? [] : ['-E', '-1'];
      const out = execFileSync(
        this.tmuxPath,
        ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-e', '-J',
          '-S', `-${lines}`, ...endArgs, '-t', tmuxName],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 3000 },
      );
      const trimmed = out.replace(/\s+$/, '');
      // capture-pane emits bare \n; xterm runs with convertEol off.
      return trimmed ? trimmed.replace(/\n/g, '\r\n') + '\r\n' : '';
    } catch {
      // Best-effort. A session with no history, or a tmux that declines, must
      // never take the attach down with it.
      return '';
    }
  }

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
      console.log(`[agentdeck] PTY bridge exited: ${session.id} (code ${exitCode})`);

      const tmuxAlive = this.isTmuxSessionAlive(session.tmuxName);
      const paneAlive = tmuxAlive && this.isPaneAlive(session.tmuxName);

      if (paneAlive) {
        // tmux session still alive — bridge can reconnect later
        console.log(`[agentdeck] tmux:${session.tmuxName} still alive, bridge can reconnect`);
        session.pty = null;
        session.dataDisposable = null;
      } else {
        // Claude exited — session is dead
        console.log(`[agentdeck] Session ${session.id} is dead`);
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
    // The backend id doubles as the CLI name, so it is also the `which` fallback.
    return this.findExecutable(backend, backendExecutableCandidates(this.home)[backend]);
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
        console.log(`[agentdeck] Cleaning up idle session: ${id}`);
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
export type RosterReader = () => string | null;

const defaultProcessGrep: ProcessGrep = (pattern) => {
  const result = spawnSync('pgrep', ['-f', pattern], { timeout: 2000 });
  return result.status === 0 ? result.stdout.toString() : '';
};

export function claudeDaemonRosterPath(): string {
  return path.join(process.env.HOME || '', '.claude', 'daemon', 'roster.json');
}

const defaultRosterReader: RosterReader = () => {
  try {
    return readFileSync(claudeDaemonRosterPath(), 'utf8');
  } catch {
    return null;
  }
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still a holder.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The daemon's roster of live background agents. Since CLI 2.1.220 a bg agent
 * is hosted by the daemon rather than run as its own `claude --resume <id>`
 * process, so its session id never appears in any command line and the pgrep
 * path below cannot see it — which is exactly the case that bites, because
 * every session started from the TG bridge is held this way.
 *
 * Shape: `{ workers: { "<id-prefix>": { pid, sessionId, cwd, … } } }`. A stale
 * entry (daemon died without cleaning up) would wrongly divert a resume that
 * would have worked, so the pid is checked for life before believing it.
 */
function findRosterHolder(resumeId: string, readRoster: RosterReader): string | null {
  const raw = readRoster();
  if (!raw) return null;
  const parsed = JSON.parse(raw) as {
    workers?: Record<string, { pid?: number; sessionId?: string } | null>;
  };
  const workers = parsed?.workers;
  if (!workers || typeof workers !== 'object') return null;

  for (const worker of Object.values(workers)) {
    if (!worker || worker.sessionId !== resumeId) continue;
    const pid = worker.pid;
    if (typeof pid === 'number' && pid > 0 && pidAlive(pid)) return String(pid);
  }
  return null;
}

/**
 * A session already loaded by another live process (a daemon-managed
 * background agent serving the desktop app or the TG bridge, or another
 * terminal here) makes any new `claude --resume` print "currently running
 * as a background agent" and exit within a second — which the user only
 * sees as a terminal that dies instantly. Detect the holder up front.
 *
 * Two sources, because neither alone covers both cases:
 *   - the daemon roster, for bg agents it hosts (no session id in any argv)
 *   - pgrep, for a plain `claude --resume <id>` in another terminal. Matches
 *     both `--resume <sessionId>` and `--resume /path/to/<sessionId>.jsonl`.
 *
 * Fails open on either source: if the roster is missing/corrupt or pgrep
 * errors, the resume proceeds and the CLI reports the conflict itself.
 */
export function findResumeHolder(
  resumeId: string,
  processGrep: ProcessGrep = defaultProcessGrep,
  readRoster: RosterReader = defaultRosterReader,
): string | null {
  try {
    const rosterPid = findRosterHolder(resumeId, readRoster);
    if (rosterPid) return rosterPid;
  } catch {
    // Roster unreadable or malformed — fall through to pgrep.
  }
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
