'use client';

import { useState } from 'react';

interface TokenGateProps {
  onSubmit: (token: string) => void;
}

/**
 * Access gate shown when no token is available.
 *
 * The token is NEVER embedded in the server-rendered HTML — the user supplies
 * it via a `?token=` link (scrubbed from the URL on load) or by typing it here.
 * That keeps anyone who can merely reach the page from reading the token and
 * then the machine's Claude/Codex history through the authenticated APIs.
 */
export default function TokenGate({ onSubmit }: TokenGateProps) {
  const [value, setValue] = useState('');

  return (
    <div className="h-dvh flex items-center justify-center bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = value.trim();
          if (trimmed) onSubmit(trimmed);
        }}
        className="w-full max-w-sm flex flex-col gap-4"
      >
        <div className="text-center">
          <h1 className="text-lg font-semibold">CC Terminal</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Enter your access token to connect
          </p>
        </div>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Access token"
          autoComplete="current-password"
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-400 dark:focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
        >
          Connect
        </button>
        <p className="text-center text-xs text-gray-400 dark:text-gray-500">
          Saved to this browser. Open with <code>?token=…</code> to skip this step.
        </p>
      </form>
    </div>
  );
}
