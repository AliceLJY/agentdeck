'use client';

import { useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { normalizeBackend } from '@/lib/backends';
import type { TerminalSessionMeta } from '@/lib/types';
import {
  saveSession,
  listSessions,
  deleteSession as idbDeleteSession,
  updateSessionTitle,
} from '@/lib/db';

export function useTerminalSessions() {
  const [sessions, setSessions] = useState<TerminalSessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Load sessions from IndexedDB on mount
  const refresh = useCallback(async () => {
    try {
      const all = await listSessions();
      setSessions(all.map((session) => ({
        ...session,
        backend: normalizeBackend(session.backend),
      })));
    } catch (err) {
      console.error('[cc-terminal] Failed to load sessions from IDB:', err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Create a new session
  const create = useCallback(async (): Promise<string> => {
    const id = uuidv4();
    const now = Date.now();
    const meta: TerminalSessionMeta = {
      id,
      backend: 'claude',
      title: new Date(now).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      createdAt: now,
      lastSeen: now,
    };

    await saveSession(meta);
    setSessions((prev) => [meta, ...prev]);
    setActiveSessionId(id);
    return id;
  }, []);

  // Remove a session
  const remove = useCallback(
    async (id: string) => {
      await idbDeleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
      }
    },
    [activeSessionId],
  );

  // Select (switch to) a session
  const select = useCallback((id: string) => {
    setActiveSessionId(id);
    // Update lastSeen in IDB (fire and forget)
    listSessions().then((all) => {
      const session = all.find((s) => s.id === id);
      if (session) {
        saveSession({ ...session, lastSeen: Date.now() });
      }
    });
  }, []);

  // Update a session's title
  const updateTitle = useCallback(async (id: string, title: string) => {
    await updateSessionTitle(id, title);
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title } : s)),
    );
  }, []);

  return {
    sessions,
    activeSessionId,
    create,
    remove,
    select,
    updateTitle,
    refresh,
    setActiveSessionId,
  };
}
