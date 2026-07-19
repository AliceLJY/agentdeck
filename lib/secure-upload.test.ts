import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateUploadDirectory, writePrivateUpload } from './secure-upload';

const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

test('creates a private per-user upload directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-upload-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const uploadDirectory = await ensurePrivateUploadDirectory(root, uid);
  const stat = await lstat(uploadDirectory);

  assert.equal(stat.isDirectory(), true);
  if (uid !== undefined) assert.equal(stat.mode & 0o777, 0o700);
});

test('rejects a pre-existing symlink in the per-user path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-upload-link-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = await mkdtemp(join(tmpdir(), 'ccrt-upload-target-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const ownerDirectory = join(root, `cc-remote-term-${uid ?? 'user'}`);
  await symlink(target, ownerDirectory);

  await assert.rejects(
    ensurePrivateUploadDirectory(root, uid),
    /Unsafe upload directory/,
  );
});

test('writes unique private files without path traversal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ccrt-upload-write-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = Buffer.from('hello');

  const first = await writePrivateUpload('../../demo file.txt', data, {
    baseDirectory: root,
    uid,
  });
  const second = await writePrivateUpload('../../demo file.txt', data, {
    baseDirectory: root,
    uid,
  });

  assert.notEqual(first, second);
  assert.equal(await readFile(first, 'utf8'), 'hello');
  assert.equal(first.startsWith(join(root, `cc-remote-term-${uid ?? 'user'}`, 'uploads')), true);
  assert.equal(first.includes('..'), false);
  if (uid !== undefined) assert.equal((await lstat(first)).mode & 0o777, 0o600);
});
