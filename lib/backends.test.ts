import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackendCommand,
  getBackendDisplay,
  normalizeBackend,
} from './backends';

test('maps Claude and Codex backends to distinct UI colors', () => {
  assert.equal(getBackendDisplay('claude').label, 'CC');
  assert.match(getBackendDisplay('claude').accentClass, /blue|indigo/);

  assert.equal(getBackendDisplay('codex').label, 'Codex');
  assert.match(getBackendDisplay('codex').accentClass, /emerald|teal/);
});

test('normalizes unknown backend input to Claude for compatibility', () => {
  assert.equal(normalizeBackend('codex'), 'codex');
  assert.equal(normalizeBackend('claude'), 'claude');
  assert.equal(normalizeBackend('unknown'), 'claude');
  assert.equal(normalizeBackend(undefined), 'claude');
});

test('builds Codex resume commands with the Codex CLI shape', () => {
  assert.deepEqual(
    buildBackendCommand({
      backend: 'codex',
      executable: '/opt/homebrew/bin/codex',
      cwd: '/Users/alice/Projects/demo-app',
      resumeSessionId: '019ddf07-3bb0-72d0-b8da-99453394cbe4',
    }),
    [
      '/opt/homebrew/bin/codex',
      'resume',
      '--no-alt-screen',
      '-C',
      '/Users/alice/Projects/demo-app',
      '019ddf07-3bb0-72d0-b8da-99453394cbe4',
    ],
  );
});

test('builds Claude resume commands with the existing Claude CLI shape', () => {
  assert.deepEqual(
    buildBackendCommand({
      backend: 'claude',
      executable: '/Users/alice/.local/bin/claude',
      cwd: '/Users/alice/Projects/demo-app',
      resumeSessionId: 'claude-session-a',
    }),
    ['/Users/alice/.local/bin/claude', '--resume', 'claude-session-a'],
  );
});
