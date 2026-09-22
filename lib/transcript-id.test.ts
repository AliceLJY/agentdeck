import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptIdFromPath } from './transcript-id';

const UUID = '3f012c13-213b-4581-a639-91d35be9595b';

// Shapes copied from the claimed paths each discovery branch produces
// (session-discovery.ts) and checked against real files on mini, 2026-09-22.
test('claude: the jsonl basename is the session id', () => {
  assert.equal(
    transcriptIdFromPath('claude', `/Users/a/.claude/projects/-Users-a/${UUID}.jsonl`),
    UUID,
  );
});

test('codex: the uuid inside the rollout filename, not the timestamp', () => {
  assert.equal(
    transcriptIdFromPath('codex', `/Users/a/.codex/sessions/2026/09/22/rollout-2026-09-22T09-30-00-${UUID}.jsonl`),
    UUID,
  );
});

test('kimi: the session_ directory, prefix kept (kimi -S wants it)', () => {
  assert.equal(
    transcriptIdFromPath('kimi', `/Users/a/.kimi-code/sessions/wd_home_ab12/session_${UUID}/agents/main/wire.jsonl`),
    `session_${UUID}`,
  );
});

test('agy: the brain directory name above .system_generated', () => {
  assert.equal(
    transcriptIdFromPath('agy', `/Users/a/.gemini/antigravity-cli/brain/${UUID}/.system_generated/logs/transcript.jsonl`),
    UUID,
  );
});

test('paths of the wrong shape yield null instead of a bogus id', () => {
  assert.equal(transcriptIdFromPath('claude', '/Users/a/.claude/projects/-Users-a/notes.txt'), null);
  assert.equal(transcriptIdFromPath('codex', '/Users/a/.codex/sessions/2026/09/22/rollout-no-id.jsonl'), null);
  assert.equal(transcriptIdFromPath('kimi', '/Users/a/.kimi-code/sessions/wd_home_ab12/agents/main/wire.jsonl'), null);
  assert.equal(transcriptIdFromPath('agy', `/Users/a/.gemini/antigravity-cli/brain/${UUID}/transcript.jsonl`), null);
  // Anything create() would refuse as a resume id is not surfaced either.
  assert.equal(transcriptIdFromPath('claude', '/Users/a/.claude/projects/-Users-a/has space.jsonl'), null);
});
