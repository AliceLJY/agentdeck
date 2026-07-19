import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

async function ensurePrivateDirectory(path: string, uid: number | undefined): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe upload directory: ${path}`);
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Upload directory is not owned by the current user: ${path}`);
  }

  if (uid !== undefined) {
    await chmod(path, 0o700);
    const secured = await lstat(path);
    if ((secured.mode & 0o777) !== 0o700) {
      throw new Error(`Upload directory permissions are not private: ${path}`);
    }
  }
}

export async function ensurePrivateUploadDirectory(
  baseDirectory: string = tmpdir(),
  uid: number | undefined = currentUid(),
): Promise<string> {
  const ownerDirectory = join(baseDirectory, `cc-remote-term-${uid ?? 'user'}`);
  await ensurePrivateDirectory(ownerDirectory, uid);

  const uploadDirectory = join(ownerDirectory, 'uploads');
  await ensurePrivateDirectory(uploadDirectory, uid);
  return uploadDirectory;
}

export async function writePrivateUpload(
  originalName: string,
  data: Uint8Array,
  options: { baseDirectory?: string; uid?: number } = {},
): Promise<string> {
  const uploadDirectory = await ensurePrivateUploadDirectory(
    options.baseDirectory,
    options.uid,
  );
  const safeName = originalName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '') || 'upload';
  const path = join(uploadDirectory, `${randomUUID()}-${safeName}`);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    if (options.uid !== undefined || currentUid() !== undefined) {
      await handle.chmod(0o600);
    }
  } finally {
    await handle.close();
  }
  return path;
}
