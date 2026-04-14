'use client';

interface WelcomeScreenProps {
  onNewSession: () => void;
}

export default function WelcomeScreen({ onNewSession }: WelcomeScreenProps) {
  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="text-center max-w-sm px-6">
        {/* Terminal icon */}
        <div className="text-6xl mb-6 select-none">{'>_'}</div>

        <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-2">
          CC Terminal
        </h2>
        <p className="text-gray-500 dark:text-gray-400 mb-8">
          Web terminal for Claude Code
        </p>

        <button
          onClick={onNewSession}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl
            bg-blue-500 hover:bg-blue-600
            text-white font-medium text-sm
            transition-colors shadow-sm"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Terminal Session
        </button>

        <p className="text-xs text-gray-400 dark:text-gray-500 mt-6 leading-relaxed">
          Each session runs Claude Code in full interactive mode.
          <br />
          Tool approvals, /commands, and Ctrl+C all work.
        </p>
      </div>
    </div>
  );
}
