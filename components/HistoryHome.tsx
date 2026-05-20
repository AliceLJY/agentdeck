'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ClaudeHistoryIndex,
  ClaudeHistoryProject,
  ClaudeHistorySession,
  ClaudeTranscript,
} from '@/lib/history-index';
import { formatTranscriptMessageBlock } from '@/lib/history-format';
import {
  getBackendDisplay,
  type HistoryBackend,
  type HistoryBackendFilter,
} from '@/lib/backends';

interface TerminalLaunchOptions {
  backend?: HistoryBackend;
  cwd?: string;
  resumeSessionId?: string;
  title?: string;
}

interface ProjectScope {
  backend: HistoryBackend;
  projectId: string;
}

interface HistoryHomeProps {
  token: string;
  onNewTerminal: (options?: TerminalLaunchOptions) => void;
}

export default function HistoryHome({ token, onNewTerminal }: HistoryHomeProps) {
  const [index, setIndex] = useState<ClaudeHistoryIndex>({ projects: [], sessions: [] });
  const [backendFilter, setBackendFilter] = useState<HistoryBackendFilter>('all');
  const [selectedProjectScope, setSelectedProjectScope] = useState<ProjectScope | null>(null);
  const [selectedSession, setSelectedSession] = useState<ClaudeHistorySession | null>(null);
  const [transcript, setTranscript] = useState<ClaudeTranscript | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadIndex = useCallback(async (
    scope: ProjectScope | null,
    filter: HistoryBackendFilter,
  ) => {
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: '25',
        backend: scope?.backend || filter,
      });
      if (scope) params.set('projectId', scope.projectId);
      const res = await fetch(`/api/history?${params.toString()}`, {
        cache: 'no-store',
        headers: { 'x-token': token },
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load history');
      const data = await res.json() as ClaudeHistoryIndex;
      setIndex(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadIndex(null, backendFilter);
  }, [backendFilter, loadIndex]);

  const loadTranscript = useCallback(async (session: ClaudeHistorySession) => {
    if (!token) return;
    setSelectedSession(session);
    setTranscript(null);
    setTranscriptLoading(true);
    try {
      const params = new URLSearchParams({
        backend: session.backend,
        projectId: session.projectId,
        sessionId: session.sessionId,
      });
      const res = await fetch(`/api/history/session?${params.toString()}`, {
        cache: 'no-store',
        headers: { 'x-token': token },
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load transcript');
      setTranscript(await res.json() as ClaudeTranscript);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transcript');
    } finally {
      setTranscriptLoading(false);
    }
  }, [token]);

  const selectProject = useCallback((project: ClaudeHistoryProject | null) => {
    const scope = project
      ? { backend: project.backend, projectId: project.id }
      : null;
    setSelectedProjectScope(scope);
    setSelectedSession(null);
    setTranscript(null);
    loadIndex(scope, scope?.backend || backendFilter);
  }, [backendFilter, loadIndex]);

  const changeBackendFilter = useCallback((next: HistoryBackendFilter) => {
    setBackendFilter(next);
    setSelectedProjectScope(null);
    setSelectedSession(null);
    setTranscript(null);
  }, []);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return index.sessions;
    return index.sessions.filter((session) =>
      `${session.backend} ${session.projectName} ${session.cwd} ${session.preview} ${session.lastMessagePreview}`
        .toLowerCase()
        .includes(needle),
    );
  }, [index.sessions, query]);

  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return index.projects;
    return index.projects.filter((project) =>
      `${project.backend} ${project.name} ${project.cwd}`.toLowerCase().includes(needle),
    );
  }, [index.projects, query]);

  const selectedProject = selectedProjectScope
    ? index.projects.find((project) =>
      project.backend === selectedProjectScope.backend
      && project.id === selectedProjectScope.projectId,
    )
    : null;
  const newTerminalBackend: HistoryBackend = backendFilter === 'codex' ? 'codex' : 'claude';

  return (
    <div className="h-full min-h-0 flex flex-col bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-3 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold tracking-normal truncate">
              CC Terminal
            </h1>
            <div className="text-sm text-gray-500 dark:text-gray-400 truncate">
              {selectedProject ? selectedProject.name : 'Projects'}
            </div>
          </div>
          <button
            onClick={() => loadIndex(selectedProjectScope, selectedProjectScope?.backend || backendFilter)}
            className="h-10 w-10 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
            title="Refresh"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M5 19A9 9 0 0119 5M19 5h-5M5 19h5" />
            </svg>
          </button>
          <button
            onClick={() => onNewTerminal({ backend: newTerminalBackend })}
            className="h-10 w-10 flex items-center justify-center rounded-lg bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-950 dark:hover:bg-gray-200"
            title="New terminal"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
        <div className="mt-4">
          <input
            suppressHydrationWarning
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            className="w-full h-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 text-sm outline-none focus:border-blue-500"
          />
        </div>
        <div className="mt-3 flex rounded-lg border border-gray-200 bg-gray-50 p-1 text-sm dark:border-gray-800 dark:bg-gray-900">
          <BackendFilterButton label="All" active={backendFilter === 'all'} onClick={() => changeBackendFilter('all')} />
          <BackendFilterButton label="CC" active={backendFilter === 'claude'} onClick={() => changeBackendFilter('claude')} />
          <BackendFilterButton label="Codex" active={backendFilter === 'codex'} onClick={() => changeBackendFilter('codex')} />
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-sm text-red-600 dark:text-red-400 border-b border-red-100 dark:border-red-950">
          {error}
        </div>
      )}

      <div className="relative flex-1 min-h-0 overflow-hidden md:grid md:grid-cols-[390px_1fr]">
        <div className="h-full min-h-0 overflow-y-auto border-r border-gray-200 dark:border-gray-800">
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <button
                onClick={() => selectProject(null)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  selectedProjectScope === null
                    ? 'bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-950 dark:border-gray-100'
                    : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'
                }`}
              >
                Recent
              </button>
              {selectedProject && (
                <button
                  onClick={() => onNewTerminal({
                    backend: selectedProject.backend,
                    cwd: selectedProject.cwd,
                    title: selectedProject.name,
                  })}
                  className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300"
                >
                  New Here
                </button>
              )}
            </div>

            <SectionLabel text={selectedProject ? 'Sessions' : 'Recent Sessions'} />
            {loading ? (
              <LoadingRows />
            ) : filteredSessions.length === 0 ? (
              <EmptyState text="No sessions" />
            ) : (
              <div className="space-y-1">
                {filteredSessions.map((session) => (
                  <SessionRow
                    key={`${session.backend}:${session.projectId}:${session.sessionId}`}
                    session={session}
                    selected={
                      selectedSession?.backend === session.backend
                      && selectedSession?.sessionId === session.sessionId
                    }
                    onSelect={() => loadTranscript(session)}
                    onResume={() => onNewTerminal({
                      backend: session.backend,
                      cwd: session.cwd,
                      resumeSessionId: session.sessionId,
                      title: session.preview,
                    })}
                  />
                ))}
              </div>
            )}

            <SectionLabel text="Projects" className="mt-5" />
            <div className="space-y-1 pb-8">
              {filteredProjects.map((project) => (
                <ProjectRow
                  key={`${project.backend}:${project.id}`}
                  project={project}
                  selected={
                    selectedProjectScope !== null
                    && selectedProjectScope.backend === project.backend
                    && selectedProjectScope.projectId === project.id
                  }
                  onSelect={() => selectProject(project)}
                  onNew={() => onNewTerminal({
                    backend: project.backend,
                    cwd: project.cwd,
                    title: project.name,
                  })}
                />
              ))}
            </div>
          </div>
        </div>

        <TranscriptPane
          session={selectedSession}
          transcript={transcript}
          loading={transcriptLoading}
          onClose={() => {
            setSelectedSession(null);
            setTranscript(null);
          }}
          onResume={(session) => onNewTerminal({
            backend: session.backend,
            cwd: session.cwd,
            resumeSessionId: session.sessionId,
            title: session.preview,
          })}
        />
      </div>
    </div>
  );
}

function SectionLabel({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`mb-2 text-xs font-semibold uppercase tracking-normal text-gray-400 dark:text-gray-500 ${className}`}>
      {text}
    </div>
  );
}

function BackendFilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md px-2 py-1.5 font-medium ${
        active
          ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100'
          : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
      }`}
    >
      {label}
    </button>
  );
}

