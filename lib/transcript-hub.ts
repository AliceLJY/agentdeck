import { WebSocket } from 'ws';
import { watch, createReadStream, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { TranscriptParser } from './transcript-parser';
import { discoverTranscript, type DiscoveryTarget, type DiscoveryRoots } from './session-discovery';
import type { ChatClaimState, ChatMessage, SessionStatus } from './types';

/**
 * TranscriptHub — the read-side companion to TerminalManager.
 *
 * For every live terminal session it (1) discovers the on-disk transcript
 * file the CLI is writing, (2) tails it incrementally through
 * TranscriptParser, and (3) fans the parsed chat stream out to WebSocket
 * subscribers: per-session chat subscribers (`chat_attach`) and global
 * status watchers (`watch_status`, for the sidebar).
 *
 * It never touches the PTY — input stays in ws-handler/TerminalManager.
 */

const DISCOVERY_INTERVAL_MS = 1_500;
/** After this window we mark the session `unclaimed`… */
const DISCOVERY_TIMEOUT_MS = 60_000;
/** …but keep retrying slowly forever: the CLI only creates its transcript
 * file on the FIRST prompt, which may come minutes after spawn. */
const DISCOVERY_SLOW_MS = 5_000;
const POLL_MS = 1_500;
const STATUS_TICK_MS = 1_000;
/** jsonl silent for longer than this → session considered idle. */
const WORKING_WINDOW_MS = 10_000;
/** chat_init payload cap; older messages are dropped from the wire, not memory. */
const CHAT_INIT_LIMIT = 200;

interface Tracked {
  sessionId: string;
  target: DiscoveryTarget;
  state: ChatClaimState;
  filePath: string | null;
  parser: TranscriptParser | null;
  offset: number;
  carry: string;
  reading: boolean;
  lastEventMs: number;
  lastAction?: string;
  lastReplyAt?: string;
  lastReplyPreview?: string;
  discoveryTimer: ReturnType<typeof setTimeout> | null;
  discoveryDeadline: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  fsWatcher: FSWatcher | null;
  chatSubs: Set<WebSocket>;
}

export class TranscriptHub {
  private tracked = new Map<string, Tracked>();
  private statusSubs = new Set<WebSocket>();
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatusJson = '';
  private roots: DiscoveryRoots;

  constructor(roots: DiscoveryRoots = {}) {
    this.roots = roots;
  }

  // ─── Session lifecycle (driven by ws-handler / server startup) ───

  track(sessionId: string, target: DiscoveryTarget): void {
    if (this.tracked.has(sessionId)) return;
    const t: Tracked = {
      sessionId,
      target,
      state: 'pending',
      filePath: null,
      parser: null,
      offset: 0,
      carry: '',
      reading: false,
      lastEventMs: 0,
      discoveryTimer: null,
      discoveryDeadline: 0,
      pollTimer: null,
      fsWatcher: null,
      chatSubs: new Set(),
    };
    this.tracked.set(sessionId, t);
    this.startDiscovery(t);
  }

  untrack(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    if (t.discoveryTimer) clearTimeout(t.discoveryTimer);
    if (t.pollTimer) clearInterval(t.pollTimer);
    if (t.fsWatcher) { try { t.fsWatcher.close(); } catch {} }
    t.chatSubs.clear();
    this.tracked.delete(sessionId);
  }

  // ─── WebSocket subscriptions ───

  attachChat(ws: WebSocket, sessionId: string): void {
    this.detachChat(ws);
    const t = this.tracked.get(sessionId);
    if (!t) {
      send(ws, { type: 'chat_init', sessionId, state: 'unclaimed', messages: [], meta: {}, truncated: false });
      return;
    }
    t.chatSubs.add(ws);
    this.sendChatInit(ws, t);
    // A viewer showing up is a good reason to retry a given-up discovery.
    if (t.state === 'unclaimed') this.startDiscovery(t);
  }

  detachChat(ws: WebSocket): void {
    for (const t of this.tracked.values()) t.chatSubs.delete(ws);
  }

  watchStatus(ws: WebSocket): void {
    this.statusSubs.add(ws);
    send(ws, { type: 'status_all', statuses: this.computeStatuses() });
    this.ensureStatusTimer();
  }

  /** Remove a closed/gone socket from every subscription list. */
  release(ws: WebSocket): void {
    this.detachChat(ws);
    this.statusSubs.delete(ws);
  }

  // ─── Discovery ───

  private startDiscovery(t: Tracked): void {
    if (t.discoveryTimer) return;
    t.discoveryDeadline = Date.now() + DISCOVERY_TIMEOUT_MS;

    const tick = async () => {
      t.discoveryTimer = null;
      if (!this.tracked.has(t.sessionId) || t.state === 'claimed') return;
      let found: string | null = null;
      try {
        found = await discoverTranscript(t.target, {
          ...this.roots,
          excludePaths: this.claimedPaths(),
        });
      } catch {
        found = null;
      }
      if (found) {
        // Re-check at claim time: several sessions discover concurrently
        // (server restart recovers them all at once) and the exclude set each
        // one scanned with is already stale by now.
        if (this.claimedPaths().has(found)) {
          t.discoveryTimer = setTimeout(tick, DISCOVERY_INTERVAL_MS);
          return;
        }
        await this.claim(t, found);
        return;
      }
      const pastDeadline = Date.now() >= t.discoveryDeadline;
      if (pastDeadline && t.state === 'pending') {
        t.state = 'unclaimed'; // demote the UI, but never stop looking
        this.broadcastState(t);
      }
      t.discoveryTimer = setTimeout(tick, pastDeadline ? DISCOVERY_SLOW_MS : DISCOVERY_INTERVAL_MS);
    };

    t.discoveryTimer = setTimeout(tick, 300);
  }

  /** Transcripts already claimed by live sessions — one file, one owner. */
  private claimedPaths(): Set<string> {
    const set = new Set<string>();
    for (const t of this.tracked.values()) {
      if (t.filePath) set.add(t.filePath);
    }
    return set;
  }

  /** A prompt was just sent — the transcript file is about to exist. */
  nudgeDiscovery(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (!t || t.state === 'claimed') return;
    t.discoveryDeadline = Date.now() + DISCOVERY_TIMEOUT_MS; // back to fast polling
    if (t.discoveryTimer) {
      clearTimeout(t.discoveryTimer);
      t.discoveryTimer = null;
    }
    this.startDiscovery(t);
  }

  private async claim(t: Tracked, filePath: string): Promise<void> {
    t.filePath = filePath;
    t.parser = new TranscriptParser(t.target.backend);
    t.offset = 0;
    t.carry = '';
    t.state = 'claimed';
    console.log(`[cc-terminal] Transcript claimed: ${t.sessionId} → ${filePath}`);

    await this.readIncremental(t, { silent: true }); // backfill history without spamming chat_event

    try {
      t.fsWatcher = watch(filePath, () => void this.readIncremental(t));
    } catch {
      t.fsWatcher = null; // poll timer still covers us
    }
    t.pollTimer = setInterval(() => void this.readIncremental(t), POLL_MS);

    this.broadcastState(t);
    for (const ws of t.chatSubs) this.sendChatInit(ws, t);
    this.ensureStatusTimer();
  }

  // ─── Incremental tail ───

  private async readIncremental(t: Tracked, opts: { silent?: boolean } = {}): Promise<void> {
    if (t.reading || !t.filePath || !t.parser) return;
    t.reading = true;
    try {
      const fileStat = await stat(t.filePath);
      if (fileStat.size < t.offset) {
        // truncated/rewritten — restart from scratch; upserts are idempotent client-side
        t.offset = 0;
        t.carry = '';
        t.parser = new TranscriptParser(t.target.backend);
      }
      if (fileStat.size === t.offset) return;

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(t.filePath!, { start: t.offset, end: fileStat.size - 1 });
        stream.on('data', (chunk) => chunks.push(chunk as Buffer));
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
      t.offset = fileStat.size;
      t.lastEventMs = fileStat.mtimeMs;

      const text = t.carry + Buffer.concat(chunks).toString('utf8');
      const lines = text.split('\n');
      t.carry = lines.pop() || '';

      const upserts = new Map<string, ChatMessage>();
      let metaChanged = false;
      for (const line of lines) {
        const result = t.parser.parseLine(line);
        for (const message of result.upserts) upserts.set(message.id, message);
        if (result.metaChanged) metaChanged = true;
      }
      if (upserts.size === 0 && !metaChanged) return;

      this.updateStatusFrom(t, upserts.values());
      if (!opts.silent) {
        const payload = JSON.stringify({
          type: 'chat_event',
          sessionId: t.sessionId,
          upserts: [...upserts.values()],
          meta: metaChanged ? t.parser.meta : undefined,
        });
        for (const ws of t.chatSubs) sendRaw(ws, payload);
      }
    } catch {
      // transient fs errors: next poll retries
    } finally {
      t.reading = false;
    }
  }

  private updateStatusFrom(t: Tracked, upserts: Iterable<ChatMessage>): void {
    for (const message of upserts) {
      if (message.role !== 'assistant') continue;
      if (message.tools.length > 0) {
        const tool = message.tools[message.tools.length - 1];
        t.lastAction = tool.summary ? `${tool.name}: ${tool.summary}` : tool.name;
      }
      if (message.text.trim()) {
        t.lastReplyAt = message.timestamp;
        t.lastReplyPreview = preview(message.text);
      }
    }
  }

  // ─── Chat init / state fan-out ───

  private sendChatInit(ws: WebSocket, t: Tracked): void {
    const all = t.parser?.all() ?? [];
    send(ws, {
      type: 'chat_init',
      sessionId: t.sessionId,
      state: t.state,
      messages: all.slice(-CHAT_INIT_LIMIT),
      meta: t.parser?.meta ?? {},
      truncated: all.length > CHAT_INIT_LIMIT,
    });
  }

  private broadcastState(t: Tracked): void {
    const payload = JSON.stringify({ type: 'chat_state', sessionId: t.sessionId, state: t.state });
    for (const ws of t.chatSubs) sendRaw(ws, payload);
  }

  // ─── Status broadcasting (sidebar) ───

  private ensureStatusTimer(): void {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => {
      if (this.statusSubs.size === 0) return;
      const statuses = this.computeStatuses();
      const json = JSON.stringify(statuses);
      if (json === this.lastStatusJson) return;
      this.lastStatusJson = json;
      const payload = JSON.stringify({ type: 'status_all', statuses });
      for (const ws of this.statusSubs) {
        if (ws.readyState === WebSocket.OPEN) sendRaw(ws, payload);
        else this.statusSubs.delete(ws);
      }
    }, STATUS_TICK_MS);
    this.statusTimer.unref?.();
  }

  private computeStatuses(): SessionStatus[] {
    const now = Date.now();
    return [...this.tracked.values()].map((t) => {
      const working = t.state === 'claimed' && now - t.lastEventMs < WORKING_WINDOW_MS;
      return {
        sessionId: t.sessionId,
        state: t.state === 'claimed' ? (working ? 'working' : 'idle') : 'unknown',
        claim: t.state,
        currentAction: t.lastAction,
        lastReplyAt: t.lastReplyAt,
        lastReplyPreview: t.lastReplyPreview,
        model: t.parser?.meta.model,
        aiTitle: t.parser?.meta.aiTitle,
        transcriptId: t.parser?.meta.transcriptId,
      } satisfies SessionStatus;
    });
  }

  destroy(): void {
    for (const id of [...this.tracked.keys()]) this.untrack(id);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusSubs.clear();
  }
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 100 ? `${normalized.slice(0, 97)}…` : normalized;
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  sendRaw(ws, JSON.stringify(msg));
}

function sendRaw(ws: WebSocket, payload: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(payload); } catch {}
  }
}

export const transcriptHub = new TranscriptHub();
