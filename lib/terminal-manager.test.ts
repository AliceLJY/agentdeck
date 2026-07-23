import test from 'node:test';
import assert from 'node:assert/strict';
import { findResumeHolder, stripTerminalNoise } from './terminal-manager';

const SESSION_ID = 'df81b097-7529-43bb-bf43-6173c84b1dd2';

test('findResumeHolder returns the first pid when a live process holds the session', () => {
  const seen: string[] = [];
  const holder = findResumeHolder(SESSION_ID, (pattern) => {
    seen.push(pattern);
    return '22161\n33000\n';
  });

  assert.equal(holder, '22161');
  // Both invocation shapes must match: `--resume <id>` (interactive CLI)
  // and `--resume /path/<id>.jsonl` (daemon bg agents).
  const re = new RegExp(seen[0]);
  assert.match(`claude --resume ${SESSION_ID}`, re);
  assert.match(`/versions/2.1.218 --resume /Users/a/.claude/projects/x/${SESSION_ID}.jsonl --name tg-turn`, re);
  // pgrep parses a leading "-" as a flag — the pattern must never start with one.
  assert.ok(!seen[0].startsWith('-'));
});

test('findResumeHolder returns null when no process matches', () => {
  assert.equal(findResumeHolder(SESSION_ID, () => ''), null);
  assert.equal(findResumeHolder(SESSION_ID, () => '\n'), null);
});

test('findResumeHolder fails open when process lookup errors', () => {
  const holder = findResumeHolder(SESSION_ID, () => {
    throw new Error('pgrep missing');
  });
  assert.equal(holder, null);
});

test('stripTerminalNoise recovers the readable refusal a dying CLI printed', () => {
  // Sample reconstructed from a real `claude --resume` rejection captured
  // over a PTY: private-mode CSI, DA responses, charset selects and OSC
  // interleaved with the actual message.
  const raw =
    '\x1b]0;claude\x07\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[>0q\x1b[<u\x1b(B' +
    `Session ${SESSION_ID} is currently running as a\r\n` +
    'background agent (bg). Use `claude agents` to find and attach to it, or add\r\n' +
    '--fork-session to branch off a copy.\r\n' +
    '\x1b[?25h\x1b[?1004l\x1b[?2004l';

  const cleaned = stripTerminalNoise(raw);
  assert.equal(
    cleaned,
    `Session ${SESSION_ID} is currently running as a\n` +
      'background agent (bg). Use `claude agents` to find and attach to it, or add\n' +
      '--fork-session to branch off a copy.',
  );
});

test('stripTerminalNoise drops blank and escape-only lines', () => {
  assert.equal(stripTerminalNoise('\x1b[?25h\r\n\r\n\x1b[0m\r\n'), '');
});
