export type HistoryBackend = 'claude' | 'codex' | 'kimi';
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

export function normalizeBackend(value: unknown): HistoryBackend {
  if (value === 'codex') return 'codex';
  if (value === 'kimi') return 'kimi';
  return 'claude';
}

export function normalizeBackendFilter(value: unknown): HistoryBackendFilter {
  if (value === 'all' || value === 'codex' || value === 'claude' || value === 'kimi') return value;
  return 'all';
}

export function getBackendDisplay(backend: HistoryBackend): BackendDisplay {
  return BACKEND_DISPLAY[backend];
}

export function buildBackendCommand(options: BackendCommandOptions): string[] {
  const resumeId = options.resumeSessionId || null;
  if (options.backend === 'kimi') {
    // kimi has no cwd flag — the tmux session is already spawned in `cwd`,
    // and kimi files its own sessions by working directory from there.
    const args = [options.executable];
    if (resumeId) args.push('-S', resumeId);
    const model = safeModel(options.model);
    if (model) args.push('-m', model);
    const mode = allowed(options.permissionMode, KIMI_PERMISSION_MODES);
    if (mode === 'yolo') args.push('-y');
    else if (mode === 'auto') args.push('--auto');
    else if (mode === 'plan') args.push('--plan');
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
