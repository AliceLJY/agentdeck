import test from 'node:test';
import assert from 'node:assert/strict';
import { findResumeHolder, stripTerminalNoise, titleFromInput } from './terminal-manager';

const SESSION_ID = 'df81b097-7529-43bb-bf43-6173c84b1dd2';

// Every case passes an explicit roster reader: the default one reads the real
// ~/.claude/daemon/roster.json, which would make these depend on whatever the
// machine running the tests happens to have open.
const NO_ROSTER = () => null;
const DEAD_PID = 999_999;   // above macOS's default pid ceiling

function rosterWith(entry: Record<string, unknown>): () => string {
  return () => JSON.stringify({ proto: 1, supervisorPid: 1, workers: { abc12345: entry } });
}

test('findResumeHolder returns the first pid when a live process holds the session', () => {
  const seen: string[] = [];
  const holder = findResumeHolder(SESSION_ID, (pattern) => {
    seen.push(pattern);
    return '22161\n33000\n';
  }, NO_ROSTER);

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
  assert.equal(findResumeHolder(SESSION_ID, () => '', NO_ROSTER), null);
  assert.equal(findResumeHolder(SESSION_ID, () => '\n', NO_ROSTER), null);
});

test('findResumeHolder fails open when process lookup errors', () => {
  const holder = findResumeHolder(SESSION_ID, () => {
    throw new Error('pgrep missing');
  }, NO_ROSTER);
  assert.equal(holder, null);
});

// Since CLI 2.1.220 a bg agent is hosted by the daemon, so its session id is in
// no command line at all and pgrep alone always reported "nobody holds this" —
// the resume then died on the CLI's refusal. The roster is the source that sees
// these, and every session started from the TG bridge is one of them.
test('findResumeHolder finds a daemon-hosted bg agent through the roster', () => {
  const holder = findResumeHolder(
    SESSION_ID,
    () => { throw new Error('pgrep must not be consulted once the roster answers'); },
    rosterWith({ pid: process.pid, sessionId: SESSION_ID, cwd: '/Users/a' }),
  );
  assert.equal(holder, String(process.pid));
});

test('findResumeHolder ignores a roster entry whose process is gone', () => {
  // A daemon that died without cleaning up would otherwise divert a resume
  // that should have been allowed to proceed.
  const holder = findResumeHolder(
    SESSION_ID,
    () => '',
    rosterWith({ pid: DEAD_PID, sessionId: SESSION_ID, cwd: '/Users/a' }),
  );
  assert.equal(holder, null);
});

test('findResumeHolder ignores roster entries for other sessions', () => {
  const holder = findResumeHolder(
    SESSION_ID,
    () => '',
    rosterWith({ pid: process.pid, sessionId: 'ffffffff-0000-0000-0000-000000000000' }),
  );
  assert.equal(holder, null);
});

test('findResumeHolder falls back to pgrep when the roster is unreadable', () => {
  assert.equal(findResumeHolder(SESSION_ID, () => '22161\n', () => 'not json at all'), '22161');
  assert.equal(findResumeHolder(SESSION_ID, () => '22161\n', () => null), '22161');
  // A roster with no workers map at all must not throw either.
  assert.equal(findResumeHolder(SESSION_ID, () => '22161\n', () => '{"proto":1}'), '22161');
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

test('titleFromInput ignores the terminal\'s own OSC colour-query reply', () => {
  // xterm.js answers the CLI's `\x1b]10;?` foreground query by writing the
  // reply back as input. It used to survive control-char stripping and land
  // in the sidebar as a session titled "]10;rgb:3838/3a3a/3c3c".
  assert.equal(titleFromInput('\x1b]10;rgb:3838/3a3a/3c3c\x07'), '');
  assert.equal(titleFromInput('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\'), '');
});

test('titleFromInput keeps the first real prompt as a single line', () => {
  assert.equal(
    titleFromInput('\x1b[200~review  this\r\n change\x1b[201~'),
    'review this change',
  );
});

test('titleFromInput yields nothing for a bare interrupt', () => {
  assert.equal(titleFromInput('\x1b'), '');
  assert.equal(titleFromInput('\x03'), '');
});
