'use client';

import { useState, useEffect, useCallback } from 'react';
import { bracketed, readClipboard } from '@/lib/paste';

interface TerminalKeyBarProps {
  onInput: (data: string) => void;
  visible: boolean;
}

const KEYS: Record<string, string> = {
  Esc: '\x1b',
  Tab: '\t',
  Enter: '\r',
  Clear: '\x15',    // Ctrl+U — clear the current input line
  '^C': '\x03',
};

const ARROW_KEYS: Record<string, string> = {
  '\u2191': '\x1b[A',  // Up
  '\u2193': '\x1b[B',  // Down
  '\u2190': '\x1b[D',  // Left
  '\u2192': '\x1b[C',  // Right
};

export default function TerminalKeyBar({ onInput, visible }: TerminalKeyBarProps) {
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [canPaste, setCanPaste] = useState(false);
  const [pasteState, setPasteState] = useState<'idle' | 'ok' | 'fail'>('idle');

  useEffect(() => {
    setIsTouchDevice(navigator.maxTouchPoints > 0);
    // Clipboard reads need a secure context. Over the plain-HTTP fallback the
    // button would always fail, so it is simply not offered there.
    setCanPaste(window.isSecureContext && typeof navigator.clipboard?.readText === 'function');
  }, []);

  const handleKey = useCallback(
    (data: string) => {
      onInput(data);
    },
    [onInput],
  );

  // iOS gives no way to reach xterm's hidden textarea by long-press, so the
  // system paste menu never appears over the terminal. This button is the way
  // in: read the clipboard on an explicit tap and send it as a bracketed paste.
  const handlePaste = useCallback(async () => {
    const text = await readClipboard();
    if (!text) {
      setPasteState('fail');
      setTimeout(() => setPasteState('idle'), 1400);
      return;
    }
    onInput(bracketed(text));
    setPasteState('ok');
    setTimeout(() => setPasteState('idle'), 900);
  }, [onInput]);

  // Only render on touch devices when visible
  if (!isTouchDevice || !visible) return null;

  return (
    // In normal flow on purpose — this bar used to be `fixed bottom-0`, which
    // floats OVER the terminal: the flex column doesn't know it exists, the
    // terminal keeps the full height, and xterm's fit() hands out ~3 rows that
    // are physically behind the bar. Kimi/Codex/Agy draw their input box on
    // those exact rows (bottom of the TUI screen), so the box sat invisible
    // while typing still worked; Claude's classic renderer keeps its prompt in
    // the content flow, which is why CC alone looked fine. As a flex child the
    // bar takes real height, the terminal shrinks, and the row count is honest.
    <div
      className="shrink-0 flex items-center gap-1 px-2 py-1.5
        bg-gray-100/95 dark:bg-gray-800/95 backdrop-blur-sm
        border-t border-gray-200 dark:border-gray-700
        pb-[max(0.375rem,env(safe-area-inset-bottom))]"
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      {/* Named keys */}
      {Object.entries(KEYS).map(([label, seq]) => (
        <button
          key={label}
          onTouchStart={(e) => {
            e.preventDefault();
            handleKey(seq);
          }}
          className="flex-1 min-h-[44px] flex items-center justify-center rounded-lg
            text-xs font-medium
            bg-white dark:bg-gray-700
            text-gray-700 dark:text-gray-200
            active:bg-gray-300 dark:active:bg-gray-600
            border border-gray-300 dark:border-gray-600
            select-none"
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        >
          {label}
        </button>
      ))}

      {/* Paste from clipboard */}
      {canPaste && (
        <button
          // pointerdown default is suppressed so the tap does not steal focus
          // from the terminal; the click still fires and carries the user
          // activation that iOS requires for a clipboard read.
          onPointerDown={(e) => e.preventDefault()}
          onClick={handlePaste}
          title="Paste from clipboard"
          aria-label="Paste from clipboard"
          className={`w-[44px] min-h-[44px] flex items-center justify-center rounded-lg
            bg-white dark:bg-gray-700
            active:bg-gray-300 dark:active:bg-gray-600
            border border-gray-300 dark:border-gray-600
            select-none ${
              pasteState === 'ok'
                ? 'text-emerald-500'
                : pasteState === 'fail'
                  ? 'text-red-500'
                  : 'text-gray-700 dark:text-gray-200'
            }`}
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        >
          {pasteState === 'ok' ? (
            <span className="text-base">✓</span>
          ) : pasteState === 'fail' ? (
            <span className="text-base">✕</span>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
          )}
        </button>
      )}

      {/* Arrow keys */}
      {Object.entries(ARROW_KEYS).map(([label, seq]) => (
        <button
          key={label}
          onTouchStart={(e) => {
            e.preventDefault();
            handleKey(seq);
          }}
          className="w-[44px] min-h-[44px] flex items-center justify-center rounded-lg
            text-base
            bg-white dark:bg-gray-700
            text-gray-700 dark:text-gray-200
            active:bg-gray-300 dark:active:bg-gray-600
            border border-gray-300 dark:border-gray-600
            select-none"
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
