import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { TerminalManager } from './terminal-manager';
import { ResumeHeldError } from './terminal-manager';
import type { TranscriptHub } from './transcript-hub';
import type { ClientMessage } from './types';
import { DEFAULT_COLS, DEFAULT_ROWS } from './types';

type TerminalManagerPort = Pick<
  TerminalManager,
  'attach' | 'clearHistory' | 'create' | 'detach' | 'kill' | 'list' | 'resize' | 'write'
>;

type TranscriptHubPort = Pick<
  TranscriptHub,
  'attachChat' | 'detachChat' | 'nudgeDiscovery' | 'release' | 'track' | 'untrack' | 'watchStatus'
>;

export interface WebSocketHandlerDependencies {
  terminalManager: TerminalManagerPort;
  transcriptHub: TranscriptHubPort;
  schedule?: (callback: () => void, delayMs: number) => void;
}

/**
 * Handles a WebSocket connection for the terminal protocol.
 * One WS per browser tab. Multiple sessions share the WS via attach/detach.
 */
export function handleWebSocket(
  ws: WebSocket,
  dependencies: WebSocketHandlerDependencies,
): void {
  const { terminalManager, transcriptHub } = dependencies;
  const schedule = dependencies.schedule ?? ((callback, delayMs) => {
    setTimeout(callback, delayMs);
  });
  let currentSessionId: string | null = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;

      switch (msg.type) {
        case 'create': {
          const id = uuidv4();
          const cols = msg.cols || DEFAULT_COLS;
          const rows = msg.rows || DEFAULT_ROWS;

          let info;
          try {
            info = terminalManager.create(id, cols, rows, {
              backend: msg.backend,
              cwd: msg.cwd,
              resumeSessionId: msg.resumeSessionId,
              takeover: msg.takeover,
              title: msg.title,
              model: msg.model,
              permissionMode: msg.permissionMode,
              effort: msg.effort,
              sandbox: msg.sandbox,
              reasoningEffort: msg.reasoningEffort,
            });
          } catch (err) {
            // Held resume target → consent prompt, not an error toast. The
            // client re-sends the same create with takeover: true if the
            // viewer agrees to kick the holder off.
            if (err instanceof ResumeHeldError) {
              send(ws, { type: 'resume_held', holderPid: Number(err.holderPid) || 0 });
              break;
            }
            throw err;
          }
          await terminalManager.attach(id, ws);
          currentSessionId = id;

          transcriptHub.track(id, {
            backend: info.backend,
            cwd: info.cwd,
            spawnTimeMs: info.createdAt,
            resumeSessionId: msg.resumeSessionId || null,
          });

          send(ws, {
            type: 'created',
            sessionId: id,
            backend: info.backend,
            title: info.title,
          });

          console.log(`[agentdeck] WS: created + attached session ${id}`);
          break;
        }

        case 'attach': {
          // Detach current session if any
          if (currentSessionId) {
            terminalManager.detach(currentSessionId, ws);
          }

          // The attaching client's geometry rides along INTO attach() so the
          // window is resized before history is captured. This used to be a
          // separate resize() call after the attach — history then arrived
          // laid out for the previous client's width, which is where the
          // "different ghosts on every refresh" came from (see attach()).
          const dims = (typeof msg.cols === 'number' && typeof msg.rows === 'number'
            && msg.cols > 0 && msg.rows > 0)
            ? { cols: msg.cols, rows: msg.rows }
            : undefined;
          await terminalManager.attach(msg.sessionId, ws, msg.streamOutput !== false, dims);
          currentSessionId = msg.sessionId;

          console.log(`[agentdeck] WS: attached to session ${msg.sessionId}`);
          break;
        }

        case 'input': {
          if (!currentSessionId) {
            send(ws, { type: 'error', message: 'No session attached.' });
            return;
          }
          terminalManager.write(currentSessionId, msg.data, ws);
          // Enter pressed → a first prompt may have just been submitted, and
          // the CLI creates its transcript file on the first prompt.
          if (msg.data.includes('\r')) transcriptHub.nudgeDiscovery(currentSessionId);
          break;
        }

        case 'resize': {
          // Resize events fire from ResizeObserver even when create failed —
          // noise, not a user action; drop silently.
          if (!currentSessionId) return;
          terminalManager.resize(currentSessionId, msg.cols, msg.rows, ws);
          break;
        }

        case 'clear_history': {
          if (!currentSessionId) {
            send(ws, { type: 'error', message: 'No session attached.' });
            return;
          }
          terminalManager.clearHistory(currentSessionId, ws);
          // Ack so the client clears its own xterm scrollback in the same
          // moment — server wipes tmux + ring buffer, client wipes the DOM.
          send(ws, { type: 'history_cleared' });
          break;
        }

        case 'kill': {
          terminalManager.kill(msg.sessionId, ws);
          transcriptHub.untrack(msg.sessionId);

          // If we killed the currently attached session, clear it
          if (currentSessionId === msg.sessionId) {
            currentSessionId = null;
          }

          console.log(`[agentdeck] WS: killed session ${msg.sessionId}`);
          break;
        }

        case 'list': {
          const list = terminalManager.list();
          send(ws, { type: 'sessions', list });
          break;
        }

        case 'chat_attach': {
          if (currentSessionId) {
            terminalManager.detach(currentSessionId, ws);
          }
          await terminalManager.attach(msg.sessionId, ws, false);
          currentSessionId = msg.sessionId;
          transcriptHub.attachChat(ws, msg.sessionId);
          break;
        }

        case 'chat_detach': {
          transcriptHub.detachChat(ws);
          if (currentSessionId) {
            terminalManager.detach(currentSessionId, ws);
            currentSessionId = null;
          }
          break;
        }

        case 'watch_status': {
          transcriptHub.watchStatus(ws);
          break;
        }

        case 'chat_input': {
          const text = String(msg.text ?? '');
          if (!text.trim()) return;
          const sessionId = msg.sessionId;
          // Bracketed paste keeps multi-line input as one block inside the
          // TUI. The submitting CR must come as a SEPARATE write a beat
          // later — glued to the paste it gets swallowed with it (verified
          // against the Claude Code TUI).
          terminalManager.write(sessionId, `\x1b[200~${text}\x1b[201~`, ws);
          schedule(() => {
            try {
              terminalManager.write(sessionId, '\r', ws);
              transcriptHub.nudgeDiscovery(sessionId);
            } catch (err) {
              sendError(ws, err);
            }
          }, 150);
          break;
        }

        case 'interrupt': {
          terminalManager.write(msg.sessionId, '\x1b', ws); // Esc interrupts both CLIs
          break;
        }

        default: {
          send(ws, { type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
        }
      }
    } catch (err) {
      sendError(ws, err);
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    transcriptHub.release(ws);
    // The close code separates "the browser deliberately hung up" (1000/1001 —
    // a React unmount, a navigation) from "the link died" (1006 — no close
    // frame arrived, i.e. the tunnel or the radio dropped it). Without this
    // the log cannot tell a UI bug from a network one.
    const why = reason?.length ? ` reason="${reason.toString()}"` : '';
    if (currentSessionId) {
      terminalManager.detach(currentSessionId, ws);
      console.log(
        `[agentdeck] WS closed (code=${code}${why}), detached session ${currentSessionId}`,
      );
      currentSessionId = null;
    } else {
      console.log(`[agentdeck] WS closed (code=${code}${why}), no session attached`);
    }
  });

  ws.on('error', (err) => {
    console.error('[agentdeck] WS error:', err.message);
  });
}

function sendError(ws: WebSocket, err: unknown): void {
  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[agentdeck] WS message error:', message);
  send(ws, { type: 'error', message });
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
