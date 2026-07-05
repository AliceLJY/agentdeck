import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverTranscript } from './session-discovery';
import { projectIdFromCwd } from './history-index';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'ccrt-discovery-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function touch(filePath: string, content = ''): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

/** Backdate mtime (birthtime can't be set portably; discovery falls back to mtime when older). */
async function backdate(filePath: string, ms: number): Promise<void> {
  await utimes(filePath, new Date(ms), new Date(ms));
}

describe('discoverTranscript (claude)', () => {
  it('claims the jsonl born after spawn in the cwd-mapped dir, ignoring old files', async () => {
    const cwd = '/Users/alice/proj';
    const dir = path.join(work, projectIdFromCwd(cwd));
    const oldFile = path.join(dir, 'old-session.jsonl');
    await touch(oldFile, '{}\n');
    await backdate(oldFile, Date.now() - 3600_000);

    const spawnTimeMs = Date.now() - 1000;
    const newFile = path.join(dir, 'new-session.jsonl');
    await touch(newFile, '{}\n');

    const found = await discoverTranscript(
      { backend: 'claude', cwd, spawnTimeMs },
      { claudeRoot: work },
    );
    assert.equal(found, newFile);
  });

  it('returns null when nothing new appeared, then finds a resumed session by mtime', async () => {
    const cwd = '/Users/alice/proj';
    const dir = path.join(work, projectIdFromCwd(cwd));
    const resumed = path.join(dir, 'aaaa-bbbb.jsonl');
    await touch(resumed, '{}\n');
    await backdate(resumed, Date.now() - 3600_000);

    const spawnTimeMs = Date.now();
    assert.equal(
      await discoverTranscript({ backend: 'claude', cwd, spawnTimeMs }, { claudeRoot: work }),
      null,
    );

    // resume touches the old file → mtime fresh → claimable via resumeSessionId
    await utimes(resumed, new Date(), new Date());
    assert.equal(
      await discoverTranscript(
        { backend: 'claude', cwd, spawnTimeMs, resumeSessionId: 'aaaa-bbbb' },
        { claudeRoot: work },
      ),
      resumed,
    );
  });

  it('returns null for a cwd with no project dir', async () => {
    assert.equal(
      await discoverTranscript(
        { backend: 'claude', cwd: '/nope', spawnTimeMs: Date.now() },
        { claudeRoot: work },
      ),
      null,
    );
  });

  it('never claims a transcript another session already owns', async () => {
    const cwd = '/Users/alice/proj';
    const dir = path.join(work, projectIdFromCwd(cwd));
    const claimed = path.join(dir, 'claimed-by-other.jsonl');
    await touch(claimed, '{}\n');

    const spawnTimeMs = Date.now() - 1000;
    // Only candidate is excluded → nothing to claim
    assert.equal(
      await discoverTranscript(
        { backend: 'claude', cwd, spawnTimeMs },
        { claudeRoot: work, excludePaths: new Set([claimed]) },
      ),
      null,
    );

    // A second fresh file appears → the excluded one is still skipped
    const own = path.join(dir, 'own-session.jsonl');
    await touch(own, '{}\n');
    assert.equal(
      await discoverTranscript(
        { backend: 'claude', cwd, spawnTimeMs },
        { claudeRoot: work, excludePaths: new Set([claimed]) },
      ),
      own,
    );
  });
});

describe('discoverTranscript (codex)', () => {
  function todayDir(): string {
    const d = new Date();
    return path.join(
      work,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
  }

  it('claims a fresh rollout whose session_meta cwd matches', async () => {
    const cwd = '/Users/alice/proj';
    const spawnTimeMs = Date.now() - 1000;
    const meta = (c: string) => JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: c, timestamp: new Date().toISOString() } }) + '\n';

    const wrongCwd = path.join(todayDir(), 'rollout-2026-07-05T10-00-00-wrong.jsonl');
    await touch(wrongCwd, meta('/somewhere/else'));

    const target = path.join(todayDir(), 'rollout-2026-07-05T10-00-01-right.jsonl');
    await touch(target, meta(cwd));

    const found = await discoverTranscript(
      { backend: 'codex', cwd, spawnTimeMs },
      { codexRoot: work },
    );
    assert.equal(found, target);
  });

  it('ignores stale rollouts from earlier runs', async () => {
    const cwd = '/Users/alice/proj';
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd } }) + '\n';
    const stale = path.join(todayDir(), 'rollout-2026-07-05T08-00-00-stale.jsonl');
    await touch(stale, meta);
    await backdate(stale, Date.now() - 3600_000);

    assert.equal(
      await discoverTranscript(
        { backend: 'codex', cwd, spawnTimeMs: Date.now() },
        { codexRoot: work },
      ),
      null,
    );
  });
});
