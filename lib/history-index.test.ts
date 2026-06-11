import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexHistoryIndex,
  buildHistoryIndex,
  buildClaudeHistoryIndex,
  readCodexTranscript,
  readClaudeTranscript,
} from './history-index';

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

test('indexes recent Claude JSONL sessions without loading every session into the UI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-history-'));
  const projectDir = join(root, '-Users-alice-Projects-demo-app');
  await mkdir(projectDir, { recursive: true });

  await writeFile(
    join(projectDir, 'older-session.jsonl'),
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: 'older question' },
        timestamp: '2026-04-28T10:00:00.000Z',
        cwd: '/Users/alice/Projects/demo-app',
        sessionId: 'older-session',
      },
    ]),
  );

  await writeFile(
    join(projectDir, 'newer-session.jsonl'),
    [
      '{bad json',
      jsonl([
        {
          type: 'permission-mode',
          sessionId: 'newer-session',
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'newer question with image' },
              { type: 'image', source: { type: 'base64' } },
            ],
          },
          timestamp: '2026-04-30T12:00:00.000Z',
          cwd: '/Users/alice/Projects/demo-app',
          sessionId: 'newer-session',
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'newer answer' }],
          },
          timestamp: '2026-04-30T12:01:00.000Z',
          cwd: '/Users/alice/Projects/demo-app',
          sessionId: 'newer-session',
        },
      ]).trimEnd(),
    ].join('\n') + '\n',
  );

  const index = await buildClaudeHistoryIndex({ rootDir: root, limit: 1 });

  assert.equal(index.sessions.length, 1);
  assert.equal(index.sessions[0].sessionId, 'newer-session');
  assert.equal(index.sessions[0].projectName, 'demo-app');
  assert.equal(index.sessions[0].messageCount, 2);
  assert.equal(index.sessions[0].preview, 'newer question with image [image]');
  assert.equal(index.projects.length, 1);
  assert.equal(index.projects[0].sessionCount, 2);
});

test('reads a compact transcript for a selected Claude session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-transcript-'));
  const projectDir = join(root, '-Users-alice-Projects-demo-app');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, 'session-a.jsonl'),
    jsonl([
      {
        type: 'attachment',
        timestamp: '2026-04-30T11:59:00.000Z',
        sessionId: 'session-a',
      },
      {
        type: 'user',
        message: { role: 'user', content: 'show me the plan' },
        timestamp: '2026-04-30T12:00:00.000Z',
        cwd: '/Users/alice/Projects/demo-app',
        sessionId: 'session-a',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'plan line one' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
        timestamp: '2026-04-30T12:01:00.000Z',
        cwd: '/Users/alice/Projects/demo-app',
        sessionId: 'session-a',
      },
    ]),
  );

  const transcript = await readClaudeTranscript({
    rootDir: root,
    projectId: '-Users-alice-Projects-demo-app',
    sessionId: 'session-a',
  });

  assert.equal(transcript.session.sessionId, 'session-a');
  assert.deepEqual(
    transcript.messages.map((message) => [message.role, message.text]),
    [
      ['user', 'show me the plan'],
      ['assistant', 'plan line one [tool: Read]'],
    ],
  );
});

test('hydrates project names from each project latest JSONL even outside the recent limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-projects-'));
  const olderProject = join(root, '-Users-alice-Projects-demo-app');
  const newerProject = join(root, '-Users-alice-Projects-other-app');
  await mkdir(olderProject, { recursive: true });
  await mkdir(newerProject, { recursive: true });

  await writeFile(
    join(olderProject, 'older-session.jsonl'),
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: 'older' },
        timestamp: '2026-04-28T10:00:00.000Z',
        cwd: '/Users/alice/Projects/demo-app',
        sessionId: 'older-session',
      },
    ]),
  );
  await writeFile(
    join(newerProject, 'newer-session.jsonl'),
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: 'newer' },
        timestamp: '2026-04-30T10:00:00.000Z',
        cwd: '/Users/alice/Projects/other-app',
        sessionId: 'newer-session',
      },
    ]),
  );

  const index = await buildClaudeHistoryIndex({ rootDir: root, limit: 1 });

  assert.equal(index.sessions.length, 1);
  assert.equal(
    index.projects.find((project) => project.id === '-Users-alice-Projects-demo-app')?.name,
    'demo-app',
  );
});