function BackendBadge({ backend }: { backend: HistoryBackend }) {
  const display = getBackendDisplay(backend);
  return (
    <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${display.badgeClass}`}>
      {display.label}
    </span>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
  onResume,
}: {
  session: ClaudeHistorySession;
  selected: boolean;
  onSelect: () => void;
  onResume: () => void;
}) {
  const display = getBackendDisplay(session.backend);
  return (
    <div
      className={`group flex items-start gap-2 rounded-lg border border-l-4 px-3 py-2 ${
        selected
          ? display.selectedClass
          : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-900'
      } ${display.accentClass}`}
    >
      <button onClick={onSelect} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{session.preview}</span>
          <BackendBadge backend={session.backend} />
          <span className="ml-auto shrink-0 text-xs text-gray-400">{formatRelative(session.updatedAt)}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span className="truncate">{session.projectName}</span>
          <span className="shrink-0">{session.messageCount}</span>
        </div>
      </button>
      <button
        onClick={onResume}
        className="mt-0.5 h-8 w-8 shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-white dark:hover:bg-gray-800 dark:hover:text-gray-100"
        title="Resume in terminal"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5l8 7-8 7V5z" />
        </svg>
      </button>
    </div>
  );
}

function ProjectRow({
  project,
  selected,
  onSelect,
  onNew,
}: {
  project: ClaudeHistoryProject;
  selected: boolean;
  onSelect: () => void;
  onNew: () => void;
}) {
  const display = getBackendDisplay(project.backend);
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-l-4 px-3 py-2 ${
        selected
          ? display.selectedClass
          : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-900'
      } ${display.accentClass}`}
    >
      <button onClick={onSelect} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h6l2 2h10v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
          </svg>
          <span className="text-sm font-medium truncate">{project.name}</span>
          <BackendBadge backend={project.backend} />
          <span className="ml-auto shrink-0 text-xs text-gray-400">{formatRelative(project.updatedAt)}</span>
        </div>
        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 truncate">
          {project.sessionCount} sessions
        </div>
      </button>
      <button
        onClick={onNew}
        className="h-8 w-8 shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-white dark:hover:bg-gray-800 dark:hover:text-gray-100"
        title="New terminal here"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
        </svg>
      </button>
    </div>
  );
}

