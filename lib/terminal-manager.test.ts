import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  TerminalManager,
  backendExecutableCandidates,
  findResumeHolder,
  stripTerminalNoise,
  titleFromInput,
} from './terminal-manager';

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

// agy spent 2026-07-30 → 08-07 launching `claude` because the lookup was a chain
// of `if`s ending in a claude fallback. Record<HistoryBackend, …> now makes a
// missing id a compile error — but the compiler cannot tell whether a *value*
// points at the right CLI, and pointing agy at claude's paths is the same bug
// wearing a different hat. That is what these two cover.
test('every backend looks up its own CLI name, never another backend’s', () => {
  const table = backendExecutableCandidates('/Users/test');
  for (const [backend, candidates] of Object.entries(table)) {
    assert.ok(candidates.length > 0, `${backend} has no candidate paths at all`);
    for (const candidate of candidates) {
      assert.equal(
        path.basename(candidate),
        backend,
        `${backend} would launch ${path.basename(candidate)} instead (${candidate})`,
      );
    }
  }
});

test('the candidate table covers every HistoryBackend id', () => {
  assert.deepEqual(
    Object.keys(backendExecutableCandidates('/Users/test')).sort(),
    ['agy', 'claude', 'codex', 'kimi'],
  );
});

// A session recovered after a server restart has no PTY bridge until a viewer
// attaches, so the server never sees its output. Before 2026-09-21 its
// lastActivity froze at recovery and cleanupIdle killed it 30 minutes later
// even while the CLI was busy on a long task. tmux's window_activity keeps
// moving on pane output with no client attached — that is the clock to trust.
function recoveredManager(windowActivitySec: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentdeck-idle-'));
  const calls = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'tmux');
  writeFileSync(calls, '');
  writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$*" >> '${calls}'`,
    'case "$*" in',
    '  *list-sessions*) echo "ccrt-job" ;;',
    '  *list-panes*) echo "0" ;;',
    `  *window_activity*) echo "${windowActivitySec}" ;;`,
    '  *display-message*) echo "/tmp" ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  const store = { loadAll: () => ({}), remove: () => {}, save: () => {}, updateTitle: () => {} };
  const manager = new TerminalManager({ tmuxPath: bin, store, startCleanupTimer: false, home: dir });
  return { manager, killed: () => readFileSync(calls, 'utf8').includes('kill-session') };
}

async function sweepAfter(windowActivityMsAgo: number | null): Promise<{ left: number; killed: boolean }> {
  const realNow = Date.now;
  const start = 1_800_000_000_000;
  const sweepAt = start + 31 * 60_000;
  const activitySec = windowActivityMsAgo === null
    ? Math.floor(start / 1000) - 10
    : Math.floor((sweepAt - windowActivityMsAgo) / 1000);
  const { manager, killed } = recoveredManager(activitySec);
  try {
    Date.now = () => start;
    await manager.init();
    assert.equal(manager.list().length, 1, 'the fake tmux session should be recovered');
    Date.now = () => sweepAt;
    (manager as unknown as { cleanupIdle(): void }).cleanupIdle();
    return { left: manager.list().length, killed: killed() };
  } finally {
    Date.now = realNow;
    manager.destroy();
  }
}

test('cleanupIdle keeps a recovered session whose pane printed a minute ago', async () => {
  const { left, killed } = await sweepAfter(60_000);
  assert.equal(killed, false, 'a busy recovered session must not be killed');
  assert.equal(left, 1);
});

test('cleanupIdle still reclaims a recovered session that has been quiet past IDLE_TIMEOUT', async () => {
  const { left, killed } = await sweepAfter(null);
  assert.equal(killed, true);
  assert.equal(left, 0);
});
