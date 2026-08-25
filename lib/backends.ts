export type HistoryBackend = 'claude' | 'kimi' | 'agy' | 'codex';
export type HistoryBackendFilter = HistoryBackend | 'all';

export interface BackendDisplay {
  label: string;
  accentClass: string;
  badgeClass: string;
  selectedClass: string;
  terminalName: string;
}

export interface BackendCommandOptions {
  backend: HistoryBackend;
  executable: string;
  cwd: string;
  resumeSessionId?: string | null;
  model?: string;
  permissionMode?: string;
  effort?: string;
  sandbox?: string;
  reasoningEffort?: string;
}

// Values verified against `claude --help` / `codex --help` (2026-07-05).
// They end up on a shell command line, so anything outside these allowlists
// is silently dropped.
const CLAUDE_PERMISSION_MODES = new Set([
  'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan',
]);
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const CODEX_REASONING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
// Verified against `kimi --help` (0.29.1): -y auto-approves tool calls but still
// asks questions, --auto is fully autonomous, --plan starts in plan mode.
const KIMI_PERMISSION_MODES = new Set(['default', 'yolo', 'auto', 'plan']);
// Verified against `agy --help` (Antigravity CLI 1.1.8, 2026-07-30):
// --effort takes low|medium|high (no xhigh, unlike claude), --mode takes
// accept-edits|plan. There is no -C/--cwd flag — the tmux session is already
// spawned in `cwd`, same situation as kimi.
const AGY_EFFORT_LEVELS = new Set(['low', 'medium', 'high']);
const AGY_MODES = new Set(['accept-edits', 'plan']);
const MODEL_NAME_RE = /^[A-Za-z0-9._/-]{1,64}$/;

function safeModel(value: string | undefined): string | null {
  return value && MODEL_NAME_RE.test(value) ? value : null;
}

function allowed(value: string | undefined, allowlist: Set<string>): string | null {
  return value && allowlist.has(value) ? value : null;
}

const BACKEND_DISPLAY: Record<HistoryBackend, BackendDisplay> = {
  claude: {
    label: 'CC',
    accentClass: 'border-blue-400 dark:border-blue-500',
    badgeClass:
      'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300',
    selectedClass:
      'border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30',
    terminalName: 'Claude Code',
  },
  codex: {
    label: 'Codex',
    accentClass: 'border-emerald-400 dark:border-emerald-500',
    badgeClass:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
    selectedClass:
      'border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30',
    terminalName: 'Codex',
  },
  agy: {
    label: 'Agy',
    accentClass: 'border-amber-400 dark:border-amber-500',
    badgeClass:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
    selectedClass:
      'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30',
    terminalName: 'Antigravity',
  },
  kimi: {
    label: 'Kimi',
    accentClass: 'border-violet-400 dark:border-violet-500',
    badgeClass:
      'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300',
    selectedClass:
      'border-violet-300 bg-violet-50 dark:border-violet-900 dark:bg-violet-950/30',
    terminalName: 'Kimi',
  },
};

/** Compile-time exhaustiveness for backend dispatch sites. Call it after
 *  handling every member of HistoryBackend: when a new backend id is added,
 *  every dispatch that forgot a branch stops COMPILING instead of silently
 *  falling through to the Claude path. That silent fall-through has now bitten
 *  three separate times in one night (route.ts, session-discovery.ts,
 *  transcript-parser.ts — agy wired everywhere except the last mile, and
 *  Chat just showed empty). Same idea as the Record<HistoryBackend,…>
 *  executable table above, applied to control flow. */
export function assertExhaustive(value: never): never {
  throw new Error(`Unhandled backend: ${String(value)}`);
}

export function normalizeBackend(value: unknown): HistoryBackend {
  if (value === 'codex') return 'codex';
  if (value === 'kimi') return 'kimi';
  if (value === 'agy') return 'agy';
  return 'claude';
}

