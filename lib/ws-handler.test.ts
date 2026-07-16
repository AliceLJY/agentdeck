import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { RingBuffer } from './ring-buffer';
import {
  TerminalManager,
  type TerminalManagerStore,
} from './terminal-manager';
import {
  handleWebSocket,
  type WebSocketHandlerDependencies,
} from './ws-handler';
import type { ClientMessage } from './types';

const SESSION_ID = 'session-1';

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(data: unknown): void {
    this.sent.push(String(data));
  }

  receive(message: ClientMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
  }
}

function createHarness() {
  const removed: string[] = [];
  const store: TerminalManagerStore = {
    loadAll: () => ({}),
    remove: (id) => { removed.push(id); },
    save: () => {},
    updateTitle: () => {},
  };
  const manager = new TerminalManager({
    home: '/tmp',
    store,
    tmuxPath: '/usr/bin/false',
    startCleanupTimer: false,
  });

  const writes: string[] = [];
  let ptyKills = 0;
  const session = {
    id: SESSION_ID,
    backend: 'claude' as const,
    tmuxName: `ccrt-${SESSION_ID}`,
    cwd: '/tmp',
    resumeSessionId: null,
    pty: {
      write: (data: string) => { writes.push(data); },
      resize: () => {},
      kill: () => { ptyKills += 1; },
    },
    ws: null,
    streamOutput: false,
    buffer: new RingBuffer(1024),
    createdAt: 1,
    lastActivity: 1,
    title: 'test session',
    alive: true,
    dataDisposable: { dispose: () => {} },
  };
  (manager as unknown as { sessions: Map<string, unknown> })
    .sessions.set(SESSION_ID, session);

  const nudged: string[] = [];
  const untracked: string[] = [];
  const transcriptHub: WebSocketHandlerDependencies['transcriptHub'] = {
    attachChat: () => {},
    detachChat: () => {},
    nudgeDiscovery: (id) => { nudged.push(id); },
    release: () => {},
    track: () => {},
    untrack: (id) => { untracked.push(id); },
    watchStatus: () => {},
  };
  const scheduled: Array<() => void> = [];
  const dependencies: WebSocketHandlerDependencies = {
    terminalManager: manager,
    transcriptHub,
    schedule: (callback) => { scheduled.push(callback); },
  };

  return {
    manager,
    writes,
    removed,
    nudged,
    untracked,
    scheduled,
    ptyKills: () => ptyKills,
    connect(socket: FakeSocket) {
      handleWebSocket(socket.asWebSocket(), dependencies);
    },
  };
}

describe('WebSocket terminal ownership after takeover', () => {
  it('rejects stale chat input, interrupt, and kill while the current owner can use all three', () => {
    const harness = createHarness();
    const stale = new FakeSocket();
    const owner = new FakeSocket();

    try {
      harness.connect(stale);
      harness.connect(owner);
      stale.receive({ type: 'attach', sessionId: SESSION_ID });
      owner.receive({ type: 'chat_attach', sessionId: SESSION_ID });

      assert.equal(
        stale.messages().filter((message) => message.type === 'taken_over').length,
        1,
      );

      stale.receive({ type: 'chat_input', sessionId: SESSION_ID, text: 'stale prompt' });
      stale.receive({ type: 'interrupt', sessionId: SESSION_ID });
      stale.receive({ type: 'kill', sessionId: SESSION_ID });

      assert.deepEqual(harness.writes, []);
      assert.equal(harness.scheduled.length, 0);
      assert.equal(harness.manager.hasSession(SESSION_ID), true);
      assert.deepEqual(harness.untracked, []);
      assert.equal(
        stale.messages().filter((message) => message.type === 'error').length,
        3,
      );

      owner.receive({ type: 'chat_input', sessionId: SESSION_ID, text: 'owner prompt' });
      assert.deepEqual(harness.writes, ['\x1b[200~owner prompt\x1b[201~']);
      assert.equal(harness.scheduled.length, 1);
      harness.scheduled.shift()!();
      assert.deepEqual(harness.writes, [
        '\x1b[200~owner prompt\x1b[201~',
        '\r',
      ]);
      assert.deepEqual(harness.nudged, [SESSION_ID]);

      owner.receive({ type: 'interrupt', sessionId: SESSION_ID });
      assert.equal(harness.writes.at(-1), '\x1b');

      owner.receive({ type: 'kill', sessionId: SESSION_ID });
      assert.equal(harness.manager.hasSession(SESSION_ID), false);
      assert.equal(harness.ptyKills(), 1);
      assert.deepEqual(harness.removed, [SESSION_ID]);
      assert.deepEqual(harness.untracked, [SESSION_ID]);
    } finally {
      harness.manager.destroy();
    }
  });

  it('re-checks ownership before chat input sends its delayed carriage return', () => {
    const harness = createHarness();
    const stale = new FakeSocket();
    const owner = new FakeSocket();

    try {
      harness.connect(stale);
      harness.connect(owner);
      stale.receive({ type: 'chat_attach', sessionId: SESSION_ID });
      stale.receive({ type: 'chat_input', sessionId: SESSION_ID, text: 'half sent' });

      assert.deepEqual(harness.writes, ['\x1b[200~half sent\x1b[201~']);
      assert.equal(harness.scheduled.length, 1);

      owner.receive({ type: 'attach', sessionId: SESSION_ID });
      harness.scheduled.shift()!();

      assert.deepEqual(harness.writes, ['\x1b[200~half sent\x1b[201~']);
      assert.deepEqual(harness.nudged, []);
      assert.equal(
        stale.messages().filter((message) => message.type === 'error').length,
        1,
      );
      assert.equal(harness.manager.hasSession(SESSION_ID), true);
    } finally {
      harness.manager.destroy();
    }
  });
});
