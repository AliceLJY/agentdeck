'use client';

import {
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { FitAddon as FitAddonType } from '@xterm/addon-fit';
import type { ServerMessage } from '@/lib/types';

// ─── Terminal Themes ───

const darkTheme = {
  background: '#1a1a2e',
  foreground: '#e8e8e8',
  cursor: '#e8e8e8',
  cursorAccent: '#1a1a2e',
  selectionBackground: '#44475a80',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
};

const lightTheme = {
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#383a42',
  cursorAccent: '#fafafa',
  selectionBackground: '#bfceff80',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#fafafa',
};

// ─── Props ───

interface TerminalViewProps {
  sessionId: string | null;
  token: string;
  theme: 'light' | 'dark';
  onSessionCreated?: (id: string, title: string) => void;
  onSessionExited?: (id: string) => void;
  onInput?: (sendFn: (data: string) => void) => void;
}

export interface TerminalViewHandle {
  sendInput: (data: string) => void;
}

// ─── Component ───

const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(
    { sessionId, token, theme, onSessionCreated, onSessionExited, onInput },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerminal | null>(null);
    const fitAddonRef = useRef<FitAddonType | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const currentSessionIdRef = useRef<string | null>(sessionId);
    const reconnectAttemptsRef = useRef(0);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Keep sessionId ref in sync
    useEffect(() => {
      currentSessionIdRef.current = sessionId;
    }, [sessionId]);

    // Send input data to the WebSocket
    const sendInput = useCallback((data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    }, []);

    // Expose sendInput via ref
    useImperativeHandle(ref, () => ({ sendInput }), [sendInput]);

    // Notify parent of sendInput function for KeyBar
    useEffect(() => {
      if (onInput) {
        onInput(sendInput);
      }
    }, [onInput, sendInput]);

    // ─── Initialize Terminal ───
    useEffect(() => {
      if (!containerRef.current) return;

      let disposed = false;
      let term: XTerminal;
      let fitAddon: FitAddonType;
      let resizeObserver: ResizeObserver | null = null;

      const init = async () => {
        // Dynamic import to avoid SSR issues
        const { Terminal } = await import('@xterm/xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        const { WebLinksAddon } = await import('@xterm/addon-web-links');

        if (disposed) return;

        // Detect touch devices for renderer (WebGL garbles text on iOS/iPadOS Safari)
        // iPadOS 13+ reports "Macintosh" in UA, so we use maxTouchPoints to catch it
        // Real Macs have maxTouchPoints=0, iPads have 5
        const isTouchDevice = /iPhone|iPod|Android/i.test(navigator.userAgent)
          || navigator.maxTouchPoints > 1;
        const isSmallScreen = window.innerWidth < 768;

        term = new Terminal({
          cursorBlink: true,
          fontSize: isSmallScreen ? 14 : 16,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          allowProposedApi: true,
          theme: theme === 'dark' ? darkTheme : lightTheme,
          scrollback: 10000,
          convertEol: false,
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());

        // WebGL renderer — non-touch devices only (causes garbled text on iOS/iPadOS Safari)
        if (!isTouchDevice) {
          try {
            const { WebglAddon } = await import('@xterm/addon-webgl');
            const webgl = new WebglAddon();
            webgl.onContextLoss(() => {
              webgl.dispose();
            });
            term.loadAddon(webgl);
          } catch {
            console.warn('[cc-terminal] WebGL not available, using DOM renderer');
          }
        }

        if (disposed || !containerRef.current) return;

        term.open(containerRef.current);
        fitAddon.fit();

        termRef.current = term;
        fitAddonRef.current = fitAddon;

        // ─── WebSocket Connection ───
        connectWebSocket(term, fitAddon);

        // ─── ResizeObserver ───
        resizeObserver = new ResizeObserver(() => {
          if (fitAddon && term.element) {
            fitAddon.fit();
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'resize',
                  cols: term.cols,
                  rows: term.rows,
                }),
              );
            }
          }
        });
        resizeObserver.observe(containerRef.current);
      };

      const connectWebSocket = (term: XTerminal, fitAddon: FitAddonType) => {
        if (disposed) return;

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(
          `${protocol}//${location.host}/ws/terminal?token=${encodeURIComponent(token)}`,
        );
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttemptsRef.current = 0;

          const sid = currentSessionIdRef.current;
          if (!sid || sid === '__new__') {
            // Create new session on server
            ws.send(
              JSON.stringify({
                type: 'create',
                cols: term.cols,
                rows: term.rows,
              }),
            );
          } else {
            // Attach to existing server session
            ws.send(
              JSON.stringify({
                type: 'attach',
                sessionId: sid,
              }),
            );
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data) as ServerMessage;

            switch (msg.type) {
              case 'output':
                // Strip alt screen switch sequences so xterm stays in normal buffer,
                // enabling browser-native scrollback through TUI history.
                term.write(msg.data.replace(/\x1b\[\?(1049|1047|47)[hl]/g, ''));
                break;

              case 'created':
                currentSessionIdRef.current = msg.sessionId;
                onSessionCreated?.(msg.sessionId, msg.title);
                break;

              case 'exit':
                term.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
                onSessionExited?.(msg.sessionId);
                break;

              case 'error':
                term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
                // If session not found (server restarted), notify parent to clean up
                if (msg.message.includes('not found') && currentSessionIdRef.current) {
                  onSessionExited?.(currentSessionIdRef.current);
                }
                break;

              case 'sessions':
                // Session list is handled by the parent component
                break;
            }
          } catch {
            // Ignore unparseable messages
          }
        };

        ws.onclose = () => {
          if (disposed) return;

          // Reconnect with exponential backoff (1s, 2s, 4s)
          if (reconnectAttemptsRef.current < 3) {
            const delay = Math.pow(2, reconnectAttemptsRef.current) * 1000;
            reconnectAttemptsRef.current++;
            term.write(
              `\r\n\x1b[33m[Disconnected. Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`,
            );
            reconnectTimerRef.current = setTimeout(() => {
              connectWebSocket(term, fitAddon);
            }, delay);
          } else {
            term.write(
              '\r\n\x1b[31m[Disconnected. Refresh the page to reconnect.]\x1b[0m\r\n',
            );
          }
        };

        ws.onerror = () => {
          // onclose will fire after this
        };

        // Wire terminal input to WebSocket
        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }));
          }
        });
      };

      init();

      // Cleanup
      return () => {
        disposed = true;

        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }

        if (resizeObserver) {
          resizeObserver.disconnect();
        }

        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }

        if (termRef.current) {
          termRef.current.dispose();
          termRef.current = null;
        }

        fitAddonRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    // ─── Theme Sync ───
    useEffect(() => {
      if (termRef.current) {
        termRef.current.options.theme =
          theme === 'dark' ? darkTheme : lightTheme;
      }
    }, [theme]);

    return (
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
      />
    );
  },
);

export default TerminalView;
