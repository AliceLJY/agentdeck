'use client';

import { useEffect, useRef } from 'react';
import type { SessionStatus, TerminalSessionMeta } from '@/lib/types';
import { getBackendDisplay, normalizeBackend } from '@/lib/backends';

interface SessionTabsProps {
  sessions: TerminalSessionMeta[];
  activeSessionId: string | null;
  aliveSessions: Set<string>;
  statuses?: Record<string, SessionStatus>;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onOpenSidebar: () => void;
}

/**
 * Browser-style tab strip across the top — one tab per live session so a
 * parallel CC + Codex pair is visible at a glance without opening a list.
 * Replaces the phone-portrait SessionRail: a full-width row of titled tabs
 * says far more than a 48px column of initials, and gives the width back to
 * the terminal.
 *
 * Close (×) only renders on the active tab: on touch there is no hover to
 * hide it behind, and a kill is destructive enough to deserve two taps.
 */
export default function SessionTabs({
  sessions,
  activeSessionId,
  aliveSessions,
  statuses,
  onSelect,
  onDelete,
  onCreate,
  onOpenSidebar,
}: SessionTabsProps) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Keep the current tab in view when it is switched from elsewhere
  // (sidebar, history home, or a session created on another device).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeSessionId]);

  // A session being spawned has no server ID yet — show a placeholder so the
  // strip doesn't look empty during the launch.
  const isStarting = Boolean(activeSessionId?.startsWith('__new__'));

  return (
    <div className="flex items-stretch h-[calc(2.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
      {/* Sidebar opener — phones only; md+ has the persistent pane */}
      <button
        onClick={onOpenSidebar}
        className="md:hidden shrink-0 px-2.5 flex items-center text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800 border-r border-gray-200 dark:border-gray-700 transition-colors"
        title="All sessions"
        aria-label="All sessions"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Tabs */}
      <div className="flex-1 min-w-0 flex items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sessions.map((session) => {
          const backend = normalizeBackend(session.backend);
          const display = getBackendDisplay(backend);
          const isActive = session.id === activeSessionId;
          const isAlive = aliveSessions.has(session.id);
          const status = statuses?.[session.id];
          const isWorking = isAlive && status?.state === 'working';
          const title = status?.aiTitle || session.title;

          return (
            <div
              key={session.id}
              ref={isActive ? activeRef : null}
              onClick={() => onSelect(session.id)}
              title={title}
              className={`group shrink-0 min-w-[128px] max-w-[190px] flex items-center gap-1.5 px-2.5
                cursor-pointer border-r border-gray-200 dark:border-gray-700
                border-b-2 transition-colors
                ${
                  isActive
                    ? `bg-white dark:bg-gray-950 ${display.accentClass}`
                    : 'border-b-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
            >
              {/* Alive / working dot */}
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  isAlive
                    ? `bg-green-500 ${isWorking ? 'animate-pulse' : ''}`
                    : 'bg-gray-400 dark:bg-gray-600'
                }`}
                title={isAlive ? (isWorking ? 'Working' : 'Running') : 'Exited'}
              />

              {/* Backend badge — the whole point of the strip is telling
                  a parallel CC and Codex apart without tapping either. */}
              <span
                className={`shrink-0 rounded border px-1 py-px text-[10px] font-medium leading-none ${display.badgeClass}`}
              >
                {display.label}
              </span>

              <span
                className={`flex-1 min-w-0 truncate text-xs ${
                  isActive ? 'font-medium text-gray-800 dark:text-gray-100' : ''
                }`}
              >
                {title}
              </span>

              {isActive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                  className="shrink-0 p-0.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                  title="Close session"
                  aria-label="Close session"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}

        {isStarting && (
          <div className="shrink-0 min-w-[128px] flex items-center gap-1.5 px-2.5 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950">
            <span className="w-2 h-2 rounded-full shrink-0 bg-gray-400 dark:bg-gray-600 animate-pulse" />
            <span className="text-xs text-gray-500 dark:text-gray-400">Starting…</span>
          </div>
        )}
      </div>

      {/* New session — pinned so it stays reachable with many tabs open */}
      <button
        onClick={onCreate}
        className="shrink-0 px-3 flex items-center text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800 border-l border-gray-200 dark:border-gray-700 transition-colors"
        title="New session"
        aria-label="New session"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  );
}
