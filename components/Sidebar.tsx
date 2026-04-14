'use client';

import type { TerminalSessionMeta } from '@/lib/types';
import SessionItem from './SessionItem';
import ThemeToggle from './ThemeToggle';

type Theme = 'light' | 'dark' | 'system';

interface SidebarProps {
  sessions: TerminalSessionMeta[];
  activeSessionId: string | null;
  aliveSessions: Set<string>;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onClose?: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  aliveSessions,
  onSelect,
  onDelete,
  onCreate,
  onClose,
  theme,
  setTheme,
}: SidebarProps) {
  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex-1">
          CC Terminal
        </h1>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 lg:hidden"
          >
            <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* New Terminal button */}
      <div className="px-3 pb-2">
        <button
          onClick={onCreate}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl
            border-2 border-dashed border-gray-300 dark:border-gray-600
            text-gray-600 dark:text-gray-300
            hover:bg-gray-100 dark:hover:bg-gray-800
            hover:border-blue-400 dark:hover:border-blue-500
            transition-colors text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Terminal
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            No sessions yet
          </div>
        ) : (
          sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              isAlive={aliveSessions.has(session.id)}
              onSelect={() => onSelect(session.id)}
              onDelete={() => onDelete(session.id)}
            />
          ))
        )}
      </div>

      {/* Theme toggle at bottom */}
      <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <ThemeToggle theme={theme} setTheme={setTheme} />
      </div>
    </div>
  );
}
