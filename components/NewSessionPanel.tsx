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
    if (backend === 'claude') {
      if (effort) options.effort = effort;
      if (permissionMode) options.permissionMode = permissionMode;
    } else {
      if (reasoningEffort) options.reasoningEffort = reasoningEffort;
      if (sandbox) options.sandbox = sandbox;
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
            choices={[{ label: 'Claude', value: 'claude' }, { label: 'Codex', value: 'codex' }]}
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

        {backend === 'claude' ? (
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
            className={`flex-1 rounded-xl py-3 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
              backend === 'codex' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-500 hover:bg-blue-600'
            }`}
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
  accent?: 'blue' | 'emerald';
}) {
  const active = accent === 'emerald'
    ? 'bg-emerald-600 border-emerald-600 text-white'
    : 'bg-blue-500 border-blue-500 text-white';
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