function TranscriptPane({
  session,
  transcript,
  loading,
  onClose,
  onResume,
}: {
  session: ClaudeHistorySession | null;
  transcript: ClaudeTranscript | null;
  loading: boolean;
  onClose: () => void;
  onResume: (session: ClaudeHistorySession) => void;
}) {
  if (!session) {
    return (
      <div className="hidden md:flex h-full items-center justify-center text-sm text-gray-400">
        Select a session
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-20 h-full min-h-0 flex flex-col bg-white dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800 md:relative md:inset-auto md:z-auto md:border-t-0">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center gap-3">
        <button
          onClick={onClose}
          className="h-9 w-9 shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-50 dark:hover:bg-gray-900 dark:hover:text-gray-100 md:hidden"
          title="Back"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium truncate">{session.preview}</div>
            <BackendBadge backend={session.backend} />
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{session.cwd}</div>
        </div>
        <button
          onClick={() => onResume(session)}
          className="shrink-0 px-3 py-2 rounded-lg bg-gray-900 text-white text-sm dark:bg-gray-100 dark:text-gray-950"
        >
          Resume
        </button>
      </div>
      <div className="flex-1 min-h-[280px] overflow-y-auto px-4 py-3">
        {loading ? (
          <LoadingRows />
        ) : transcript ? (
          <div className="space-y-3 pb-8">
            {transcript.messages.map((message) => (
              <pre
                key={message.id}
                className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[13px] leading-relaxed text-gray-800 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100"
              >
                {formatTranscriptMessageBlock(message)}
              </pre>
            ))}
          </div>
        ) : (
          <EmptyState text="No transcript" />
        )}
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-14 rounded-lg bg-gray-100 dark:bg-gray-900 animate-pulse" />
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-800 px-4 py-8 text-center text-sm text-gray-400">
      {text}
    </div>
  );
}

function formatRelative(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const diff = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'now';
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
  return new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(new Date(time));
}
