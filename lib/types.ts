// ─── WebSocket Protocol ───
import type { HistoryBackend } from './backends';

// Client -> Server (JSON)
export type ClientMessage =
  | ({ type: 'create'; cols?: number; rows?: number } & TerminalCreateOptions)
  | { type: 'attach'; sessionId: string; streamOutput?: boolean }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'list' }
  | { type: 'chat_attach'; sessionId: string }
  | { type: 'chat_detach' }
  | { type: 'watch_status' }
  | { type: 'chat_input'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string };

// Server -> Client (JSON)
export type ServerMessage =
  | { type: 'created'; sessionId: string; backend: HistoryBackend; title: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'error'; message: string }
  | { type: 'sessions'; list: SessionInfo[] }
  | { type: 'taken_over' }
  | { type: 'chat_init'; sessionId: string; state: ChatClaimState; messages: ChatMessage[]; meta: TranscriptMeta; truncated: boolean }
  | { type: 'chat_event'; sessionId: string; upserts: ChatMessage[]; meta?: TranscriptMeta }
  | { type: 'chat_state'; sessionId: string; state: ChatClaimState }
  | { type: 'status_all'; statuses: SessionStatus[] };

export interface SessionInfo {
  id: string;
  backend: HistoryBackend;
  title: string;
  cwd: string;
  resumeSessionId?: string | null;
  createdAt: number;
  lastActivity: number;
  attached: boolean;          // true if a WS is currently attached
  alive: boolean;             // true if PTY process is still running
}

// ─── Chat Transcript ───

/** One tool invocation inside an assistant message. */
export interface ToolCallInfo {
  id: string;
  name: string;
  summary: string;
}

/** A rendered chat message reconstructed from the on-disk session transcript. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;               // markdown source, newlines preserved
  tools: ToolCallInfo[];
  timestamp: string;
}

/**
 * pending   — terminal spawned, still looking for its transcript file
 * claimed   — transcript file found, chat stream live
 * unclaimed — gave up finding a transcript (chat view unavailable)
 */
export type ChatClaimState = 'pending' | 'claimed' | 'unclaimed';

export interface TranscriptMeta {
  model?: string;
  gitBranch?: string;
  contextTokens?: number;     // latest request input+cache ≈ current context size
  totalOutTokens?: number;    // cumulative output tokens
  aiTitle?: string;
  transcriptId?: string;      // on-disk session id
}

export interface SessionStatus {
  sessionId: string;
  state: 'working' | 'idle' | 'unknown';
  claim: ChatClaimState;
  currentAction?: string;     // latest tool call, e.g. "Bash: git status"
  lastReplyAt?: string;
  lastReplyPreview?: string;
  model?: string;
  aiTitle?: string;
  /** On-disk transcript id this live session is writing — lets the UI route
   * a history "Resume" to the already-running session instead of forking. */
  transcriptId?: string;
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
  /** claude: --model alias/full name · codex: -m */
  model?: string;
  /** claude only: --permission-mode */
  permissionMode?: string;
  /** claude only: --effort */
  effort?: string;
  /** codex only: -s/--sandbox */
  sandbox?: string;
  /** codex only: -c model_reasoning_effort=… */
  reasoningEffort?: string;
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
