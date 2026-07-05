'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getBackendDisplay, normalizeBackend, type HistoryBackend } from '@/lib/backends';
import type {
  ChatClaimState,
  ChatMessage,
  ServerMessage,
  TranscriptMeta,
} from '@/lib/types';

interface ChatViewProps {
  sessionId: string;
  backend: HistoryBackend;
  token: string;
  onRequestTerm?: () => void;
}

/**
 * Structured chat rendering of a live session — a read layer over the
 * transcript stream (chat_attach protocol) plus an input box that writes
 * straight to the PTY. TUI-only interactions (permission prompts, pickers)
 * still need the Terminal view; `onRequestTerm` jumps there.
 */
export default function ChatView({ sessionId, backend, token, onRequestTerm }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [claimState, setClaimState] = useState<ChatClaimState>('pending');
  const [meta, setMeta] = useState<TranscriptMeta>({});
  const [truncated, setTruncated] = useState(false);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [pinned, setPinned] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const byIdRef = useRef<Map<string, ChatMessage>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTouchRef = useRef(false);

  useEffect(() => {
    isTouchRef.current = navigator.maxTouchPoints > 0;
  }, []);

  const applyUpserts = useCallback((upserts: ChatMessage[]) => {
    if (upserts.length === 0) return;
    setMessages((prev) => {
      const next = [...prev];
      for (const message of upserts) {
        if (byIdRef.current.has(message.id)) {
          const idx = next.findIndex((m) => m.id === message.id);
          if (idx >= 0) next[idx] = message;
        } else {
          next.push(message);
        }
        byIdRef.current.set(message.id, message);
      }
      return next;
    });
  }, []);

  // ─── WebSocket (chat subscription) ───
  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${protocol}//${location.host}/ws/terminal?token=${encodeURIComponent(token)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setConnected(true);
        ws.send(JSON.stringify({ type: 'chat_attach', sessionId }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          if (msg.type === 'chat_init' && msg.sessionId === sessionId) {
            byIdRef.current = new Map(msg.messages.map((m) => [m.id, m]));
            setMessages(msg.messages);
            setClaimState(msg.state);
            setMeta(msg.meta || {});
            setTruncated(msg.truncated);
          } else if (msg.type === 'chat_event' && msg.sessionId === sessionId) {
            applyUpserts(msg.upserts);
            if (msg.meta) setMeta({ ...msg.meta });
          } else if (msg.type === 'chat_state' && msg.sessionId === sessionId) {
            setClaimState(msg.state);
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        if (reconnectAttemptsRef.current < 5) {
          const delay = Math.min(8000, Math.pow(2, reconnectAttemptsRef.current) * 1000);
          reconnectAttemptsRef.current++;
          reconnectTimerRef.current = setTimeout(connect, delay);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
      byIdRef.current = new Map();
      setMessages([]);
      setClaimState('pending');
      setMeta({});
    };
  }, [sessionId, token, applyUpserts]);

  // ─── Auto-scroll: follow the tail unless the user scrolled up ───
  useEffect(() => {
    if (pinnedRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = nearBottom;
    setPinned(nearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  // ─── Input ───
  const sendDraft = useCallback(() => {
    const text = draft.trim();
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat_input', sessionId, text }));
    setDraft('');
    scrollToBottom();
  }, [draft, sessionId, scrollToBottom]);

  const sendInterrupt = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'interrupt', sessionId }));
  }, [sessionId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop: Enter sends, Shift+Enter newline. Touch: Enter is newline, send via button.
    if (e.key === 'Enter' && !e.shiftKey && !isTouchRef.current) {
      e.preventDefault();
      sendDraft();
    }
  }, [sendDraft]);

  const display = getBackendDisplay(normalizeBackend(backend));

  // ─── Waiting / unavailable states ───
  if (claimState !== 'claimed' && messages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          {claimState === 'pending' ? (
            <>
              <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Waiting for the session transcript…
              </p>
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                It appears after the first prompt is sent.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                No transcript found for this session.
              </p>
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                Chat view needs the CLI&apos;s on-disk session file. You can keep working in the terminal.
              </p>
            </>
          )}
          {onRequestTerm && (
            <button
              onClick={onRequestTerm}
              className="mt-5 rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Open Terminal view
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-950">
      {/* Message list */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-5 py-4 space-y-4"
      >
        {truncated && (
          <p className="text-center text-xs text-gray-400 dark:text-gray-500">
            Earlier messages omitted — open the terminal or history view for the full transcript.
          </p>
        )}
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
      </div>

      {/* Jump to latest */}
      {!pinned && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute -top-12 right-4 z-10 rounded-full bg-gray-800/80 dark:bg-gray-200/90 text-white dark:text-gray-900 px-3 py-1.5 text-xs shadow-lg backdrop-blur"
          >
            ↓ Latest
          </button>
        </div>
      )}

      {/* Meta line */}
      <div className="flex items-center gap-2 px-4 py-1 text-[11px] text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-800 overflow-x-auto whitespace-nowrap">
        {meta.model && <span>{meta.model}</span>}
        {typeof meta.contextTokens === 'number' && meta.contextTokens > 0 && (
          <span>· ctx {formatTokens(meta.contextTokens)}</span>
        )}
        {typeof meta.totalOutTokens === 'number' && meta.totalOutTokens > 0 && (
          <span>· {formatTokens(meta.totalOutTokens)} out</span>
        )}
        {meta.gitBranch && <span>· {meta.gitBranch}</span>}
        {!connected && <span className="text-amber-500">· reconnecting…</span>}
      </div>

      {/* Input */}
      <div className="flex items-end gap-2 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${display.terminalName}…`}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          className="flex-1 resize-none rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2.5 text-[15px] leading-snug text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:border-blue-400 dark:focus:border-blue-500"
        />
        <button
          onClick={sendInterrupt}
          title="Interrupt (Esc)"
          className="shrink-0 h-11 w-11 rounded-xl border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors flex items-center justify-center"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <rect x="7" y="7" width="10" height="10" rx="1.5" />
          </svg>
        </button>
        <button
          onClick={sendDraft}
          disabled={!draft.trim()}
          title="Send"
          className="shrink-0 h-11 w-11 rounded-xl bg-blue-500 text-white disabled:opacity-40 hover:bg-blue-600 transition-colors flex items-center justify-center"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── Message rendering ───

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900 px-3.5 py-2.5 text-[15px] leading-relaxed text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words">
          {message.text}
        </div>
      </div>
    );
  }

  const hasText = message.text.trim().length > 0;
  return (
    <div className="space-y-2">
      {message.tools.length > 0 && <ToolStrip tools={message.tools} />}
      {hasText && (
        <div className="chat-md max-w-none text-[15px] leading-relaxed text-gray-900 dark:text-gray-100">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function ToolStrip({ tools }: { tools: ChatMessage['tools'] }) {
  const [open, setOpen] = useState(false);

  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
  const summary = [...counts.entries()]
    .slice(0, 4)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' · ');

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-gray-500 dark:text-gray-400"
      >
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="truncate">
          {tools.length} tool{tools.length > 1 ? 's' : ''} · {summary}
        </span>
      </button>
      {open && (
        <ul className="border-t border-gray-200 dark:border-gray-700 px-2.5 py-1.5 space-y-1">
          {tools.map((tool, i) => (
            <li key={`${tool.id}-${i}`} className="flex gap-1.5 text-gray-600 dark:text-gray-300 min-w-0">
              <span className="shrink-0 font-medium">{tool.name}</span>
              {tool.summary && (
                <span className="truncate font-mono text-gray-400 dark:text-gray-500">{tool.summary}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
