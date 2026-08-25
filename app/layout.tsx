import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentDeck',
  description: 'Web terminal for Claude Code, Kimi Code, Agy and Codex CLIs',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'AgentDeck',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  // Android Chrome 108+ defaults to resizes-visual: the soft keyboard only
  // shrinks the visual viewport, the layout viewport (and so h-dvh and the
  // whole flex column) stays put, and the keyboard simply covers the bottom
  // of the page. Chat survives that because its input is a real DOM element
  // the browser scrolls into view on focus — the terminal's "input box" is
  // characters painted inside the xterm canvas, which the browser will not
  // move for. resizes-content shrinks the layout viewport instead, so the
  // terminal + key bar shrink above the keyboard and the existing
  // ResizeObserver → refit → tmux resize chain repaints the TUI to fit.
  // iOS ignores this field entirely.
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`,
          }}
        />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
