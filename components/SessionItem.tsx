'use client';

import type { TerminalSessionMeta } from '@/lib/types';
import { getBackendDisplay, normalizeBackend } from '@/lib/backends';

interface SessionItemProps {
  session: TerminalSessionMeta;
  isActive: boolean;
  isAlive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function SessionItem({
  session,
  isActive,
  isAlive,
  onSelect,
  onDelete,
}: SessionItemProps) {
  const backend = normalizeBackend(session.backend);
  const display = getBackendDisplay(backend);

  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-2 px-3 py-3 cursor-pointer rounded-lg mx-2 mb-0.5
        transition-colors relative border-l-4
        ${
          isActive
            ? display.selectedClass
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 border-transparent'
        } ${display.accentClass}`}
    >
      {/* Status dot */}
      <div
        className={`w-2 h-2 rounded-full flex-shrink-0 ${
          isAlive
            ? 'bg-green-500'
            : 'bg-gray-400 dark:bg-gray-600'
        }`}
        title={isAlive ? 'Running' : 'Exited'}
      />

      {/* Session info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium truncate text-gray-800 dark:text-gray-200">
            {session.title}
          </div>
          <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${display.badgeClass}`}>
            {display.label}
          </span>
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {formatRelativeTime(session.lastSeen)}
        </div>
      </div>

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className={`${
          isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        } p-1.5 rounded hover:bg-red-100
          dark:hover:bg-red-900/30 text-gray-400 hover:text-red-500 transition-all flex-shrink-0`}
        title="Delete session"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
