import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import type { HistoryBackend, HistoryBackendFilter } from './backends';

export interface ClaudeHistorySession {
  backend: HistoryBackend;
  projectId: string;
  projectName: string;
  cwd: string;
  sessionId: string;
  title: string;
  preview: string;
  lastMessagePreview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClaudeHistoryProject {
  backend: HistoryBackend;
  id: string;
  name: string;
  cwd: string;
  sessionCount: number;
  updatedAt: string;
}

export interface ClaudeTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface ClaudeTranscript {
  session: ClaudeHistorySession;
  messages: ClaudeTranscriptMessage[];
}

export interface ClaudeHistoryIndex {
  projects: ClaudeHistoryProject[];
  sessions: ClaudeHistorySession[];
}

interface BuildOptions {
  rootDir?: string;
  limit?: number;
  projectId?: string;
}

interface CodexBuildOptions {
  sessionsRootDir?: string;
  indexFile?: string;
  limit?: number;
  projectId?: string;
}

interface CombinedBuildOptions {
  backend?: HistoryBackendFilter;
  limit?: number;
  projectId?: string;
  claudeRootDir?: string;
  codexSessionsRootDir?: string;
  codexIndexFile?: string;
}

interface SessionCandidate {
  projectId: string;
  projectDir: string;
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}

interface CodexSessionCandidate {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}

interface ProjectAccumulator {
  backend: HistoryBackend;
  id: string;
  name: string;
  cwd: string;
  sessionCount: number;
  updatedAtMs: number;
}

interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

interface CodexIndexEntry {
  id: string;
  title: string;
  updatedAt: string;
}

const DEFAULT_LIMIT = 25;
const CODEX_SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function claudeProjectsRoot(): string {
  return path.join(process.env.HOME || '', '.claude', 'projects');
}

export function codexSessionsRoot(): string {
  return path.join(process.env.HOME || '', '.codex', 'sessions');
}

export function codexSessionIndexPath(): string {
  return path.join(process.env.HOME || '', '.codex', 'session_index.jsonl');
}

export async function buildHistoryIndex(
  options: CombinedBuildOptions = {},
): Promise<ClaudeHistoryIndex> {
  const backend = options.backend || 'all';
  if (backend === 'claude') {
    return buildClaudeHistoryIndex({
      rootDir: options.claudeRootDir,
      limit: options.limit,
      projectId: options.projectId,
    });
  }
  if (backend === 'codex') {
    return buildCodexHistoryIndex({
      sessionsRootDir: options.codexSessionsRootDir,
      indexFile: options.codexIndexFile,
      limit: options.limit,
      projectId: options.projectId,
    });
  }

  const limit = clampLimit(options.limit);
  const [claude, codex] = await Promise.all([
    buildClaudeHistoryIndex({
      rootDir: options.claudeRootDir,
      limit,
      projectId: options.projectId,
    }),
    buildCodexHistoryIndex({
      sessionsRootDir: options.codexSessionsRootDir,
      indexFile: options.codexIndexFile,
      limit,
      projectId: options.projectId,
    }),
  ]);

  return {
    projects: [...claude.projects, ...codex.projects]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    sessions: [...claude.sessions, ...codex.sessions]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit),
  };
}

