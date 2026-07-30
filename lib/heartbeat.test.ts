import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackConnection, sweep } from './heartbeat';

class FakeSocket extends EventEmitter {
  isAlive?: boolean;
  deviceId?: string;
  pings = 0;
  terminated = false;

  constructor(deviceId?: string) {
    super();
    this.deviceId = deviceId;
  }

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

  const { terminated } = sweep([ws]);

  assert.equal(terminated, 0);
  assert.equal(ws.pings, 1);
  assert.equal(ws.isAlive, false);
  assert.equal(ws.terminated, false);
});

test('sweep terminates sockets that missed the previous ping', () => {
  const ws = new FakeSocket();
  trackConnection(ws);

  sweep([ws]); // ping sent, no pong comes back
  const { terminated } = sweep([ws]); // zombie detected

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
  const { terminated } = sweep([live, zombie]);

  assert.equal(terminated, 1);
  assert.equal(live.terminated, false);
  assert.equal(zombie.terminated, true);
});

test('a revoked device loses its open session', () => {
  // The promise the whole feature rests on: "my phone was stolen, revoke it".
  // Authorization otherwise runs only at upgrade, so without this a revoked
  // phone holding a live socket kept working until it disconnected on its own.
  const ws = new FakeSocket('stolen-phone');
  trackConnection(ws);

  const { revoked } = sweep([ws], (id) => id !== 'stolen-phone');

  assert.equal(revoked, 1);
  assert.equal(ws.terminated, true);
});

test('an approved device is left alone', () => {
  const ws = new FakeSocket('my-phone');
  trackConnection(ws);

  const { revoked, terminated } = sweep([ws], () => true);

  assert.equal(revoked, 0);
  assert.equal(terminated, 0);
  assert.equal(ws.terminated, false);
  assert.equal(ws.pings, 1, 'it should still be pinged as usual');
});

test('revocation wins over liveness — no extra round of grace', () => {
  // A revoked socket that is answering pings must not survive the sweep just
  // because it looks healthy.
  const ws = new FakeSocket('stolen-phone');
  trackConnection(ws);
  ws.isAlive = true;

  const { revoked } = sweep([ws], () => false);
  assert.equal(revoked, 1);
  assert.equal(ws.terminated, true);
});

test('revoking one device does not touch the others', () => {
  const mine = new FakeSocket('my-phone');
  const stolen = new FakeSocket('stolen-phone');
  trackConnection(mine);
  trackConnection(stolen);

  const { revoked } = sweep([mine, stolen], (id) => id === 'my-phone');

  assert.equal(revoked, 1);
  assert.equal(stolen.terminated, true);
  assert.equal(mine.terminated, false);
});

test('connections with no device id are not swept as revoked', () => {
  // Pre-upgrade sockets and any legacy connection have no id; they must fall
  // through to the normal liveness path rather than be closed as revoked.
  const ws = new FakeSocket(undefined);
  trackConnection(ws);

  const { revoked, terminated } = sweep([ws], () => false);
  assert.equal(revoked, 0);
  assert.equal(terminated, 0);
});

test('without a check the sweep behaves exactly as before', () => {
  const ws = new FakeSocket('any');
  trackConnection(ws);
  const { revoked } = sweep([ws]);
  assert.equal(revoked, 0);
  assert.equal(ws.pings, 1);
});
