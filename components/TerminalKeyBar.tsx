'use client';

import { useState, useEffect, useCallback } from 'react';

interface TerminalKeyBarProps {
  onInput: (data: string) => void;
  visible: boolean;
}

const KEYS: Record<string, string> = {
  Esc: '\x1b',
  Tab: '\t',
  Enter: '\r',
  Clear: '\x15',    // Ctrl+U — clear the current input line
  'Ctrl+C': '\x03',
};

const ARROW_KEYS: Record<string, string> = {
  '\u2191': '\x1b[A',  // Up
  '\u2193': '\x1b[B',  // Down
  '\u2190': '\x1b[D',  // Left
  '\u2192': '\x1b[C',  // Right
};

export default function TerminalKeyBar({ onInput, visible }: TerminalKeyBarProps) {
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    setIsTouchDevice(navigator.maxTouchPoints > 0);
  }, []);

  const handleKey = useCallback(
    (data: string) => {
      onInput(data);
    },
    [onInput],
  );

  // Only render on touch devices when visible
  if (!isTouchDevice || !visible) return null;

  return (
    <div
      className="fixed left-0 right-0 z-50 flex items-center gap-1 px-2 py-1.5
        bg-gray-100/95 dark:bg-gray-800/95 backdrop-blur-sm
        border-t border-gray-200 dark:border-gray-700
        pb-[max(0.375rem,env(safe-area-inset-bottom))]"
      style={{ bottom: 0, userSelect: 'none', WebkitUserSelect: 'none' }}
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