test('indexes Codex JSONL sessions with backend metadata and session_index titles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-codex-history-'));
  const sessionsRoot = join(root, 'sessions');
  const sessionDir = join(sessionsRoot, '2026', '05', '01');
  const indexFile = join(root, 'session_index.jsonl');
  await mkdir(sessionDir, { recursive: true });

  await writeFile(
    indexFile,
    jsonl([
      {
        id: '019ddf07-3bb0-72d0-b8da-99453394cbe4',
        thread_name: 'Codex indexed title',
        updated_at: '2026-05-01T02:03:00.000Z',
      },
    ]),
  );

  await writeFile(
    join(sessionDir, 'rollout-2026-05-01T01-00-00-019ddf07-3bb0-72d0-b8da-99453394cbe4.jsonl'),
    [
      '{bad json',
      jsonl([
        {
          timestamp: '2026-05-01T01:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: '019ddf07-3bb0-72d0-b8da-99453394cbe4',
            cwd: '/Users/alice/Projects/demo-app',
            timestamp: '2026-05-01T01:00:00.000Z',
          },
        },
        {
          timestamp: '2026-05-01T01:00:30.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/alice\n<INSTRUCTIONS>local rules</INSTRUCTIONS>' }],
          },
        },
        {
          timestamp: '2026-05-01T01:01:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'codex question' }],
          },
        },
        {
          timestamp: '2026-05-01T01:02:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'codex answer' },
              { type: 'function_call', name: 'shell' },
            ],
          },
        },
      ]).trimEnd(),
    ].join('\n') + '\n',
  );

  const index = await buildCodexHistoryIndex({
    sessionsRootDir: sessionsRoot,
    indexFile,
    limit: 10,
  });

  assert.equal(index.sessions.length, 1);
  assert.equal(index.sessions[0].backend, 'codex');
  assert.equal(index.sessions[0].sessionId, '019ddf07-3bb0-72d0-b8da-99453394cbe4');
  assert.equal(index.sessions[0].projectId, '-Users-alice-Projects-demo-app');
  assert.equal(index.sessions[0].projectName, 'demo-app');
  assert.equal(index.sessions[0].preview, 'codex question');
  assert.equal(index.sessions[0].title, 'Codex indexed title');
  assert.equal(index.projects[0].backend, 'codex');
});

test('reads a compact transcript for a selected Codex session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-codex-transcript-'));
  const sessionsRoot = join(root, 'sessions', '2026', '05', '01');
  await mkdir(sessionsRoot, { recursive: true });

  await writeFile(
    join(sessionsRoot, 'rollout-2026-05-01T01-00-00-019ddf07-3bb0-72d0-b8da-99453394cbe4.jsonl'),
    jsonl([
      {
        timestamp: '2026-05-01T01:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019ddf07-3bb0-72d0-b8da-99453394cbe4',
          cwd: '/Users/alice/Projects/demo-app',
        },
        },
        {
          timestamp: '2026-05-01T01:00:30.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/Users/alice</cwd>\n</environment_context>' }],
          },
        },
        {
          timestamp: '2026-05-01T01:01:00.000Z',
          type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'show codex plan' }],
        },
      },
      {
        timestamp: '2026-05-01T01:02:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'codex plan line' },
            { type: 'function_call', name: 'apply_patch' },
          ],
        },
      },
    ]),
  );

  const transcript = await readCodexTranscript({
    sessionsRootDir: join(root, 'sessions'),
    projectId: '-Users-alice-Projects-demo-app',
    sessionId: '019ddf07-3bb0-72d0-b8da-99453394cbe4',
  });

  assert.equal(transcript.session.backend, 'codex');
  assert.deepEqual(
    transcript.messages.map((message) => [message.role, message.text]),
    [
      ['user', 'show codex plan'],
      ['assistant', 'codex plan line [tool: apply_patch]'],
    ],
  );
});

