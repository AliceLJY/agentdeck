'use client';

import { useState, useEffect, useCallback } from 'react';

interface TerminalKeyBarProps {
  onInput: (data: string) => void;
  visible: boolean;
}

const KEYS: Record<string, string> = {
  Esc: '\x1b',
  Tab: '\t',
  'Ctrl+C': '\x03',
  'Ctrl+D': '\x04',
};

const ARROW_KEYS: Record<string, string> = {
  '\u2191': '\x1b[A',  // Up
  '\u2193': '\x1b[B',  // Down
  '\u2190': '\x1b[D',  // Left
  '\u2192': '\x1b[C',  // Right
};

export default function TerminalKeyBar({ onInput, visible }: TerminalKeyBarProps) {
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);

  useEffect(() => {
    setIsTouchDevice(navigator.maxTouchPoints > 0);
  }, []);

  // When Ctrl toggle is active, intercept keyboard input
  useEffect(() => {
    if (!ctrlActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        // Compute Ctrl code: A=1, B=2, ... Z=26
        const upper = e.key.toUpperCase();
        const code = upper.charCodeAt(0) - 64;
        if (code >= 1 && code <= 26) {
          onInput(String.fromCharCode(code));
        }
        setCtrlActive(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [ctrlActive, onInput]);

  const handleKey = useCallback(
    (data: string) => {
      onInput(data);
    },
    [onInput],
  );

  const handleCtrlToggle = useCallback(() => {
    setCtrlActive((prev) => !prev);
  }, []);

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

      {/* Ctrl toggle */}
      <button
        onTouchStart={(e) => {
          e.preventDefault();
          handleCtrlToggle();
        }}
        className={`flex-1 min-h-[44px] flex items-center justify-center rounded-lg
          text-xs font-medium border select-none transition-colors
          ${
            ctrlActive
              ? 'bg-blue-500 dark:bg-blue-600 text-white border-blue-600 dark:border-blue-500'
              : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 active:bg-gray-300 dark:active:bg-gray-600'
          }`}
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        Ctrl
      </button>

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
