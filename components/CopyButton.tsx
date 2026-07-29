'use client';

import { useCallback, useState } from 'react';
import { writeClipboard } from '@/lib/paste';

/**
 * One-tap copy. Selecting text by hand inside a terminal or a scrolling chat
 * bubble is the worst part of using this on a phone, so anything worth copying
 * gets a button instead.
 *
 * `getText` is called on tap rather than passed as a string so callers can
 * read from a DOM node (a rendered code block) without tracking its content.
 */
export default function CopyButton({
  getText,
  label = 'Copy',
  iconOnly = false,
  className = '',
}: {
  getText: () => string;
  label?: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const onCopy = useCallback(async () => {
    const ok = await writeClipboard(getText());
    setState(ok ? 'ok' : 'fail');
    setTimeout(() => setState('idle'), 1200);
  }, [getText]);

  const tone =
    state === 'ok'
      ? 'text-emerald-500'
      : state === 'fail'
        ? 'text-red-500'
        : 'text-gray-400 dark:text-gray-500';

  if (iconOnly) {
    return (
      <button
        onClick={onCopy}
        title={label}
        aria-label={label}
        className={`h-7 w-7 flex items-center justify-center rounded-md
          bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm
          border border-gray-200 dark:border-gray-700 ${tone} ${className}`}
      >
        {state === 'ok' ? <span className="text-xs">✓</span> : <ClipboardIcon />}
      </button>
    );
  }

  return (
    <button
      onClick={onCopy}
      className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${tone}
        hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${className}`}
    >
      {state === 'ok' ? <span>✓</span> : <ClipboardIcon />}
      <span>{state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}</span>
    </button>
  );
}

function ClipboardIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
      />
    </svg>
  );
}
