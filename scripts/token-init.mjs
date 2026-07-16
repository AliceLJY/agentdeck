#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const tokenFile =
  process.env.CC_TERMINAL_TOKEN_FILE || join(homedir(), '.config', 'cc-remote-term', 'token');

async function main() {
  const tokenDirectory = dirname(tokenFile);
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });

  const directoryStat = await lstat(tokenDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Token directory is not a real directory: ${tokenDirectory}`);
  }
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new Error(`Token directory is not owned by the current user: ${tokenDirectory}`);
  }
  await chmod(tokenDirectory, 0o700);

  const token = randomBytes(32).toString('hex');
  const temporaryFile = `${tokenFile}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temporaryFile, token, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryFile, 0o600);
    await rename(temporaryFile, tokenFile);
    await chmod(tokenFile, 0o600);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }

  if (process.env.CC_TERMINAL_SKIP_CLIPBOARD !== '1') {
    const pbcopy = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'inherit'] });
    pbcopy.stdin.end(token);
    const [exitCode] = await once(pbcopy, 'close');
    if (exitCode !== 0) throw new Error('pbcopy could not copy the new token.');
  }

  console.log(
    process.env.CC_TERMINAL_SKIP_CLIPBOARD === '1'
      ? `[cc-terminal] New token stored privately at ${tokenFile}; clipboard copy skipped.`
      : `[cc-terminal] New token stored privately at ${tokenFile} and copied to the clipboard.`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[cc-terminal] Token initialization failed: ${message}`);
  process.exitCode = 1;
});
