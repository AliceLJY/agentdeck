import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { terminalManager } from './terminal-manager';
import { transcriptHub } from './transcript-hub';
import type { ClientMessage } from './types';
import { DEFAULT_COLS, DEFAULT_ROWS } from './types';

/**
 * Handles a WebSocket connection for the terminal protocol.
 * One WS per browser tab. Multiple sessions share the WS via attach/detach.
 */
export function handleWebSocket(ws: WebSocket): void {
  let currentSessionId: string | null = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMessage;

      switch (msg.type) {
        case 'create': {
          const id = uuidv4();
          const cols = msg.cols || DEFAULT_COLS;
          const rows = msg.rows || DEFAULT_ROWS;

          const info = terminalManager.create(id, cols, rows, {
            backend: msg.backend,
            cwd: msg.cwd,
            resumeSessionId: msg.resumeSessionId,
            title: msg.title,
            model: msg.model,
            permissionMode: msg.permissionMode,
            effort: msg.effort,
            sandbox: msg.sandbox,
            reasoningEffort: msg.reasoningEffort,
          });
          terminalManager.attach(id, ws);
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

          console.log(`[cc-terminal] WS: created + attached session ${id}`);
          break;
        }

        case 'attach': {
          // Detach current session if any
          if (currentSessionId) {
            terminalManager.detach(currentSessionId, ws);
          }

          terminalManager.attach(msg.sessionId, ws);
          currentSessionId = msg.sessionId;

          console.log(`[cc-terminal] WS: attached to session ${msg.sessionId}`);
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
          if (!currentSessionId) {
            send(ws, { type: 'error', message: 'No session attached.' });
            return;
          }
          terminalManager.resize(currentSessionId, msg.cols, msg.rows, ws);
          break;
        }

        case 'kill': {
          terminalManager.kill(msg.sessionId);
          transcriptHub.untrack(msg.sessionId);

          // If we killed the currently attached session, clear it
          if (currentSessionId === msg.sessionId) {
            currentSessionId = null;
          }

          console.log(`[cc-terminal] WS: killed session ${msg.sessionId}`);
          break;
        }

        case 'list': {
          const list = terminalManager.list();
          send(ws, { type: 'sessions', list });
          break;
        }

        case 'chat_attach': {
          transcriptHub.attachChat(ws, msg.sessionId);
          break;
        }

        case 'chat_detach': {
          transcriptHub.detachChat(ws);
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
          terminalManager.write(sessionId, `\x1b[200~${text}\x1b[201~`);
          setTimeout(() => {
            try { terminalManager.write(sessionId, '\r'); } catch {}
            transcriptHub.nudgeDiscovery(sessionId);
          }, 150);
          break;
        }

        case 'interrupt': {
          terminalManager.write(msg.sessionId, '\x1b'); // Esc interrupts both CLIs
          break;
        }

        default: {
          send(ws, { type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[cc-terminal] WS message error:', message);
      send(ws, { type: 'error', message });
    }
  });

  ws.on('close', () => {
    transcriptHub.release(ws);
    if (currentSessionId) {
      terminalManager.detach(currentSessionId, ws);
      console.log(`[cc-terminal] WS closed, detached session ${currentSessionId}`);
      currentSessionId = null;
    }
  });

  ws.on('error', (err) => {
    console.error('[cc-terminal] WS error:', err.message);
  });
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