export async function buildClaudeHistoryIndex(
  options: BuildOptions = {},
): Promise<ClaudeHistoryIndex> {
  const rootDir = options.rootDir || claudeProjectsRoot();
  const limit = clampLimit(options.limit);
  const candidates = await listSessionCandidates(rootDir);
  const projects = new Map<string, ProjectAccumulator>();
  const latestByProject = new Map<string, SessionCandidate>();

  for (const candidate of candidates) {
    const project = projects.get(candidate.projectId) || {
      backend: 'claude' as const,
      id: candidate.projectId,
      name: fallbackProjectName(candidate.projectId),
      cwd: fallbackCwd(candidate.projectId),
      sessionCount: 0,
      updatedAtMs: 0,
    };
    project.sessionCount += 1;
    project.updatedAtMs = Math.max(project.updatedAtMs, candidate.mtimeMs);
    projects.set(candidate.projectId, project);

    const latest = latestByProject.get(candidate.projectId);
    if (!latest || candidate.mtimeMs > latest.mtimeMs) {
      latestByProject.set(candidate.projectId, candidate);
    }
  }

  const scopedCandidates = options.projectId
    ? candidates.filter((candidate) => candidate.projectId === options.projectId)
    : candidates;

  scopedCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: ClaudeHistorySession[] = [];
  for (const candidate of scopedCandidates.slice(0, limit)) {
    const session = await parseSessionFile(candidate);
    sessions.push(session);

    const project = projects.get(session.projectId);
    if (project) {
      project.name = session.projectName;
      project.cwd = session.cwd;
      project.updatedAtMs = Math.max(project.updatedAtMs, Date.parse(session.updatedAt) || 0);
    }
  }

  for (const project of projects.values()) {
    if (project.cwd !== fallbackCwd(project.id)) continue;
    const latest = latestByProject.get(project.id);
    if (!latest) continue;
    const cwd = await readCwdFromFile(latest.filePath);
    if (!cwd) continue;
    project.cwd = cwd;
    project.name = projectNameFromCwd(cwd, project.id);
  }

  const projectList = Array.from(projects.values())
    .map((project) => ({
      id: project.id,
      backend: project.backend,
      name: project.name,
      cwd: project.cwd,
      sessionCount: project.sessionCount,
      updatedAt: new Date(project.updatedAtMs || Date.now()).toISOString(),
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return {
    projects: projectList,
    sessions,
  };
}

export async function readClaudeTranscript(options: {
  rootDir?: string;
  projectId: string;
  sessionId: string;
}): Promise<ClaudeTranscript> {
  assertSafeSegment(options.projectId, 'projectId');
  assertSafeSegment(options.sessionId, 'sessionId');

  const rootDir = options.rootDir || claudeProjectsRoot();
  const projectDir = path.join(rootDir, options.projectId);
  const filePath = path.join(projectDir, `${options.sessionId}.jsonl`);
  const fileStat = await stat(filePath);
  const candidate = {
    projectId: options.projectId,
    projectDir,
    sessionId: options.sessionId,
    filePath,
    mtimeMs: fileStat.mtimeMs,
  };
  const { session, messages } = await parseSessionWithMessages(candidate);

  return { session, messages };
}

export async function buildCodexHistoryIndex(
  options: CodexBuildOptions = {},
): Promise<ClaudeHistoryIndex> {
  const sessionsRootDir = options.sessionsRootDir || codexSessionsRoot();
  const indexFile = options.indexFile || codexSessionIndexPath();
  const limit = clampLimit(options.limit);
  const candidates = await listCodexSessionCandidates(sessionsRootDir);
  const indexEntries = await readCodexSessionIndex(indexFile);

  // Deduplicate by sessionId (a session can span multiple rollout files),
  // keeping the most recently modified file. Only the file HEAD is read here,
  // so this stays cheap even with thousands of multi-MB transcripts.
  const headBySession = new Map<
    string,
    { candidate: CodexSessionCandidate; cwd: string; createdAt: string }
  >();
  for (const candidate of candidates) {
    const head = await readCodexSessionHead(candidate.filePath);
    const sessionId = head.sessionId || candidate.sessionId;
    const existing = headBySession.get(sessionId);
    if (!existing || candidate.mtimeMs > existing.candidate.mtimeMs) {
      headBySession.set(sessionId, { candidate, cwd: head.cwd, createdAt: head.createdAt });
    }
  }

  // Build the FULL project list from lightweight metadata (every session counts).
  const projects = new Map<string, ProjectAccumulator>();
  const ranked: Array<{
    candidate: CodexSessionCandidate;
    projectId: string;
    updatedAtMs: number;
  }> = [];
  for (const [sessionId, info] of headBySession) {
    const cwd = info.cwd || fallbackCwd(sessionId);
    const projectId = projectIdFromCwd(cwd);
    const indexEntry = indexEntries.get(sessionId) || indexEntries.get(info.candidate.sessionId);
    const indexUpdatedMs = indexEntry?.updatedAt ? Date.parse(indexEntry.updatedAt) : NaN;
    // session_index.updated_at can lag behind the actual transcript; take the
    // most recent of (index time, file mtime) so a stale index entry can't bump
    // a recently-active session out of the limited window selected below.
    const updatedAtMs = Number.isFinite(indexUpdatedMs)
      ? Math.max(indexUpdatedMs, info.candidate.mtimeMs)
      : info.candidate.mtimeMs;

    const project = projects.get(projectId) || {
      backend: 'codex' as const,
      id: projectId,
      name: projectNameFromCwd(cwd, projectId),
      cwd,
      sessionCount: 0,
      updatedAtMs: 0,
    };
    project.sessionCount += 1;
    project.name = projectNameFromCwd(cwd, projectId);
    project.cwd = cwd;
    project.updatedAtMs = Math.max(project.updatedAtMs, updatedAtMs);
    projects.set(projectId, project);

    ranked.push({ candidate: info.candidate, projectId, updatedAtMs });
  }

  // Only the most-recent N sessions actually shown get a full parse (the
  // expensive step), scoped to a project when requested. limit now bounds cost.
  const scoped = ranked
    .filter((item) => !options.projectId || item.projectId === options.projectId)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, limit);

  const sessions: ClaudeHistorySession[] = [];
  for (const item of scoped) {
    const { session } = await parseCodexSessionWithMessages(item.candidate, indexEntries);
    sessions.push(session);
  }
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return {
    projects: Array.from(projects.values())
      .map((project) => ({
        backend: project.backend,
        id: project.id,
        name: project.name,
        cwd: project.cwd,
        sessionCount: project.sessionCount,
        updatedAt: new Date(project.updatedAtMs || Date.now()).toISOString(),
      }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    sessions,
  };
}

export async function readCodexTranscript(options: {
  sessionsRootDir?: string;
  projectId: string;
  sessionId: string;
}): Promise<ClaudeTranscript> {
  assertSafeSegment(options.projectId, 'projectId');
  assertSafeSegment(options.sessionId, 'sessionId');

  const sessionsRootDir = options.sessionsRootDir || codexSessionsRoot();
  const candidates = await listCodexSessionCandidates(sessionsRootDir);
  const directCandidates = candidates.filter((candidate) => candidate.sessionId === options.sessionId);
  const scanCandidates = directCandidates.length > 0 ? directCandidates : candidates;

  for (const candidate of scanCandidates) {
    const parsed = await parseCodexSessionWithMessages(candidate, new Map());
    if (
      parsed.session.sessionId === options.sessionId
      && parsed.session.projectId === options.projectId
    ) {
      return parsed;
    }
  }

  throw new Error('Codex session not found');
}

async function listSessionCandidates(rootDir: string): Promise<SessionCandidate[]> {
  if (!existsSync(rootDir)) return [];

  const projectEntries = await readdir(rootDir, { withFileTypes: true });
  const candidates: SessionCandidate[] = [];

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectId = projectEntry.name;
    const projectDir = path.join(rootDir, projectId);
    let sessionEntries;
    try {
      sessionEntries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isFile() || !sessionEntry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, sessionEntry.name);
      try {
        const fileStat = await stat(filePath);
        candidates.push({
          projectId,
          projectDir,
          sessionId: path.basename(sessionEntry.name, '.jsonl'),
          filePath,
          mtimeMs: fileStat.mtimeMs,
        });
      } catch {
        // Ignore files that disappear while Claude Code is rotating history.
      }
    }
  }

  return candidates;
}

async function listCodexSessionCandidates(rootDir: string): Promise<CodexSessionCandidate[]> {
  if (!existsSync(rootDir)) return [];

  const candidates: CodexSessionCandidate[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      try {
        const fileStat = await stat(fullPath);
        candidates.push({
          sessionId: sessionIdFromCodexFileName(entry.name),
          filePath: fullPath,
          mtimeMs: fileStat.mtimeMs,
        });
      } catch {
        // Ignore files that disappear while Codex is writing history.
      }
    }
  }

  await walk(rootDir);
  return candidates;
}

// Cheap metadata read: a Codex session's `session_meta` is the first JSONL line,
// so we only need the file head (cwd / id / timestamp) to build the project list
// and pick which sessions to fully parse — reading multi-MB transcripts in full
// just to learn cwd is what made the codex/all index O(all sessions) and slow.
export async function readCodexSessionHead(
  filePath: string,
): Promise<{ sessionId: string; cwd: string; createdAt: string }> {
  const result = { sessionId: '', cwd: '', createdAt: '' };
  let buf = '';
  try {
    const stream = createReadStream(filePath, { encoding: 'utf8', start: 0, end: 32 * 1024 });
    for await (const chunk of stream) {
      buf += chunk;
    }
  } catch {
    return result;
  }

  for (const line of buf.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // skip the partial last line cut off by the 32KB window
    }
    if (event.type === 'session_meta' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.id === 'string') result.sessionId = payload.id;
      if (typeof payload.cwd === 'string') result.cwd = payload.cwd;
      if (typeof payload.timestamp === 'string') result.createdAt = payload.timestamp;
      return result;
    }
  }
  return result;
}

