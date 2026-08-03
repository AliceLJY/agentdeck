'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ClaudeHistoryIndex, ClaudeHistorySession } from '@/lib/history-index';
import { formatRelative } from '@/lib/history-format';
import { getBackendDisplay } from '@/lib/backends';
import { deviceApiHeaders } from '@/lib/device-client';
import type { TerminalCreateOptions } from '@/lib/types';

/** Deliberately short: the sidebar is for jumping back to something recent.
 *  Searching and filtering live on the home screen, which has the width. */
const LIMIT = 20;

interface SidebarHistoryProps {
  token: string;
  /** Transcript ids a live session is currently writing — those rows resume
   *  into the running session instead of forking a new one. */
  liveTranscriptIds: Set<string>;
  /** Bumped by the parent to force a reload (sidebar opened, session died). */
  refreshKey?: number;
  onResume: (options: TerminalCreateOptions) => void;
}

export default function SidebarHistory({
  token,
  liveTranscriptIds,
  refreshKey,
  onResume,
}: SidebarHistoryProps) {
  const [sessions, setSessions] = useState<ClaudeHistorySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const res = await fetch(`/api/history?limit=${LIMIT}&backend=all`, {
        cache: 'no-store',
        headers: deviceApiHeaders(token),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load history');
      const data = await res.json() as ClaudeHistoryIndex;
      setSessions(data.sessions.slice(0, LIMIT));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Coming back to the tab after a while: the list is stale by definition.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  if (loading && sessions.length === 0) {
    return <div className="px-4 py-6 text-center text-xs text-gray-400 dark:text-gray-500">Loading…</div>;
  }

  if (error) {
    return (
      <div className="px-3 py-4 text-xs text-gray-500 dark:text-gray-400">
        <div className="text-red-500 dark:text-red-400">{error}</div>
        <button onClick={load} className="mt-2 underline hover:text-gray-700 dark:hover:text-gray-200">
          Retry
        </button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return <div className="px-4 py-6 text-center text-xs text-gray-400 dark:text-gray-500">No history yet</div>;
  }

  return (
    <div className="px-2 pb-2">
      {sessions.map((session) => {
        const display = getBackendDisplay(session.backend);
        const isLive = liveTranscriptIds.has(session.sessionId);

        return (
          <button
            key={`${session.backend}:${session.sessionId}`}
            onClick={() => onResume({
              backend: session.backend,
              cwd: session.cwd,
              resumeSessionId: session.sessionId,
              title: session.preview,
            })}
            title={session.preview}
            className={`w-full text-left rounded-lg border-l-4 px-2.5 py-2 mb-0.5
              hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${display.accentClass}`}
          >
            <div className="flex items-center gap-1.5">
              {isLive && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0 bg-green-500"
                  title="Running now"
                />
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-gray-800 dark:text-gray-200">
                {session.preview || session.title}
              </span>
              <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                {formatRelative(session.updatedAt)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              <span className={`shrink-0 rounded border px-1 leading-none py-px ${display.badgeClass}`}>
                {display.label}
              </span>
              <span className="truncate">{session.projectName}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
