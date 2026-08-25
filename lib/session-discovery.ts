import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { HistoryBackend } from './backends';
import {
  agyBrainRoot,
  agyLastConversationsPath,
  agyTranscriptPath,
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
  agyBrainRoot?: string;
  agyLastConvFile?: string;
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
  if (target.backend === 'agy') {
    return discoverAgy(
      target,
      roots.agyBrainRoot || agyBrainRoot(),
      roots.agyLastConvFile || agyLastConversationsPath(),
      roots.excludePaths,
    );
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

  // Resuming: the id names the session, so read it straight off the index —
  // and skip the freshness filter below entirely. A resumed session's wire
  // log keeps its old mtime until the user says something new, which the
  // mtime check would read as "not ours": Chat then sat unclaimed forever on
  // every kimi resume while the terminal talked to the session just fine.
  // Same lesson discoverClaude() already encodes for --resume; kimi's id may
  // arrive bare or with the store's "session_" prefix, so match both.
  const resumeId = target.resumeSessionId || null;

  let best: { filePath: string; mtimeMs: number } | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.sessionDir !== 'string') continue;
    const entryId = typeof entry.sessionId === 'string' ? entry.sessionId : '';
    if (resumeId && (entryId === resumeId || entryId === `session_${resumeId}`)) {
      const filePath = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
      if (!exclude?.has(filePath) && existsSync(filePath)) return filePath;
      continue;
    }
    if (entry.workDir !== target.cwd) continue;
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

/**
 * agy names its conversation dirs by id under brain/, so resuming reads the
 * transcript path straight from the id. A fresh session has no id we know —
 * `cache/last_conversations.json` maps cwd -> the MOST RECENT conversation
 * per cwd, which at spawn time still points at the previous session, so the
 * freshness check below keeps retrying (the hub polls) until agy creates the
 * new conversation on the first prompt and the map catches up.
 */
async function discoverAgy(
  target: DiscoveryTarget,
  brainRoot: string,
  lastConvFile: string,
  exclude?: ReadonlySet<string>,
): Promise<string | null> {
  if (target.resumeSessionId) {
    const filePath = agyTranscriptPath(brainRoot, target.resumeSessionId);
    if (!exclude?.has(filePath) && existsSync(filePath)) return filePath;
    // Fall through: a resumed agy can still mint a fresh conversation.
  }

  let mapped: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(lastConvFile, 'utf-8')) as Record<string, unknown>;
    const id = parsed[target.cwd];
    if (typeof id === 'string' && id) mapped = id;
  } catch {
    return null; // no map yet — retry later
  }
  if (!mapped) return null;

  const filePath = agyTranscriptPath(brainRoot, mapped);
  if (exclude?.has(filePath)) return null;
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return null;
  }
  // Older than our spawn → that's the PREVIOUS conversation in this cwd.
  if (stats.mtimeMs + GRACE_MS < target.spawnTimeMs) return null;
  return filePath;
}

async function discoverClaude(
  target: DiscoveryTarget,
  root: string,
  exclude?: ReadonlySet<string>,
): Promise<string | null> {
  const projectDir = path.join(root, projectIdFromCwd(target.cwd));
  if (!existsSync(projectDir)) return null;

  // Resuming: we already know the id, so there is nothing to infer. `claude
  // --resume` appends to the original file, and terminal-manager verified that
  // file exists before spawning — so name it directly and skip the birthtime
  // heuristic entirely.
  //
  // The heuristic used to run first here, and that was the bug: it picks the
  // file whose birth time sits closest to our spawn, which any freshly created
  // transcript can win. The TG bridge self-check (`streamQuery("自检 ping…")`)
  // spawns several 9-line sessions at once — three were born inside the same
  // second — so resuming anywhere near a bridge health check handed the Chat
  // view a transcript containing one "pong" while the terminal talked to the
  // real session. Display and execution silently pointed at different
  // conversations; the user reads that as the session having forked.
  if (target.resumeSessionId) {
    const resumePath = path.join(projectDir, `${target.resumeSessionId}.jsonl`);
    if (!exclude?.has(resumePath) && existsSync(resumePath)) return resumePath;
    // Missing or already owned: fall through to the heuristic rather than
    // giving up — a resumed CLI can still start a brand-new transcript.
  }

  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best: { filePath: string; distance: number } | null = null;

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
  }

  return best?.filePath || null;
}

async function discoverCodex(
  target: DiscoveryTarget,
  root: string,
  exclude?: ReadonlySet<string>,
): Promise<string | null> {
  // Resuming: the id is in the rollout's filename, so find it directly —
  // anywhere in the date tree, because the session being resumed may be days
  // old while the heuristic below only scans today/yesterday, and with no
  // freshness check, because the rollout keeps its old mtime until the user
  // says something new. Same lesson discoverClaude/discoverKimi/discoverAgy
  // already encode; codex was the last reader still gating resume on mtime,
  // so its Chat sat unclaimed on every resume of an older session.
  if (target.resumeSessionId) {
    const direct = await findCodexRolloutById(root, target.resumeSessionId, exclude);
    if (direct) return direct;
    // Missing or already owned: fall through — a resumed codex can still
    // mint a fresh rollout.
  }

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

/** Walk root's YYYY/MM/DD tree for a rollout whose filename carries the
 *  session id. Newest days first: the session being resumed is usually
 *  recent, and the tree grows one directory per day. */
async function findCodexRolloutById(
  root: string,
  sessionId: string,
  exclude?: ReadonlySet<string>,
): Promise<string | null> {
  const subdirsNewestFirst = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };

  for (const year of await subdirsNewestFirst(root)) {
    const yearDir = path.join(root, year);
    for (const month of await subdirsNewestFirst(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of await subdirsNewestFirst(monthDir)) {
        const dayPath = path.join(monthDir, day);
        let entries;
        try {
          entries = await readdir(dayPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          if (!entry.name.includes(sessionId)) continue;
          const filePath = path.join(dayPath, entry.name);
          if (exclude?.has(filePath)) continue;
          return filePath;
        }
      }
    }
  }
  return null;
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
