import * as fs from 'fs';
import * as path from 'path';
import type { HistoryBackend } from './backends';

interface SessionMeta {
  backend?: HistoryBackend;
  title: string;
  createdAt: number;
  /** Transcript id this session resumed from. Resume APPENDS to the original
   * transcript file instead of creating a new one, so discovery must know
   * this — including after a server restart. */
  resumeSessionId?: string | null;
}

const HOME = process.env.HOME || '/Users/anxianjingya';
const STORE_PATH = path.join(HOME, '.agentdeck-sessions.json');
/** Pre-rename (cc-remote-term) location. Read as a fallback so upgrading in
 *  place keeps the titles and backends of sessions already running; the first
 *  save migrates them to STORE_PATH. */
const LEGACY_STORE_PATH = path.join(HOME, '.cc-remote-term-sessions.json');

/**
 * Persists session metadata (title, createdAt) to disk.
 * Survives server restarts — used to restore sidebar info
 * for tmux sessions that are still alive.
 */
export class SessionStore {
  private data: Record<string, SessionMeta> = {};

  constructor() {
    this.load();
  }

  private load(): void {
    for (const candidate of [STORE_PATH, LEGACY_STORE_PATH]) {
      try {
        this.data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        return;
      } catch {
        // Missing or unreadable — fall through to the next candidate
      }
    }
    this.data = {};
  }

  private persist(): void {
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[agentdeck] Failed to persist session store:', err);
    }
  }

  save(id: string, meta: SessionMeta): void {
    this.data[id] = meta;
    this.persist();
  }

  remove(id: string): void {
    delete this.data[id];
    this.persist();
  }

  get(id: string): SessionMeta | undefined {
    return this.data[id];
  }

  loadAll(): Record<string, SessionMeta> {
    return { ...this.data };
  }

  updateTitle(id: string, title: string): void {
    if (this.data[id]) {
      this.data[id].title = title;
      this.persist();
    }
  }
}
