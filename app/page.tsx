'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import Sidebar from '@/components/Sidebar';
import HistoryHome from '@/components/HistoryHome';
import TokenGate from '@/components/TokenGate';
import TerminalKeyBar from '@/components/TerminalKeyBar';
import FileUpload from '@/components/FileUpload';
import DropZone from '@/components/DropZone';
import { useTheme } from '@/hooks/useTheme';
import { useTerminalSessions } from '@/hooks/useTerminalSessions';
import { getBackendDisplay, normalizeBackend, type HistoryBackend } from '@/lib/backends';
import type {
  SessionInfo,
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

  // Reconcile client IDB with server sessions (removes stale entries after restart)
  const reconcileRef = useRef<(() => void) | null>(null);
  reconcileRef.current = () => {
    if (!token) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${location.host}/ws/terminal?token=${encodeURIComponent(token)}`,
    );

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'list' }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === 'sessions') {
          const serverIds = new Set(msg.list.map((s: SessionInfo) => s.id));
          const alive = new Set(
            msg.list.filter((s: SessionInfo) => s.alive).map((s: SessionInfo) => s.id),
          );
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
        }
      } catch {
        // Ignore parse errors
      }
      ws.close();
    };

    ws.onerror = () => {
      ws.close();
    };
  };

  // Run reconciliation on mount
  useEffect(() => {
    reconcileRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Also reconcile when user returns to tab (catches server restart while away)
  useEffect(() => {
    const onFocus = () => reconcileRef.current?.();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

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
      {/* Sidebar overlay backdrop (mobile) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          fixed inset-y-0 left-0 z-50 w-[280px] transform transition-transform duration-200
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          aliveSessions={aliveSessions}
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
        <div className="h-12 flex items-center px-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            title="Live terminals"
          >
            <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <button
            onClick={() => setActiveSessionId(null)}
            className="ml-1 p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            title="Projects"
          >
            <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h6l2 2h10v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
          </button>
          <span className="ml-2 text-sm font-medium truncate flex-1 text-gray-700 dark:text-gray-200">
            {activeSession?.title || 'CC Terminal'}
          </span>
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

        {/* Terminal or Welcome */}
        <div className="flex-1 relative min-h-0">
          {activeSessionId && token ? (
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
          ) : (
            <HistoryHome token={token} onNewTerminal={handleNewSession} />
          )}
        </div>

        {/* Key bar (touch devices only) */}
        <TerminalKeyBar
          onInput={handleKeyBarInput}
          visible={isTouchDevice && !!activeSessionId}
        />
      </div>
    </div>
  );
}
