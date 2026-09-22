import path from 'node:path';
import { assertExhaustive, type HistoryBackend } from './backends';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Same shape create() accepts for a resume id — anything we surface must be
 *  something the user can hand straight back to a resume. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The id each CLI's own resume accepts, read off the transcript file a session
 * claimed. Parsed from the path rather than the contents because kimi and agy
 * write no id inside their transcripts:
 *   claude  ~/.claude/projects/<project>/<uuid>.jsonl                      → <uuid>
 *   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl       → <uuid>
 *   kimi    …/sessions/<workdir>/session_<uuid>/agents/main/wire.jsonl    → session_<uuid>
 *   agy     …/brain/<uuid>/.system_generated/logs/transcript.jsonl        → <uuid>
 * Returns null when the path does not have the expected shape.
 */
export function transcriptIdFromPath(backend: HistoryBackend, filePath: string): string | null {
  const parts = filePath.split(path.sep);
  let id: string | null;
  switch (backend) {
    case 'claude':
      id = filePath.endsWith('.jsonl') ? path.basename(filePath, '.jsonl') : null;
      break;
    case 'codex':
      id = path.basename(filePath).match(UUID_RE)?.[0] ?? null;
      break;
    case 'kimi':
      id = parts.find((part) => part.startsWith('session_')) ?? null;
      break;
    case 'agy': {
      const marker = parts.lastIndexOf('.system_generated');
      id = marker > 0 ? parts[marker - 1] : null;
      break;
    }
    default:
      return assertExhaustive(backend);
  }
  return id && SAFE_ID_RE.test(id) ? id : null;
}