async function readCodexSessionIndex(indexFile: string): Promise<Map<string, CodexIndexEntry>> {
  const entries = new Map<string, CodexIndexEntry>();
  if (!existsSync(indexFile)) return entries;

  let raw = '';
  try {
    raw = await readFile(indexFile, 'utf8');
  } catch {
    return entries;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof event.id !== 'string' || !event.id) continue;
      entries.set(event.id, {
        id: event.id,
        title: typeof event.thread_name === 'string' ? event.thread_name : '',
        updatedAt: typeof event.updated_at === 'string' ? event.updated_at : '',
      });
    } catch {
      // Keep scanning; Codex can leave partially written JSONL lines.
    }
  }

  return entries;
}

async function parseSessionFile(candidate: SessionCandidate): Promise<ClaudeHistorySession> {
  const { session } = await parseSessionWithMessages(candidate);
  return session;
}

async function readCwdFromFile(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (typeof event.cwd === 'string' && event.cwd) return event.cwd;
      } catch {
        // Keep scanning; Claude JSONL can contain partially written lines.
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function parseSessionWithMessages(candidate: SessionCandidate): Promise<{
  session: ClaudeHistorySession;
  messages: ClaudeTranscriptMessage[];
}> {
  const raw = await readFile(candidate.filePath, 'utf8');
  const messages: ParsedMessage[] = [];
  let cwd = '';
  let sessionId = candidate.sessionId;
  let createdAt = '';
  let updatedAt = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (typeof event.cwd === 'string' && event.cwd) cwd = event.cwd;
    if (typeof event.sessionId === 'string' && event.sessionId) sessionId = event.sessionId;

    const timestamp = typeof event.timestamp === 'string'
      ? event.timestamp
      : new Date(candidate.mtimeMs).toISOString();

    if (!createdAt || Date.parse(timestamp) < Date.parse(createdAt)) createdAt = timestamp;
    if (!updatedAt || Date.parse(timestamp) > Date.parse(updatedAt)) updatedAt = timestamp;

    const role = event.message?.role;
    if (event.type !== 'user' && event.type !== 'assistant') continue;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = contentToText(event.message?.content);
    if (!text) continue;

    messages.push({
      id: typeof event.uuid === 'string' ? event.uuid : `${sessionId}:${messages.length}`,
      role,
      text,
      timestamp,
    });
  }

  const firstUser = messages.find((message) => message.role === 'user');
  const lastMessage = messages[messages.length - 1];
  const fallbackUpdatedAt = new Date(candidate.mtimeMs).toISOString();
  const resolvedCwd = cwd || fallbackCwd(candidate.projectId);
  const preview = firstUser?.text || lastMessage?.text || sessionId;

  return {
    session: {
      backend: 'claude',
      projectId: candidate.projectId,
      projectName: projectNameFromCwd(resolvedCwd, candidate.projectId),
      cwd: resolvedCwd,
      sessionId,
      title: trimPreview(preview),
      preview: trimPreview(preview),
      lastMessagePreview: trimPreview(lastMessage?.text || preview),
      messageCount: messages.length,
      createdAt: createdAt || fallbackUpdatedAt,
      updatedAt: updatedAt || fallbackUpdatedAt,
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
    })),
  };
}

