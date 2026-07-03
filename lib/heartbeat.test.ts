import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackConnection, sweep } from './heartbeat';

class FakeSocket extends EventEmitter {
  isAlive?: boolean;
  pings = 0;
  terminated = false;

  ping(): void {
    this.pings++;
  }

  terminate(): void {
    this.terminated = true;
  }
}

test('marks a new connection alive and revives it on pong', () => {
  const ws = new FakeSocket();
  trackConnection(ws);
  assert.equal(ws.isAlive, true);

  ws.isAlive = false;
  ws.emit('pong');
  assert.equal(ws.isAlive, true);
});

test('sweep pings live sockets and marks them pending', () => {
  const ws = new FakeSocket();
  trackConnection(ws);

  const terminated = sweep([ws]);

  assert.equal(terminated, 0);
  assert.equal(ws.pings, 1);
  assert.equal(ws.isAlive, false);
  assert.equal(ws.terminated, false);
});

test('sweep terminates sockets that missed the previous ping', () => {
  const ws = new FakeSocket();
  trackConnection(ws);

  sweep([ws]); // ping sent, no pong comes back
  const terminated = sweep([ws]); // zombie detected

  assert.equal(terminated, 1);
  assert.equal(ws.terminated, true);
  assert.equal(ws.pings, 1); // no second ping for a dead socket
});

test('a socket that keeps answering pongs survives repeated sweeps', () => {
  const ws = new FakeSocket();
  trackConnection(ws);

  for (let i = 0; i < 3; i++) {
    sweep([ws]);
    ws.emit('pong'); // browser answers ping at the protocol level
  }

  assert.equal(ws.terminated, false);
  assert.equal(ws.pings, 3);
  assert.equal(ws.isAlive, true);
});

test('sweep handles a mix of live and zombie sockets independently', () => {
  const live = new FakeSocket();
  const zombie = new FakeSocket();
  trackConnection(live);
  trackConnection(zombie);

  sweep([live, zombie]);
  live.emit('pong');
  const terminated = sweep([live, zombie]);

  assert.equal(terminated, 1);
  assert.equal(live.terminated, false);
  assert.equal(zombie.terminated, true);
});
