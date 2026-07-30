import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceStore } from './device-store';
import { authorizeDevice, isLoopbackIp, labelFromUserAgent } from './device-auth';

function freshStore(): DeviceStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-devices-'));
  return new DeviceStore(path.join(dir, 'devices.json'));
}

/** Default context is a REMOTE caller — the case that must never be adopted. */
const ctx = (deviceId: string | null, ua = 'Mozilla/5.0 (iPhone)') => ({
  deviceId,
  userAgent: ua,
  peerIp: '203.0.113.7',
  displayIp: '203.0.113.7',
  now: 1_700_000_000_000,
});

const localCtx = (deviceId: string | null, ua = 'Mozilla/5.0 (Macintosh)') => ({
  ...ctx(deviceId, ua),
  peerIp: '127.0.0.1',
  displayIp: '127.0.0.1',
});

test('adopts the first device from loopback so a fresh install is not locked out', () => {
  const store = freshStore();
  const decision = authorizeDevice(store, localCtx('mac-1'), {});

  assert.equal(decision.outcome, 'allow');
  assert.equal(decision.bootstrapped, true);
  assert.equal(store.get('mac-1')?.status, 'approved');
});

test('an empty allowlist reached from the network is NOT adopted', () => {
  // Regression: the WS gate once read a different (empty) store file than the
  // API and adopted an unknown remote device the API had marked pending.
  const store = freshStore();
  const decision = authorizeDevice(store, ctx('intruder'), {});

  assert.equal(decision.outcome, 'pending');
  assert.notEqual(decision.bootstrapped, true);
  assert.equal(store.hasApproved(), false, 'a remote caller must not seed the allowlist');
});

test('a remote caller claiming to be loopback is NOT adopted', () => {
  // Regression for the spoofable-field bypass: displayIp comes from
  // X-Forwarded-For and is attacker-controlled, so only peerIp may decide.
  const store = freshStore();
  const spoofed = { ...ctx('attacker'), displayIp: '127.0.0.1' };

  const decision = authorizeDevice(store, spoofed, {});
  assert.equal(decision.outcome, 'pending');
  assert.notEqual(decision.bootstrapped, true);
  assert.equal(store.hasApproved(), false, 'a forged header must not seed the allowlist');
});

test('an unknown peer address is not treated as loopback', () => {
  const store = freshStore();
  const decision = authorizeDevice(
    store,
    { ...ctx('mystery'), peerIp: 'unknown', displayIp: 'unknown' },
    {},
  );
  assert.equal(decision.outcome, 'pending');
});

test('blocks every later unknown device once one is approved', () => {
  const store = freshStore();
  authorizeDevice(store, localCtx('mac-1'), {});

  const decision = authorizeDevice(store, ctx('laptop-2'), {});
  assert.equal(decision.outcome, 'pending');
  assert.equal(decision.isFirstSighting, true);
  assert.ok(decision.device.approvalNonce, 'pending device needs an approval nonce');
});

test('strict bootstrap withholds even the first loopback device', () => {
  const store = freshStore();
  const decision = authorizeDevice(store, localCtx('mac-1'), {
    AGENTDECK_STRICT_BOOTSTRAP: '1',
  });

  assert.equal(decision.outcome, 'pending');
  assert.equal(store.hasApproved(), false);
});

test('an unreadable allowlist denies everyone instead of degrading to empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-corrupt-'));
  const file = path.join(dir, 'devices.json');
  fs.writeFileSync(file, '{ this is not json');
  const store = new DeviceStore(file);

  // Even from loopback, which is the most privileged position there is.
  const decision = authorizeDevice(store, localCtx('mac-1'), {});
  assert.equal(decision.outcome, 'unavailable');
  assert.equal(store.hasApproved(), false);
});

test('a corrupt allowlist is never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-corrupt-'));
  const file = path.join(dir, 'devices.json');
  const damaged = '{ "half-written": ';
  fs.writeFileSync(file, damaged);

  const store = new DeviceStore(file);
  authorizeDevice(store, localCtx('mac-1'), {});

  assert.equal(fs.readFileSync(file, 'utf-8'), damaged, 'must not clobber recoverable data');
});

test('recognizes loopback addresses including v4-mapped v6', () => {
  assert.equal(isLoopbackIp('127.0.0.1'), true);
  assert.equal(isLoopbackIp('::1'), true);
  assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackIp('203.0.113.7'), false);
  assert.equal(isLoopbackIp('unknown'), false);
});

test('an approved device keeps connecting without re-notifying', () => {
  const store = freshStore();
  authorizeDevice(store, localCtx('phone-1'), {});

  const again = authorizeDevice(store, ctx('phone-1'), {});
  assert.equal(again.outcome, 'allow');
  assert.equal(again.isFirstSighting, false);
});

test('a retrying blocked device only notifies once', () => {
  const store = freshStore();
  authorizeDevice(store, localCtx('phone-1'), {});

  const first = authorizeDevice(store, ctx('intruder'), {});
  const retry = authorizeDevice(store, ctx('intruder'), {});

  assert.equal(first.isFirstSighting, true);
  assert.equal(retry.isFirstSighting, false, 'a reconnect loop must not flood alerts');
  assert.equal(retry.outcome, 'pending');
});

test('a revoked device stays out even with a valid token', () => {
  const store = freshStore();
  authorizeDevice(store, localCtx('phone-1'), {});
  store.setStatus('phone-1', 'revoked');

  const decision = authorizeDevice(store, ctx('phone-1'), {});
  assert.equal(decision.outcome, 'revoked');
});

test('a missing device id is treated as a new device, never as an approved one', () => {
  const store = freshStore();
  authorizeDevice(store, localCtx('phone-1'), {});

  const decision = authorizeDevice(store, ctx(null), {});
  assert.equal(decision.outcome, 'pending');
  assert.match(decision.device.id, /^unidentified-/);
});

test('two id-less clients do not collide into one record', () => {
  const store = freshStore();
  authorizeDevice(store, localCtx('phone-1'), {});

  const a = authorizeDevice(store, ctx(null), {});
  const b = authorizeDevice(store, ctx(null), {});
  assert.notEqual(a.device.id, b.device.id);
});

test('labels devices from the user agent', () => {
  assert.equal(labelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'), 'iPhone');
  assert.equal(labelFromUserAgent('Mozilla/5.0 (Linux; Android 15; Find N6) Mobile'), 'Android phone');
  assert.equal(labelFromUserAgent('Mozilla/5.0 (Macintosh) Chrome/140'), 'Mac · Chrome');
  assert.equal(labelFromUserAgent(null), 'Unknown client');
});
