'use client';

import type { AccessState } from '@/lib/device-client';

interface AccessGateProps {
  state: Exclude<AccessState, 'approved' | 'unauthorized'>;
  onRetry: () => void;
}

/**
 * Shown when the token was accepted but this device is not on the allowlist.
 *
 * Deliberately says nothing about which devices *are* approved, and offers no
 * way to approve from here — approval only happens from the owner's Telegram
 * link or the Mac. Someone holding a stolen token must find this screen a dead
 * end, while the owner on a new phone gets a clear "go check your phone".
 */
export default function AccessGate({ state, onRetry }: AccessGateProps) {
  const copy = {
    checking: {
      title: 'Checking this device',
      body: 'One moment.',
      hint: null as string | null,
    },
    pending: {
      title: 'Waiting for approval',
      body: 'This device is new, so it has been blocked and the owner has been notified. Approve it from the Telegram message, then reconnect.',
      hint: 'If you did not expect this message, someone else is holding your access token — rotate it.',
    },
    revoked: {
      title: 'Device revoked',
      body: 'This device was revoked by the owner. It cannot connect.',
      hint: null,
    },
    error: {
      title: "Can't reach the server",
      body: 'The device check did not complete. The server may be restarting.',
      hint: null,
    },
  }[state];

  return (
    <div className="h-dvh flex items-center justify-center bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 p-6">
      <div className="w-full max-w-sm flex flex-col gap-4 text-center">
        <div>
          <h1 className="text-lg font-semibold">{copy.title}</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
            {copy.body}
          </p>
        </div>

        {state !== 'checking' && (
          <button
            type="button"
            onClick={onRetry}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            Check again
          </button>
        )}

        {copy.hint && (
          <p className="text-xs text-amber-600 dark:text-amber-500 leading-relaxed">
            {copy.hint}
          </p>
        )}
      </div>
    </div>
  );
}
