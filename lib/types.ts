// ─── WebSocket Protocol ───
import type { HistoryBackend } from './backends';

// Client -> Server (JSON)
export type ClientMessage =
  | ({ type: 'create'; cols?: number; rows?: number } & TerminalCreateOptions)
  | { type: 'attach'; sessionId: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'list' };

// Server -> Client (JSON)
export type ServerMessage =
  | { type: 'created'; sessionId: string; backend: HistoryBackend; title: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'error'; message: string }
  | { type: 'sessions'; list: SessionInfo[] }
  | { type: 'taken_over' };

export interface SessionInfo {
  id: string;
  backend: HistoryBackend;
  title: string;
  createdAt: number;
  lastActivity: number;
  attached: boolean;          // true if a WS is currently attached
  alive: boolean;             // true if PTY process is still running
}

// ─── Client-side Session Metadata (IndexedDB) ───

export interface TerminalSessionMeta {
  id: string;                 // matches server session ID
  backend: HistoryBackend;
  title: string;
  createdAt: number;
  lastSeen: number;           // last time client interacted
}

export interface TerminalCreateOptions {
  backend?: HistoryBackend;
  cwd?: string;
  resumeSessionId?: string;
  title?: string;
}

// ─── Terminal Manager Internal Types ───

export interface TerminalSessionState {
  id: string;
  backend: HistoryBackend;
  title: string;
  createdAt: number;
  lastActivity: number;
  attached: boolean;
  alive: boolean;
}

// ─── Constants ───

export const MAX_SESSIONS = 10;
export const IDLE_TIMEOUT = 30 * 60 * 1000;       // 30 minutes
export const RING_BUFFER_SIZE = 5 * 1024 * 1024;   // 5MB — covers full TUI history for cross-device replay
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 30;