test('builds a combined history index sorted across Claude and Codex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-combined-history-'));
  const claudeRoot = join(root, 'claude-projects');
  const claudeProject = join(claudeRoot, '-Users-alice-Projects-claude-app');
  const codexSessionsRoot = join(root, 'codex-sessions');
  const codexSessionDir = join(codexSessionsRoot, '2026', '05', '01');
  await mkdir(claudeProject, { recursive: true });
  await mkdir(codexSessionDir, { recursive: true });

  await writeFile(
    join(claudeProject, 'claude-session.jsonl'),
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: 'claude question' },
        timestamp: '2026-05-01T01:00:00.000Z',
        cwd: '/Users/alice/Projects/claude-app',
        sessionId: 'claude-session',
      },
    ]),
  );

  await writeFile(
    join(codexSessionDir, 'rollout-2026-05-01T02-00-00-019ddf07-3bb0-72d0-b8da-99453394cbe4.jsonl'),
    jsonl([
      {
        timestamp: '2026-05-01T02:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019ddf07-3bb0-72d0-b8da-99453394cbe4',
          cwd: '/Users/alice/Projects/codex-app',
        },
      },
      {
        timestamp: '2026-05-01T02:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'codex question' }],
        },
      },
    ]),
  );

  const index = await buildHistoryIndex({
    backend: 'all',
    claudeRootDir: claudeRoot,
    codexSessionsRootDir: codexSessionsRoot,
    limit: 10,
  });

  assert.deepEqual(index.sessions.map((session) => session.backend), ['codex', 'claude']);
  assert.equal(index.projects.length, 2);
});

test('keeps the most recently active Codex session when session_index is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-codex-stale-'));
  const sessionsRoot = join(root, 'sessions');
  const sessionDir = join(sessionsRoot, '2026', '05', '01');
  const indexFile = join(root, 'session_index.jsonl');
  await mkdir(sessionDir, { recursive: true });

  const idA = '019ddf07-aaaa-72d0-b8da-000000000001'; // recently active, stale index entry
  const idB = '019ddf07-bbbb-72d0-b8da-000000000002'; // older activity, fresh index entry

  // session_index lags reality: A's entry is old, B's is newer.
  await writeFile(indexFile, jsonl([
    { id: idA, thread_name: 'A', updated_at: '2026-05-01T00:00:00.000Z' },
    { id: idB, thread_name: 'B', updated_at: '2026-05-02T00:00:00.000Z' },
  ]));

  const fileA = join(sessionDir, `rollout-2026-05-01T00-00-00-${idA}.jsonl`);
  const fileB = join(sessionDir, `rollout-2026-05-01T00-00-00-${idB}.jsonl`);
  await writeFile(fileA, jsonl([
    { type: 'session_meta', payload: { id: idA, cwd: '/Users/alice/Projects/app-a' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question a' }] } },
  ]));
  await writeFile(fileB, jsonl([
    { type: 'session_meta', payload: { id: idB, cwd: '/Users/alice/Projects/app-b' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question b' }] } },
  ]));

  // A's transcript is the most recently modified; B's is older.
  await utimes(fileA, new Date('2026-05-03T00:00:00.000Z'), new Date('2026-05-03T00:00:00.000Z'));
  await utimes(fileB, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-05-01T00:00:00.000Z'));

  const index = await buildCodexHistoryIndex({ sessionsRootDir: sessionsRoot, indexFile, limit: 1 });

  // Project list stays complete, and the single returned session is A — the
  // most recently active — even though its session_index time is stale.
  assert.equal(index.projects.length, 2);
  assert.equal(index.sessions.length, 1);
  assert.equal(index.sessions[0].sessionId, idA);
});
