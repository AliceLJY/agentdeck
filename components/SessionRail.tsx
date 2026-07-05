'use client';

import type { TerminalSessionMeta } from '@/lib/types';
import { getBackendDisplay, normalizeBackend } from '@/lib/backends';

interface SessionRailProps {
  sessions: TerminalSessionMeta[];
  activeSessionId: string | null;
  aliveSessions: Set<string>;
  workingSessions?: Set<string>;
  onSelect: (id: string) => void;
  onExpand: () => void;
  onCreate: () => void;
}

/**
 * Narrow always-visible session strip for phone portrait — the "half-width,
 * then halved again" answer to a full session pane that would eat a small
 * screen. One circle per session (backend color + first letter), a green
 * dot for running, pulsing while the agent is actively working. The expand
 * button opens the full sidebar overlay.
 */
export default function SessionRail({
  sessions,
  activeSessionId,
  aliveSessions,
  workingSessions,
  onSelect,
  onExpand,
  onCreate,
}: SessionRailProps) {
  return (
    <div className="h-full w-12 flex flex-col items-center border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      {/* Expand full list */}
      <button
        onClick={onExpand}
        className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        title="All sessions"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Session circles */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-2 py-2 w-full">
        {sessions.map((session) => {
          const backend = normalizeBackend(session.backend);
          const display = getBackendDisplay(backend);
          const isActive = session.id === activeSessionId;
          const isAlive = aliveSessions.has(session.id);
          const isWorking = workingSessions?.has(session.id) ?? false;
          const initial = (session.title || display.label).trim().charAt(0).toUpperCase() || '?';

          return (
            <button
              key={session.id}
              onClick={() => onSelect(session.id)}
              title={session.title}
              className={`relative shrink-0 w-9 h-9 rounded-full border text-sm font-semibold transition-all
                flex items-center justify-center
                ${backend === 'codex'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300'
                  : 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300'}
                ${isActive ? 'ring-2 ring-offset-1 ring-blue-400 dark:ring-blue-500 dark:ring-offset-gray-900' : 'opacity-80 hover:opacity-100'}`}
            >
              {initial}
              {isAlive && (
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-gray-50 dark:border-gray-900 bg-green-500 ${
                    isWorking ? 'animate-pulse' : ''
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* New session */}
      <button
        onClick={onCreate}
        className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        title="New session"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  );
}
