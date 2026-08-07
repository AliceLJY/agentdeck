'use client';

import { useState } from 'react';
import type { HistoryBackend } from '@/lib/backends';
import type { TerminalCreateOptions } from '@/lib/types';

interface NewSessionPanelProps {
  onStart: (options: TerminalCreateOptions) => void;
  onCancel: () => void;
}

interface Choice {
  label: string;
  value: string; // '' = CLI default (flag omitted)
}

type ChipAccent = 'blue' | 'emerald' | 'violet' | 'amber';

/** Full class strings, not `bg-${accent}-600` — Tailwind only emits classes it
 *  can see literally in the source. Typed as a Record so adding an accent
 *  without a class is a compile error instead of a silent fall back to blue. */
const CHIP_ACTIVE_CLASS: Record<ChipAccent, string> = {
  blue: 'bg-blue-500 border-blue-500 text-white',
  emerald: 'bg-emerald-600 border-emerald-600 text-white',
  violet: 'bg-violet-600 border-violet-600 text-white',
  amber: 'bg-amber-500 border-amber-500 text-white',
};

/** Start-button colour per backend; mirrors BACKEND_DISPLAY in lib/backends.ts
 *  (claude blue / kimi violet / agy amber / codex emerald). Record-typed for the
 *  same reason as above — the old ternary chain painted agy blue. */
const START_BUTTON_CLASS: Record<HistoryBackend, string> = {
  claude: 'bg-blue-500 hover:bg-blue-600',
  kimi: 'bg-violet-600 hover:bg-violet-700',
  agy: 'bg-amber-500 hover:bg-amber-600',
  codex: 'bg-emerald-600 hover:bg-emerald-700',
};

