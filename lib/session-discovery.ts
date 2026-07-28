import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HistoryBackend } from './backends';
import {
  claudeProjectsRoot,
  codexSessionsRoot,
  kimiSessionIndexPath,
  projectIdFromCwd,
  readCodexSessionHead,
} from './history-index';

/**
 * Claim the on-disk transcript file for a terminal session we just spawned.
 *
 * The CLIs pick their own session ids, so we match on circumstantial
 * evidence instead: a transcript file *created* (birthtime) right after we
 * spawned the CLI, inside the directory that maps to the spawn cwd.
 * `--resume` may keep appending to the original file, so a fresh mtime on
 * the resumed session's file also counts.
 *
 * Known limit (documented in docs/chat-view-plan.md): two sessions spawned
 * in the same cwd within the same few seconds could cross-claim. We pick the
 * file whose birthtime is closest to our spawn time to minimize that window.
 */

export interface DiscoveryTarget {
  backend: HistoryBackend;
  cwd: string;
  spawnTimeMs: number;
  resumeSessionId?: string | null;
}

export interface DiscoveryRoots {
  claudeRoot?: string;
  codexRoot?: string;
  kimiIndexFile?: string;
  /** Transcripts already claimed by other sessions — never claim them again.
   * Without this, several sessions spawned in the same cwd race for the same
   * file (the newest one wins them all). */
  excludePaths?: ReadonlySet<string>;
}

/** Files born earlier than spawnTime−GRACE are never ours. */
const GRACE_MS = 5_000;

export async function discoverTranscript(
  target: DiscoveryTarget,
  roots: DiscoveryRoots = {},
): Promise<string | null> {
  if (target.backend === 'codex') {
    return discoverCodex(target, roots.codexRoot || codexSessionsRoot(), roots.excludePaths);
  }
  if (target.backend === 'kimi') {
    return discoverKimi(target, roots.kimiIndexFile || kimiSessionIndexPath(), roots.excludePaths);
  }
  return discoverClaude(target, roots.claudeRoot || claudeProjectsRoot(), roots.excludePaths);
}

/**
 * kimi records the session it just started in session_index.jsonl, so the
 * newest entry whose workDir matches our spawn cwd is ours. Unlike the Claude
 * and Codex paths there is no birthtime race to resolve: the index line and
 * the wire log appear together.
 */
async function discoverKimi(
  target: DiscoveryTarget,
  indexFile: string,
  exclude?: ReadonlySet<string>,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(indexFile, 'utf-8');
  } catch {
    return null;
  }

  let best: { filePath: string; mtimeMs: number } | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.sessionDir !== 'string' || entry.workDir !== target.cwd) continue;
    const filePath = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
    if (exclude?.has(filePath)) continue;
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      continue;
    }
    if (stats.mtimeMs + GRACE_MS < target.spawnTimeMs) continue;
    if (!best || stats.mtimeMs > best.mtimeMs) best = { filePath, mtimeMs: stats.mtimeMs };
  }
  return best?.filePath || null;
}

async function discoverClaude(
  target: DiscoveryTarget,
  root: string,
  exclude?: ReadonlySet<string>,
): Promise<string | null> {
  const projectDir = path.join(root, projectIdFromCwd(target.cwd));
  if (!existsSync(projectDir)) return null;

  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best: { filePath: string; distance: number } | null = null;
  let resumeFallback: string | null = null;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDir, entry.name);
    if (exclude?.has(filePath)) continue;
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }

    const born = conservativeBirthTime(fileStat);
    if (born >= target.spawnTimeMs - GRACE_MS) {
      const distance = Math.abs(born - target.spawnTimeMs);
      if (!best || distance < best.distance) best = { filePath, distance };
    }

    // resume may append to the original file instead of creating a new one
    if (
      target.resumeSessionId
      && entry.name === `${target.resumeSessionId}.jsonl`
      && fileStat.mtimeMs >= target.spawnTimeMs - GRACE_MS
    ) {
      resumeFallback = filePath;
    }
  }

  return best?.filePath || resumeFallback;
}

async function discoverCodex(
  target: DiscoveryTarget,
  root: string,
  exclude?: ReadonlySet<string>,
): Promise<string | null> {
  // Rollouts live under YYYY/MM/DD (local time); include the previous day to
  // survive spawns that straddle midnight.
  const dayDirs = [target.spawnTimeMs, target.spawnTimeMs - 24 * 3600 * 1000]
    .map((ms) => dayDir(root, ms))
    .filter((dir, i, arr) => arr.indexOf(dir) === i && existsSync(dir));

  let best: { filePath: string; distance: number } | null = null;

  for (const dir of dayDirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, entry.name);
      if (exclude?.has(filePath)) continue;
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }

      const born = conservativeBirthTime(fileStat);
      const isResumeTarget = Boolean(
        target.resumeSessionId && entry.name.includes(target.resumeSessionId),
      );
      const freshlyBorn = born >= target.spawnTimeMs - GRACE_MS;
      const resumedActive = isResumeTarget && fileStat.mtimeMs >= target.spawnTimeMs - GRACE_MS;
      if (!freshlyBorn && !resumedActive) continue;

      // Codex nests every session under the same date dir — verify cwd via
      // the session_meta head before claiming.
      const head = await readCodexSessionHead(filePath);
      if (head.cwd && head.cwd !== target.cwd && !isResumeTarget) continue;

      const distance = Math.abs(born - target.spawnTimeMs);
      if (!best || distance < best.distance) best = { filePath, distance };
    }
  }

  return best?.filePath || null;
}

function dayDir(root: string, ms: number): string {
  const d = new Date(ms);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(root, yyyy, mm, dd);
}

/**
 * Some filesystems report a creation time that tests and restore tools cannot
 * backdate even when mtime is old. Requiring both signals to be fresh prevents
 * a stale transcript from looking newly created on Linux while preserving the
 * normal macOS birthtime behavior.
 */
function conservativeBirthTime(fileStat: { birthtimeMs: number; mtimeMs: number }): number {
  const birthtime = fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : fileStat.mtimeMs;
  return Math.min(birthtime, fileStat.mtimeMs);
}