async function parseCodexSessionWithMessages(
  candidate: CodexSessionCandidate,
  indexEntries: Map<string, CodexIndexEntry>,
): Promise<{
  session: ClaudeHistorySession;
  messages: ClaudeTranscriptMessage[];
}> {
  const raw = await readFile(candidate.filePath, 'utf8');
  const messages: ParsedMessage[] = [];
  let cwd = '';
  let sessionId = candidate.sessionId;
  let createdAt = '';
  let updatedAt = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const timestamp = eventTimestamp(event, candidate.mtimeMs);
    if (!createdAt || Date.parse(timestamp) < Date.parse(createdAt)) createdAt = timestamp;
    if (!updatedAt || Date.parse(timestamp) > Date.parse(updatedAt)) updatedAt = timestamp;

    if (event.type === 'session_meta' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
      if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
      if (typeof payload.timestamp === 'string' && payload.timestamp) {
        if (!createdAt || Date.parse(payload.timestamp) < Date.parse(createdAt)) {
          createdAt = payload.timestamp;
        }
      }
      continue;
    }

    if (event.type !== 'response_item') continue;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (payload.type !== 'message') continue;
    if (payload.role !== 'user' && payload.role !== 'assistant') continue;

    const text = codexContentToText(payload.content);
    if (!text) continue;
    if (payload.role === 'user' && isCodexInjectedContext(text)) continue;

    messages.push({
      id: typeof payload.id === 'string' ? payload.id : `${sessionId}:${messages.length}`,
      role: payload.role,
      text,
      timestamp,
    });
  }

  const indexEntry = indexEntries.get(sessionId) || indexEntries.get(candidate.sessionId);
  if (indexEntry?.updatedAt && Date.parse(indexEntry.updatedAt) > Date.parse(updatedAt || '')) {
    updatedAt = indexEntry.updatedAt;
  }

  const firstUser = messages.find((message) => message.role === 'user');
  const lastMessage = messages[messages.length - 1];
  const fallbackUpdatedAt = new Date(candidate.mtimeMs).toISOString();
  const resolvedCwd = cwd || fallbackCwd(sessionId);
  const projectId = projectIdFromCwd(resolvedCwd);
  const preview = firstUser?.text || lastMessage?.text || indexEntry?.title || sessionId;
  const title = indexEntry?.title || trimPreview(preview);

  return {
    session: {
      backend: 'codex',
      projectId,
      projectName: projectNameFromCwd(resolvedCwd, projectId),
      cwd: resolvedCwd,
      sessionId,
      title: trimPreview(title),
      preview: trimPreview(preview),
      lastMessagePreview: trimPreview(lastMessage?.text || preview),
      messageCount: messages.length,
      createdAt: createdAt || fallbackUpdatedAt,
      updatedAt: updatedAt || fallbackUpdatedAt,
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
    })),
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return normalizeText(content);
  if (!Array.isArray(content)) return '';

  const parts = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const typed = block as Record<string, unknown>;
      if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
      if (typed.type === 'tool_use') {
        return `[tool: ${typeof typed.name === 'string' ? typed.name : 'unknown'}]`;
      }
      if (typed.type === 'image') return '[image]';
      if (typed.type === 'document') return '[document]';
      if (typed.type === 'thinking') return '[thinking]';
      if (typeof typed.type === 'string') return `[${typed.type}]`;
      return '';
    })
    .filter(Boolean);

  return normalizeText(parts.join(' '));
}