const CLAUDE_MODELS: Choice[] = [
  { label: 'Default', value: '' },
  { label: 'Sonnet', value: 'sonnet' },
  { label: 'Opus', value: 'opus' },
  { label: 'Fable', value: 'fable' },
];
const CLAUDE_EFFORTS: Choice[] = [
  { label: 'Default', value: '' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Xhigh', value: 'xhigh' },
  { label: 'Max', value: 'max' },
];
const CLAUDE_PERMISSIONS: Choice[] = [
  { label: 'Default', value: '' },
  { label: 'Auto', value: 'auto' },
  { label: 'Accept edits', value: 'acceptEdits' },
  { label: 'Plan', value: 'plan' },
  { label: "Don't ask", value: 'dontAsk' },
  { label: 'Bypass', value: 'bypassPermissions' },
];
const CODEX_REASONINGS: Choice[] = [
  { label: 'Default', value: '' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Xhigh', value: 'xhigh' },
];
const CODEX_SANDBOXES: Choice[] = [
  { label: 'Default', value: '' },
  { label: 'Read-only', value: 'read-only' },
  { label: 'Workspace', value: 'workspace-write' },
  { label: 'Full access', value: 'danger-full-access' },
];

/** Session-type / model / reasoning / permissions picker shown before spawning. */
const KIMI_PERMISSIONS = [
  { label: 'Default', value: '' },
  { label: 'Yolo', value: 'yolo' },
  { label: 'Auto', value: 'auto' },
  { label: 'Plan', value: 'plan' },
];
// Values mirror AGY_EFFORT_LEVELS / AGY_MODES in lib/backends.ts, which were
// verified against `agy --help` (Antigravity CLI 1.1.8). Note there is no
// 'xhigh' here — agy takes low|medium|high only, unlike claude.
const AGY_EFFORTS: Choice[] = [
  { label: 'Default', value: '' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
];
const AGY_MODES: Choice[] = [
  { label: 'Default', value: '' },
  { label: 'Accept edits', value: 'accept-edits' },
  { label: 'Plan', value: 'plan' },
];

export default function NewSessionPanel({ onStart, onCancel }: NewSessionPanelProps) {
  const [backend, setBackend] = useState<HistoryBackend>('claude');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [sandbox, setSandbox] = useState('');
  const [starting, setStarting] = useState(false);

  const start = () => {
    if (starting) return; // double-tap on a phone must not spawn two sessions
    setStarting(true);
    const options: TerminalCreateOptions = { backend };
    const dir = cwd.trim();
    if (dir) options.cwd = dir;
    if (model) options.model = model;
    // Exhaustive on purpose. agy used to fall into the codex branch and receive
    // reasoningEffort/sandbox, while buildBackendCommand reads effort and
    // permissionMode for it — so its flags never arrived. The `never` check
    // below turns a missing backend into a compile error rather than a silent
    // wrong-branch.
    switch (backend) {
      case 'claude':
        if (effort) options.effort = effort;
        if (permissionMode) options.permissionMode = permissionMode;
        break;
      case 'kimi':
        if (permissionMode) options.permissionMode = permissionMode;
        break;
      case 'agy':
        if (effort) options.effort = effort;            // → --effort
        if (permissionMode) options.permissionMode = permissionMode;  // → --mode
        break;
      case 'codex':
        if (reasoningEffort) options.reasoningEffort = reasoningEffort;
        if (sandbox) options.sandbox = sandbox;
        break;
      default: {
        const unhandled: never = backend;
        throw new Error(`unhandled backend: ${unhandled}`);
      }
    }
    onStart(options);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-lg mx-auto px-5 py-8">
        <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6">
          Start a new session
        </h2>

        <Section label="Session type">
          <ChipRow
            choices={[
              { label: 'Claude', value: 'claude' },
              { label: 'Kimi', value: 'kimi' },
              { label: 'Agy', value: 'agy' },
              { label: 'Codex', value: 'codex' },
            ]}
            value={backend}
            onChange={(v) => setBackend(v as HistoryBackend)}
          />
        </Section>

        <Section label="Working directory">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="~ (home)"
            spellCheck={false}
            autoCapitalize="off"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:border-blue-400"
          />
        </Section>

        {backend === 'kimi' ? (
          <>
            <Section label="Model">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Default (config.toml default_model)"
                spellCheck={false}
                autoCapitalize="off"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:border-violet-400"
              />
            </Section>
            <Section label="Permissions">
              <ChipRow choices={KIMI_PERMISSIONS} value={permissionMode} onChange={setPermissionMode} accent="violet" />
            </Section>
          </>
        ) : backend === 'claude' ? (
          <>
            <Section label="Model">
              <ChipRow choices={CLAUDE_MODELS} value={model} onChange={setModel} />
            </Section>
            <Section label="Reasoning">
              <ChipRow choices={CLAUDE_EFFORTS} value={effort} onChange={setEffort} />
            </Section>
            <Section label="Permissions">
              <ChipRow choices={CLAUDE_PERMISSIONS} value={permissionMode} onChange={setPermissionMode} />
            </Section>
          </>
        ) : backend === 'agy' ? (
          <>
            <Section label="Model">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Default (agy's own default)"
                spellCheck={false}
                autoCapitalize="off"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:border-amber-400"
              />
            </Section>
            <Section label="Reasoning">
              <ChipRow choices={AGY_EFFORTS} value={effort} onChange={setEffort} accent="amber" />
            </Section>
            <Section label="Mode">
              <ChipRow choices={AGY_MODES} value={permissionMode} onChange={setPermissionMode} accent="amber" />
            </Section>
          </>
        ) : (
          <>
            <Section label="Model">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Default (e.g. gpt-5.2-codex)"
                spellCheck={false}
                autoCapitalize="off"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:border-emerald-400"
              />
            </Section>
            <Section label="Reasoning">
              <ChipRow choices={CODEX_REASONINGS} value={reasoningEffort} onChange={setReasoningEffort} accent="emerald" />
            </Section>
            <Section label="Sandbox">
              <ChipRow choices={CODEX_SANDBOXES} value={sandbox} onChange={setSandbox} accent="emerald" />
            </Section>
          </>
        )}

        <div className="flex gap-3 mt-8">
          <button
            onClick={start}
            disabled={starting}
            className={`flex-1 rounded-xl py-3 text-sm font-medium text-white transition-colors disabled:opacity-50 ${START_BUTTON_CLASS[backend]}`}
          >
            {starting ? 'Starting…' : 'Start session'}
          </button>
          <button
            onClick={onCancel}
            className="rounded-xl px-5 py-3 text-sm font-medium text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{label}</div>
      {children}
    </div>
  );
}

function ChipRow({
  choices,
  value,
  onChange,
  accent = 'blue',
}: {
  choices: Choice[];
  value: string;
  onChange: (value: string) => void;
  accent?: ChipAccent;
}) {
  const active = CHIP_ACTIVE_CLASS[accent];
  return (
    <div className="flex flex-wrap gap-2">
      {choices.map((choice) => (
        <button
          key={choice.value}
          onClick={() => onChange(choice.value)}
          className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
            value === choice.value
              ? active
              : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
