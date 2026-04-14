'use client';

type Theme = 'light' | 'dark' | 'system';

interface ThemeToggleProps {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const icons: Record<Theme, string> = {
  light: '\u2600\uFE0F',   // sun
  dark: '\uD83C\uDF19',     // moon
  system: '\uD83D\uDCBB',   // computer
};

const labels: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const next: Record<Theme, Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

export default function ThemeToggle({ theme, setTheme }: ThemeToggleProps) {
  return (
    <button
      onClick={() => setTheme(next[theme])}
      className="flex items-center gap-2 px-3 py-2 rounded-lg
        text-sm text-gray-600 dark:text-gray-400
        hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors w-full"
      title={`Theme: ${labels[theme]}`}
    >
      <span className="text-base">{icons[theme]}</span>
      <span>{labels[theme]}</span>
    </button>
  );
}