function codexContentToText(content: unknown): string {
  if (typeof content === 'string') return normalizeText(content);
  if (!Array.isArray(content)) return '';

  const parts = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const typed = block as Record<string, unknown>;
      if (typed.type === 'input_text' && typeof typed.text === 'string') return typed.text;
      if (typed.type === 'output_text' && typeof typed.text === 'string') return typed.text;
      if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
      if (typed.type === 'function_call') {
        return `[tool: ${typeof typed.name === 'string' ? typed.name : 'unknown'}]`;
      }
      if (typed.type === 'image' || typed.type === 'input_image') return '[image]';
      if (typed.type === 'file' || typed.type === 'input_file') return '[file]';
      if (typeof typed.type === 'string') return `[${typed.type}]`;
      return '';
    })
    .filter(Boolean);

  return normalizeText(parts.join(' '));
}

function isCodexInjectedContext(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.startsWith('# AGENTS.md instructions for ')
    || normalized.startsWith('<environment_context>');
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimPreview(text: string): string {
  const normalized = normalizeText(text);
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function sessionIdFromCodexFileName(fileName: string): string {
  const match = fileName.match(CODEX_SESSION_ID_RE);
  return match?.[0] || path.basename(fileName, '.jsonl');
}

function eventTimestamp(event: Record<string, unknown>, mtimeMs: number): string {
  if (typeof event.timestamp === 'string' && event.timestamp) return event.timestamp;
  const payload = event.payload;
  if (payload && typeof payload === 'object') {
    const typed = payload as Record<string, unknown>;
    if (typeof typed.timestamp === 'string' && typed.timestamp) return typed.timestamp;
  }
  return new Date(mtimeMs).toISOString();
}

export function projectIdFromCwd(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '') || '/';
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? `-${parts.join('-')}` : '-';
}

function projectNameFromCwd(cwd: string, projectId: string): string {
  const name = path.basename(cwd);
  return name && name !== path.sep ? name : fallbackProjectName(projectId);
}

function fallbackProjectName(projectId: string): string {
  const parts = projectId.split('-').filter(Boolean);
  return parts[parts.length - 1] || projectId || 'unknown';
}

function fallbackCwd(projectId: string): string {
  const parts = projectId.split('-').filter(Boolean);
  return parts.length > 0 ? `/${parts.join('/')}` : projectId;
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(limit || DEFAULT_LIMIT)));
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`Invalid ${label}`);
  }
}