export function normalizeBackendFilter(value: unknown): HistoryBackendFilter {
  if (value === 'all' || value === 'codex' || value === 'claude' || value === 'kimi' || value === 'agy') return value;
  return 'all';
}

export function getBackendDisplay(backend: HistoryBackend): BackendDisplay {
  return BACKEND_DISPLAY[backend];
}

/** Which backend a brand-new terminal starts with, given the home screen filter.
 *
 *  'all' is the only filter value with no backend of its own, so it is the only
 *  one that falls back — every real backend passes straight through. Written as
 *  a pass-through rather than a chain of comparisons on purpose: the previous
 *  `filter === 'codex' ? 'codex' : filter === 'kimi' ? 'kimi' : 'claude'`
 *  silently turned an Agy filter into a claude session, and would have done the
 *  same to any backend added later. */
export function backendForNewTerminal(filter: HistoryBackendFilter): HistoryBackend {
  return filter === 'all' ? 'claude' : filter;
}

export function buildBackendCommand(options: BackendCommandOptions): string[] {
  const resumeId = options.resumeSessionId || null;
  if (options.backend === 'kimi') {
    // kimi has no cwd flag — the tmux session is already spawned in `cwd`,
    // and kimi files its own sessions by working directory from there.
    const args = [options.executable];
    // kimi 0.38 wants the full store-directory name ("session_<uuid>") after
    // -S; a bare uuid gets "Session not found" and the CLI dies on the spot,
    // which the viewer experiences as "tap the session, bounce back home".
    // Verified 2026-08-25 on the same session both ways. history-index keeps
    // bare uuids as ids everywhere else, so the prefix is added only here at
    // the command line. Sessions written by kimi ≤0.29 are refused by 0.38
    // in both spellings — that is kimi's own migration gap, not ours.
    if (resumeId) {
      args.push('-S', resumeId.startsWith('session_') ? resumeId : `session_${resumeId}`);
    }
    const model = safeModel(options.model);
    if (model) args.push('-m', model);
    const mode = allowed(options.permissionMode, KIMI_PERMISSION_MODES);
    if (mode === 'yolo') args.push('-y');
    else if (mode === 'auto') args.push('--auto');
    else if (mode === 'plan') args.push('--plan');
    return args;
  }
  if (options.backend === 'agy') {
    // agy has no cwd flag either — the tmux session already runs in `cwd`.
    const args = [options.executable];
    if (resumeId) args.push('--conversation', resumeId);
    const model = safeModel(options.model);
    if (model) args.push('--model', model);
    const effort = allowed(options.effort, AGY_EFFORT_LEVELS);
    if (effort) args.push('--effort', effort);
    const mode = allowed(options.permissionMode, AGY_MODES);
    if (mode) args.push('--mode', mode);
    return args;
  }
  if (options.backend === 'codex') {
    if (resumeId) {
      // `codex resume` may not accept the same flags as a fresh launch —
      // keep the resume invocation untouched.
      return [
        options.executable,
        'resume',
        '--no-alt-screen',
        '-C',
        options.cwd,
        resumeId,
      ];
    }
    const args = [options.executable, '--no-alt-screen', '-C', options.cwd];
    const model = safeModel(options.model);
    if (model) args.push('-m', model);
    const sandbox = allowed(options.sandbox, CODEX_SANDBOX_MODES);
    if (sandbox) args.push('-s', sandbox);
    const reasoning = allowed(options.reasoningEffort, CODEX_REASONING_LEVELS);
    if (reasoning) args.push('-c', `model_reasoning_effort=${reasoning}`);
    return args;
  }

  const args = [options.executable];
  if (resumeId) args.push('--resume', resumeId);

  const model = safeModel(options.model);
  if (model) args.push('--model', model);
  const permissionMode = allowed(options.permissionMode, CLAUDE_PERMISSION_MODES);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  const effort = allowed(options.effort, CLAUDE_EFFORT_LEVELS);
  if (effort) args.push('--effort', effort);

  return args;
}
