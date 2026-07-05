'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import Sidebar from '@/components/Sidebar';
import SessionRail from '@/components/SessionRail';
import HistoryHome from '@/components/HistoryHome';
import TokenGate from '@/components/TokenGate';
import TerminalKeyBar from '@/components/TerminalKeyBar';
import FileUpload from '@/components/FileUpload';
import DropZone from '@/components/DropZone';
import ChatView from '@/components/ChatView';
import { useTheme } from '@/hooks/useTheme';
import { useTerminalSessions } from '@/hooks/useTerminalSessions';
import { getBackendDisplay, normalizeBackend, type HistoryBackend } from '@/lib/backends';
import type {
  SessionInfo,
  SessionStatus,
  ServerMessage,
  TerminalCreateOptions,
  TerminalSessionMeta,
} from '@/lib/types';
import { saveSession } from '@/lib/db';

// Dynamic import to avoid SSR issues with xterm
const TerminalView = dynamic(() => import('@/components/TerminalView'), {
  ssr: false,
});

export default function Home() {
  const { theme, resolved, setTheme } = useTheme();
  const {
    sessions,
    activeSessionId,
    create,
    remove,
    select,
    updateTitle,
    refresh,
    setActiveSessionId,
  } = useTerminalSessions();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [token, setToken] = useState<string>('');
  const [aliveSessions, setAliveSessions] = useState<Set<string>>(new Set());
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [createOptions, setCreateOptions] = useState<TerminalCreateOptions | null>(null);
  const [viewModes, setViewModes] = useState<Record<string, 'chat' | 'term'>>({});

  // Per-session Chat/Term preference, remembered across visits
  useEffect(() => {
    try {
      const stored = localStorage.getItem('ccrt-view-modes');
      if (stored) setViewModes(JSON.parse(stored));
    } catch {
      // Corrupt/unavailable storage — fall back to defaults
    }
  }, []);

  const setViewMode = useCallback((sessionId: string, mode: 'chat' | 'term') => {
    setViewModes((prev) => {
      const next = { ...prev, [sessionId]: mode };
      try { localStorage.setItem('ccrt-view-modes', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Ref to the TerminalView's sendInput function
  const sendInputRef = useRef<((data: string) => void) | null>(null);

  // Resolve the token WITHOUT embedding it in the server-rendered HTML.
  // Priority: ?token= URL param (then scrub it from the address bar) → localStorage.
  // If neither yields a token, <TokenGate> below prompts the user to enter one.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get('token');
      if (fromUrl) {
        setToken(fromUrl);
        localStorage.setItem('cc-terminal-token', fromUrl);
        url.searchParams.delete('token');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
        return;
      }
      const stored = localStorage.getItem('cc-terminal-token');
      if (stored) setToken(stored);
    } catch {
      // localStorage unavailable (e.g. private mode); ?token= still works per load.
    }
  }, []);

  // Detect touch device
  useEffect(() => {
    setIsTouchDevice(navigator.maxTouchPoints > 0);
  }, []);

  // Live per-session status (working/idle + current action) from the hub
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});

  // Reconcile client IDB with server sessions (removes stale entries after restart)
  const handleServerSessionsRef = useRef<(list: SessionInfo[]) => void>(() => {});
  handleServerSessionsRef.current = (list) => {
    const serverIds = new Set(list.map((s) => s.id));
    const alive = new Set(list.filter((s) => s.alive).map((s) => s.id));
    setAliveSessions(alive);

    // Remove stale sessions from IDB that server doesn't know about
    let hadStale = false;
    sessions.forEach((s) => {
      if (!serverIds.has(s.id)) {
        remove(s.id);
        hadStale = true;
      }
    });

    // If all sessions were stale and active session is dead, reset to welcome
    if (hadStale && activeSessionId && !serverIds.has(activeSessionId)) {
      setActiveSessionId(null);
    }
  };

  // Persistent control socket: session reconcile + live status feed for the
  // sidebar/rail. Replaces the old fire-and-forget reconcile connection.
  const controlWsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    if (!token) return;
    let disposed = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${protocol}//${location.host}/ws/terminal?token=${encodeURIComponent(token)}`,
      );
      controlWsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        ws.send(JSON.stringify({ type: 'list' }));
        ws.send(JSON.stringify({ type: 'watch_status' }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          if (msg.type === 'sessions') {
            handleServerSessionsRef.current(msg.list);
          } else if (msg.type === 'status_all') {
            setStatuses(Object.fromEntries(msg.statuses.map((s) => [s.sessionId, s])));
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        controlWsRef.current = null;
        if (disposed) return;
        const delay = Math.min(15000, Math.pow(2, attempts) * 1000);
        attempts++;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    // Returning to the tab: refresh the list immediately (or reconnect now)
    const onFocus = () => {
      const ws = controlWsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'list' }));
      } else if (retryTimer) {
        clearTimeout(retryTimer);
        connect();
      }
    };
    window.addEventListener('focus', onFocus);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('focus', onFocus);
      controlWsRef.current?.close();
      controlWsRef.current = null;
    };
  }, [token]);

  // ── Session lifecycle handlers ──

  // Use '__new__' as a signal to TerminalView to create (not attach)
  const handleNewSession = useCallback((options?: TerminalCreateOptions) => {
    setCreateOptions(options || null);
    setActiveSessionId(`__new__:${Date.now()}`);
    setSidebarOpen(false);
  }, [setActiveSessionId]);

  const handleSelectSession = useCallback(
    (id: string) => {
      select(id);
      setSidebarOpen(false);
    },
    [select],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      // Send kill to server via a short-lived WS
      if (token && aliveSessions.has(id)) {
        try {
          const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(
            `${protocol}//${location.host}/ws/terminal?token=${encodeURIComponent(token)}`,
          );
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'kill', sessionId: id }));
            ws.close();
          };
        } catch {
          // Best-effort kill
        }
      }
      await remove(id);
      setAliveSessions((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [token, aliveSessions, remove],
  );

  const handleSessionCreated = useCallback(
    async (id: string, title: string, backendValue: HistoryBackend) => {
      // Server created the session — now save to IDB with server's real ID
      const now = Date.now();
      const backend = normalizeBackend(backendValue);
      const meta: TerminalSessionMeta = {
        id,
        backend,
        title: title || new Date(now).toLocaleString([], {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }),
        createdAt: now,
        lastSeen: now,
      };
      await saveSession(meta);
      await refresh();
      setActiveSessionId(id);
      setCreateOptions(null);
      setAliveSessions((prev) => new Set(prev).add(id));
    },
    [refresh, setActiveSessionId],
  );

  const handleSessionExited = useCallback(async (id: string) => {
    setAliveSessions((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    // Remove dead session from IDB so it doesn't linger in sidebar
    await remove(id);
    // If the exited session was the active one, reset to welcome screen
    if (activeSessionId === id) {
      setActiveSessionId(null);
    }
  }, [activeSessionId, remove, setActiveSessionId]);

  // Handle key bar input by forwarding to TerminalView
  const handleKeyBarInput = useCallback((data: string) => {
    if (sendInputRef.current) {
      sendInputRef.current(data);
    }
  }, []);

  // Capture sendInput from TerminalView
  const handleTerminalInput = useCallback((sendFn: (data: string) => void) => {
    sendInputRef.current = sendFn;
  }, []);

  // File upload: inject path into terminal
  const handleFileUploaded = useCallback((filePath: string) => {
    if (sendInputRef.current) {
      sendInputRef.current(filePath);
    }
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeBackend = activeSession ? getBackendDisplay(normalizeBackend(activeSession.backend)) : null;
  const isRealSession = Boolean(activeSessionId && !activeSessionId.startsWith('__new__'));
  const activeView: 'chat' | 'term' = isRealSession
    ? (viewModes[activeSessionId!] || 'term')
    : 'term';

  // No token yet → show the access gate instead of rendering the app
  // (which would otherwise fire authenticated requests with an empty token).
  if (!token) {
    return (
      <TokenGate
        onSubmit={(t) => {
          setToken(t);
          try { localStorage.setItem('cc-terminal-token', t); } catch {}
        }}
      />
    );
  }

  return (
    <div className="h-dvh flex overflow-hidden bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Session rail — phone portrait only; list + content stay on one screen */}
      <div className="md:hidden flex-shrink-0">
        <SessionRail
          sessions={sessions}
          activeSessionId={activeSessionId}
          aliveSessions={aliveSessions}
          workingSessions={new Set(Object.values(statuses).filter((s) => s.state === 'working').map((s) => s.sessionId))}
          onSelect={handleSelectSession}
          onExpand={() => setSidebarOpen(true)}
          onCreate={handleNewSession}
        />
      </div>

      {/* Sidebar overlay backdrop (mobile expanded list) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar: slide-over on phones, persistent narrow pane on md+ */}
      <div
        className={`
          fixed inset-y-0 left-0 z-50 w-[280px] transform transition-transform duration-200
          md:static md:z-auto md:w-[240px] md:flex-shrink-0 md:translate-x-0 md:transition-none
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          aliveSessions={aliveSessions}
          statuses={statuses}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onCreate={handleNewSession}
          onClose={() => setSidebarOpen(false)}
          theme={theme}
          setTheme={setTheme}
        />
      </div>

      {/* Main area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <div className="h-[calc(3rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] flex items-center px-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          {activeSessionId && (
            <button
              onClick={() => setActiveSessionId(null)}
              className="ml-1 shrink-0 flex items-center gap-1 h-9 pl-1.5 pr-3 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 hover:text-gray-900 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-900 dark:hover:text-gray-100 transition-colors"
              title="Back to home"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              <span className="text-sm font-medium">Back</span>
            </button>
          )}
          <span className="ml-2 text-sm font-medium truncate flex-1 text-gray-700 dark:text-gray-200">
            {activeSession?.title || 'CC Terminal'}
          </span>
          {isRealSession && (
            <div className="mr-2 shrink-0 flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden text-xs font-medium">
              <button
                onClick={() => setViewMode(activeSessionId!, 'chat')}
                className={`px-2.5 py-1 transition-colors ${
                  activeView === 'chat'
                    ? 'bg-blue-500 text-white'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                Chat
              </button>
              <button
                onClick={() => setViewMode(activeSessionId!, 'term')}
                className={`px-2.5 py-1 transition-colors border-l border-gray-300 dark:border-gray-600 ${
                  activeView === 'term'
                    ? 'bg-gray-700 text-white dark:bg-gray-200 dark:text-gray-900'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                Term
              </button>
            </div>
          )}
          {activeBackend && (
            <span className={`mr-2 shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${activeBackend.badgeClass}`}>
              {activeBackend.label}
            </span>
          )}
          {activeSessionId && !activeSessionId.startsWith('__new__') && token && (
            <FileUpload
              token={token}
              onFileUploaded={handleFileUploaded}
              disabled={!activeSessionId}
            />
          )}
        </div>

        {/* Chat / Terminal / Welcome */}
        <div className="flex-1 relative min-h-0">
          {activeSessionId && token ? (
            activeView === 'chat' && activeSession ? (
              <ChatView
                key={`chat-${activeSessionId}`}
                sessionId={activeSessionId}
                backend={normalizeBackend(activeSession.backend)}
                token={token}
                onRequestTerm={() => setViewMode(activeSessionId, 'term')}
              />
            ) : (
              <DropZone token={token} onFileUploaded={handleFileUploaded}>
                <TerminalView
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  createOptions={createOptions}
                  token={token}
                  theme={resolved}
                  onSessionCreated={handleSessionCreated}
                  onSessionExited={handleSessionExited}
                  onInput={handleTerminalInput}
                />
              </DropZone>
            )
          ) : (
            <HistoryHome token={token} onNewTerminal={handleNewSession} />
          )}
        </div>

        {/* Key bar (touch devices, terminal view only — chat has its own input) */}
        <TerminalKeyBar
          onInput={handleKeyBarInput}
          visible={isTouchDevice && !!activeSessionId && activeView === 'term'}
        />
      </div>
    </div>
  );
}
