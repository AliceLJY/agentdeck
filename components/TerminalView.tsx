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
import type { ServerMessage, TerminalCreateOptions } from '@/lib/types';
import type { HistoryBackend } from '@/lib/backends';
import { bracketed } from '@/lib/paste';
import { terminalWsUrl } from '@/lib/device-client';

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
  createOptions?: TerminalCreateOptions | null;
  token: string;
  theme: 'light' | 'dark';
  onSessionCreated?: (id: string, title: string, backend: HistoryBackend) => void;
  /** `lastWords` is set only when the CLI died within seconds of spawning,
   *  i.e. it refused to start and printed why. The caller uses it to decide
   *  whether the view may close — that reason has to stay readable. */
  onSessionExited?: (id: string, lastWords?: string) => void;
  onInput?: (sendFn: (data: string) => void) => void;
}

export interface TerminalViewHandle {
  sendInput: (data: string) => void;
}

// ─── Component ───

const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(
    { sessionId, createOptions, token, theme, onSessionCreated, onSessionExited, onInput },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerminal | null>(null);
    const fitAddonRef = useRef<FitAddonType | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const currentSessionIdRef = useRef<string | null>(sessionId);
    const reconnectAttemptsRef = useRef(0);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // A 'create' may already be in flight when the socket drops (common on
    // phones) — a reconnect must never fire a second one.
    const createSentRef = useRef(false);

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
      let detachTouchScroll: (() => void) | null = null;
      let detachViewportWatch: (() => void) | null = null;
      // A refit resizes the character grid, and xterm snaps the viewport back
      // to the bottom whenever it resizes. On a phone the viewport height
      // changes *while scrolling* (the browser chrome collapses), so a naive
      // refit fires mid-gesture and yanks the user back to the newest output —
      // indistinguishable from "scrolling is broken". Hold refits for the
      // duration of a drag and its momentum, then apply once at the end.
      let scrollActive = false;
      let refitPending = false;
      let refitDebounce: ReturnType<typeof setTimeout> | null = null;
      // Assigned inside init(). Hoisted to this scope so connectWebSocket can
      // reach it too — the post-attach re-measure used to call fit() directly,
      // which is exactly what threw away the scroll position on every attach.
      let refit: () => void = () => {};
      // What xterm itself last put on the wire, and when. xterm registers its
      // own textarea 'input' listener inside open(), also in the capture
      // phase, so it always runs *before* the IME patch below — by the time
      // the patch sees an event, anything xterm decided to send is already
      // gone. Recording it here is what lets the patch tell "xterm dropped
      // this keystroke" (send it) from "xterm already sent it" (stay quiet).
      // The sequence number exists so one emission can only be matched once:
      // typing the same character twice in a row must not let the first
      // emission excuse the second.
      let lastXtermData = '';
      let lastXtermSeq = 0;
      let lastXtermAt = 0;
      let matchedXtermSeq = 0;

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
          lineHeight: isSmallScreen ? 1.15 : 1,
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
            console.warn('[agentdeck] WebGL not available, using DOM renderer');
          }
        }

        if (disposed || !containerRef.current) return;

        term.open(containerRef.current);
        fitAddon.fit();

        termRef.current = term;
        fitAddonRef.current = fitAddon;

        // ─── iOS IME fix ───
        // xterm 6.0.0 on iOS 26 drops most 'input' events (its value-diff logic is
        // unreliable in this environment — English 5-char bursts only send 1 char,
        // Chinese punctuation goes missing). Attach our own capture-phase listener
        // on xterm's hidden textarea that sends e.data directly to the WebSocket
        // and clears the textarea to prevent value accumulation.
        //
        // This listener can only ever *fill in gaps*, never lead. xterm's own
        // 'input' listener is registered in open() and is capture-phase too, so
        // it runs first, and a keystroke it handled normally is already on the
        // wire. Sending unconditionally is what made every character arrive
        // twice on any platform where xterm works fine — "把" as "把把",
        // ~/Projects as ~/PProjects. This used to end in a
        // stopImmediatePropagation() meant to keep xterm out of it, which never
        // could: it stops *later* listeners, and xterm's had already run.
        const helperTa = containerRef.current?.querySelector<HTMLTextAreaElement>(
          '.xterm-helper-textarea',
        );
        if (helperTa && !helperTa.dataset.imePatched) {
          helperTa.dataset.imePatched = 'true';
          helperTa.addEventListener(
            'input',
            (ev) => {
              const ie = ev as InputEvent;
              // Text insertion only; deletions flow via keydown (Backspace),
              // which xterm handles correctly. `insertFromPaste` covers an
              // external keyboard's Cmd+V and any keyboard whose paste key
              // routes through the textarea — without it a paste was dropped
              // silently here.
              const isPaste = ie.inputType === 'insertFromPaste';
              if (ie.inputType !== 'insertText' && !isPaste) return;
              // Safari fills `data` when typing but can leave it null on paste,
              // where the text sits in dataTransfer instead.
              const text = ie.data ?? ie.dataTransfer?.getData('text') ?? '';
              if (!text) return;
              // Did xterm already send this very keystroke, moments ago, in its
              // own pass over this event? Then this listener has nothing to add.
              // A paste is compared against its bracketed form as well, since
              // that is what xterm emits with bracketed paste mode on.
              //
              // The window only has to span one event dispatch — keydown and
              // its input event are microseconds apart — but it is generous
              // because the two failure modes are not symmetric: too tight and
              // a stalled main thread brings the doubling back, too loose and
              // a keystroke is dropped only if an identical one was pasted
              // moments earlier *and* xterm dropped this one.
              const alreadySent =
                lastXtermSeq > matchedXtermSeq
                && performance.now() - lastXtermAt < 250
                && (lastXtermData === text || lastXtermData === bracketed(text));
              if (alreadySent) {
                matchedXtermSeq = lastXtermSeq;
              } else {
                const ws = wsRef.current;
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'input', data: isPaste ? bracketed(text) : text }));
                }
              }
              helperTa.value = '';
            },
            true,
          );
        }

        // ─── Touch scrolling ───
        // xterm.js on iOS only scrolls when the drag *starts on blank space*
        // (xtermjs/xterm.js#3613); a drag that starts on a glyph is taken as a
        // text-selection gesture and the viewport never moves. A terminal full
        // of output has no blank space to grab, so the history is effectively
        // unreachable — Android is unaffected, which is why it only bites on
        // the iPhone. Upstream has had this open for years (#1101, #5377), so
        // intercept the gesture here and drive the buffer ourselves. This is
        // what Terminal.app does too: the app layer owns the scroll.
        if (isTouchDevice && containerRef.current) {
          const el = containerRef.current;
          const MOVE_THRESHOLD_PX = 6;   // below this a touch is still a tap
          let lastY = 0;
          let carry = 0;                 // sub-line remainder, keeps drags smooth
          let dragging = false;
          let velocity = 0;              // lines per frame, for the flick
          let lastMoveAt = 0;
          let momentum: number | null = null;

          const lineHeight = () => {
            const screen = el.querySelector<HTMLElement>('.xterm-screen');
            const rows = term.rows || 24;
            const h = screen ? screen.clientHeight / rows : 0;
            return h > 0 ? h : 20;
          };

          const stopMomentum = () => {
            if (momentum !== null) {
              cancelAnimationFrame(momentum);
              momentum = null;
            }
          };

          // Any refit queued by the browser chrome collapsing mid-gesture is
          // deferred to here, so the grid only changes size once the user has
          // stopped moving and the viewport has settled.
          const endScroll = () => {
            scrollActive = false;
            if (refitPending) {
              refitPending = false;
              refit();
            }
          };

          const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length !== 1) return;
            stopMomentum();
            scrollActive = true;
            lastY = e.touches[0].clientY;
            carry = 0;
            velocity = 0;
            dragging = false;
            lastMoveAt = performance.now();
          };

          const onTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 1) return;
            const y = e.touches[0].clientY;
            const dy = lastY - y;        // finger up ⇒ move toward newer output
            if (!dragging && Math.abs(dy) < MOVE_THRESHOLD_PX) return;
            dragging = true;
            // Past the threshold this is a scroll, not a selection or a tap.
            e.preventDefault();

            const h = lineHeight();
            carry += dy / h;
            const lines = Math.trunc(carry);
            if (lines !== 0) {
              carry -= lines;
              term.scrollLines(lines);
            }

            const now = performance.now();
            const dt = now - lastMoveAt;
            if (dt > 0) velocity = (dy / h) * (16 / dt);   // normalise to ~60fps
            lastMoveAt = now;
            lastY = y;
          };

          const onTouchEnd = () => {
            if (!dragging) { endScroll(); return; }
            dragging = false;
            // Ignore a stale flick: lifting after a pause should just stop.
            if (performance.now() - lastMoveAt > 100 || Math.abs(velocity) < 0.4) {
              endScroll();
              return;
            }

            const step = () => {
              velocity *= 0.94;
              if (Math.abs(velocity) < 0.08) {
                momentum = null;
                endScroll();
                return;
              }
              carry += velocity;
              const lines = Math.trunc(carry);
              if (lines !== 0) {
                carry -= lines;
                term.scrollLines(lines);
              }
              momentum = requestAnimationFrame(step);
            };
            momentum = requestAnimationFrame(step);
          };

          el.addEventListener('touchstart', onTouchStart, { passive: true });
          el.addEventListener('touchmove', onTouchMove, { passive: false });
          el.addEventListener('touchend', onTouchEnd, { passive: true });
          el.addEventListener('touchcancel', onTouchEnd, { passive: true });
          detachTouchScroll = () => {
            stopMomentum();
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchEnd);
          };
        }

        // ─── WebSocket Connection ───
        connectWebSocket(term, fitAddon);

        // ─── Keeping the grid the size of the screen ───
        refit = () => {
          if (disposed || !fitAddon || !term.element) return;
          // Never change the grid under a moving finger — queue it instead.
          if (scrollActive) {
            refitPending = true;
            return;
          }

          const dims = fitAddon.proposeDimensions();
          if (!dims || !dims.cols || !dims.rows) return;
          // Same geometry ⇒ do nothing. This is the common case on a phone:
          // the browser chrome collapsing by a few pixels usually lands on the
          // same row count, and skipping the resize is what keeps the viewport
          // (and therefore the user's scroll position) where it was.
          if (dims.cols === term.cols && dims.rows === term.rows) return;

          // A real resize does snap the viewport to the bottom, so restore the
          // reading position afterwards — unless the user was already at the
          // bottom, where following new output is the wanted behaviour.
          const before = term.buffer.active;
          const wasAtBottom = before.viewportY >= before.baseY;
          const savedViewportY = before.viewportY;

          fitAddon.fit();

          if (!wasAtBottom) {
            const after = term.buffer.active;
            term.scrollToLine(Math.max(0, Math.min(savedViewportY, after.baseY)));
          }

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
        };

        // A fold/unfold or a rotation changes the viewport in steps, and the
        // frame right after the event often still reports the old geometry —
        // measure again once it has settled. Unlike the chat view, which is
        // plain DOM and reflows on its own, the terminal is a character grid
        // that only resizes when told to, so a missed event leaves it stuck at
        // the old column count on a screen that is now much wider.
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        const refitAfterSettle = () => {
          refit();
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(refit, 250);
        };

        // ResizeObserver fires once per frame while the viewport animates, so
        // measuring on every callback means dozens of resizes during a single
        // chrome collapse. Debounce to the end of the movement.
        const refitDebounced = () => {
          if (refitDebounce) clearTimeout(refitDebounce);
          refitDebounce = setTimeout(refit, 120);
        };
        resizeObserver = new ResizeObserver(refitDebounced);
        resizeObserver.observe(containerRef.current);

        window.addEventListener('resize', refitAfterSettle);
        window.visualViewport?.addEventListener('resize', refitAfterSettle);
        window.screen?.orientation?.addEventListener?.('change', refitAfterSettle);
        detachViewportWatch = () => {
          if (settleTimer) clearTimeout(settleTimer);
          window.removeEventListener('resize', refitAfterSettle);
          window.visualViewport?.removeEventListener('resize', refitAfterSettle);
          window.screen?.orientation?.removeEventListener?.('change', refitAfterSettle);
        };
      };

      const connectWebSocket = (term: XTerminal, fitAddon: FitAddonType) => {
        if (disposed) return;

        const ws = new WebSocket(terminalWsUrl(token));
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttemptsRef.current = 0;

          const sid = currentSessionIdRef.current;
          if (!sid || sid.startsWith('__new__')) {
            if (createSentRef.current) {
              term.write('\r\n\x1b[33m[Reconnected while the session was still being created — go Back and pick it from the list, or retry.]\x1b[0m\r\n');
              return;
            }
            createSentRef.current = true;
            // Create new session on server
            ws.send(
              JSON.stringify({
                type: 'create',
                cols: term.cols,
                rows: term.rows,
                backend: createOptions?.backend,
                cwd: createOptions?.cwd,
                resumeSessionId: createOptions?.resumeSessionId,
                title: createOptions?.title,
                model: createOptions?.model,
                permissionMode: createOptions?.permissionMode,
                effort: createOptions?.effort,
                sandbox: createOptions?.sandbox,
                reasoningEffort: createOptions?.reasoningEffort,
              }),
            );
          } else {
            // Attach to existing server session, telling it how wide this
            // client actually is — the session may have been created on a
            // screen of an entirely different size.
            ws.send(
              JSON.stringify({
                type: 'attach',
                sessionId: sid,
                cols: term.cols,
                rows: term.rows,
              }),
            );
          }

          // The first measurement can land while the view is still animating
          // in, so the geometry sent above may be a mid-transition one. Measure
          // again once it has settled and correct the server if it moved.
          //
          // Route this through refit() rather than calling fit() directly. On a
          // re-attach the geometry is usually unchanged, and refit skips the
          // resize entirely in that case; when it did change, refit restores
          // the reading position afterwards. The direct fit() that used to live
          // here is why every attach snapped the viewport to the bottom: the
          // grid measured correctly and threw away where the user was reading,
          // which reads as "the terminal will not scroll".
          setTimeout(() => {
            if (disposed) return;
            refit();
          }, 300);
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
                onSessionCreated?.(msg.sessionId, msg.title, msg.backend);
                break;

              case 'exit':
                term.write('\r\n\x1b[33m[Process exited]\x1b[0m\r\n');
                if (msg.lastOutput) {
                  term.write(`\x1b[90m${msg.lastOutput.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
                }
                onSessionExited?.(msg.sessionId, msg.lastOutput);
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

              case 'taken_over':
                term.write('\r\n\x1b[33m[This session was taken over by another device. This view is now read-only — reattach to take it back.]\x1b[0m\r\n');
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

        // Wire terminal input to WebSocket. Every emission is also recorded for
        // the IME patch in init() — that is how it knows whether xterm has
        // already covered the keystroke it is looking at. Recorded even when the
        // socket is closed: what matters there is that xterm handled the event,
        // not that the bytes made it out.
        term.onData((data) => {
          lastXtermData = data;
          lastXtermSeq++;
          lastXtermAt = performance.now();
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

        if (refitDebounce) {
          clearTimeout(refitDebounce);
        }

        detachTouchScroll?.();
        detachViewportWatch?.();

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
