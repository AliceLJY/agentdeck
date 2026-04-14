'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import Sidebar from '@/components/Sidebar';
import WelcomeScreen from '@/components/WelcomeScreen';
import TerminalKeyBar from '@/components/TerminalKeyBar';
import { useTheme } from '@/hooks/useTheme';
import { useTerminalSessions } from '@/hooks/useTerminalSessions';
import type { SessionInfo, ServerMessage, TerminalSessionMeta } from '@/lib/types';
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

  // Ref to the TerminalView's sendInput function
  const sendInputRef = useRef<((data: string) => void) | null>(null);

  // Read token from meta tag on mount
  useEffect(() => {
    const meta = document.querySelector('meta[name="ws-token"]');
    if (meta) {
      setToken(meta.getAttribute('content') || '');
    }
  }, []);

  // Detect touch device
  useEffect(() => {
    setIsTouchDevice(navigator.maxTouchPoints > 0);
  }, []);

  // Reconcile sessions with server on mount
  useEffect(() => {
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
          sessions.forEach((s) => {
            if (!serverIds.has(s.id)) {
              remove(s.id);
            }
          });
        }
      } catch {
        // Ignore parse errors
      }
      ws.close();
    };

    ws.onerror = () => {
      ws.close();
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
    // Only run on mount when token becomes available
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Session lifecycle handlers ──

  // Use '__new__' as a signal to TerminalView to create (not attach)
  const handleNewSession = useCallback(() => {
    setActiveSessionId('__new__');
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
    async (id: string, title: string) => {
      // Server created the session — now save to IDB with server's real ID
      const now = Date.now();
      const meta: TerminalSessionMeta = {
        id,
        title: title || new Date(now).toLocaleString([], {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }),
        createdAt: now,
        lastSeen: now,
      };
      await saveSession(meta);
      await refresh();
      setActiveSessionId(id);
      setAliveSessions((prev) => new Set(prev).add(id));
    },
    [refresh, setActiveSessionId],
  );

  const handleSessionExited = useCallback((id: string) => {
    setAliveSessions((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

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

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="h-dvh flex overflow-hidden bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Sidebar overlay backdrop (mobile) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          fixed inset-y-0 left-0 z-50 w-[280px] transform transition-transform duration-200
          lg:relative lg:translate-x-0 lg:z-0
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
            className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors lg:hidden"
          >
            <svg className="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="ml-2 lg:ml-0 text-sm font-medium truncate text-gray-700 dark:text-gray-200">
            {activeSession?.title || 'CC Terminal'}
          </span>
        </div>

        {/* Terminal or Welcome */}
        <div className="flex-1 relative min-h-0">
          {activeSessionId && token ? (
            <TerminalView
              sessionId={activeSessionId}
              token={token}
              theme={resolved}
              onSessionCreated={handleSessionCreated}
              onSessionExited={handleSessionExited}
              onInput={handleTerminalInput}
            />
          ) : (
            <WelcomeScreen onNewSession={handleNewSession} />
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
