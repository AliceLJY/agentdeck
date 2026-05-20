export type HistoryBackend = 'claude' | 'codex';
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
};

export function normalizeBackend(value: unknown): HistoryBackend {
  return value === 'codex' ? 'codex' : 'claude';
}

export function normalizeBackendFilter(value: unknown): HistoryBackendFilter {
  if (value === 'all' || value === 'codex' || value === 'claude') return value;
  return 'all';
}

export function getBackendDisplay(backend: HistoryBackend): BackendDisplay {
  return BACKEND_DISPLAY[backend];
}

export function buildBackendCommand(options: BackendCommandOptions): string[] {
  const resumeId = options.resumeSessionId || null;
  if (options.backend === 'codex') {
    if (resumeId) {
      return [
        options.executable,
        'resume',
        '--no-alt-screen',
        '-C',
        options.cwd,
        resumeId,
      ];
    }
    return [options.executable, '--no-alt-screen', '-C', options.cwd];
  }

  const args = [options.executable];
  if (resumeId) args.push('--resume', resumeId);
  return args;
}
