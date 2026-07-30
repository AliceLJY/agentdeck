import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceStore } from './device-store';
import { authorizeDevice, deviceLabel, labelFromUserAgent, NONCE_TTL_MS, ALERT_THROTTLE_MS } from './device-auth';

function freshStore(): DeviceStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-devices-'));
  return new DeviceStore(path.join(dir, 'devices.json'));
}

const ctx = (
  deviceId: string | null,
  over: Partial<Parameters<typeof authorizeDevice>[1]> = {},
) => ({
  deviceId,
  userAgent: 'Mozilla/5.0 (iPhone)',
  displayMode: 'browser',
  peerIp: '203.0.113.7',
  displayIp: '203.0.113.7',
  now: 1_700_000_000_000,
  ...over,
});

/** The tunnel case: frp tcp forwarding makes every remote client look local. */
const viaTunnel = (deviceId: string | null) =>
  ctx(deviceId, { peerIp: '127.0.0.1', displayIp: '112.94.4.124' });

test('the very first device is not adopted — it waits for approval', () => {
  const store = freshStore();
  const decision = authorizeDevice(store, ctx('phone-1'));

  assert.equal(decision.outcome, 'pending');
  assert.equal(store.get('phone-1')?.status, 'pending');
  assert.ok(decision.device.approvalNonce, 'it needs a link the owner can tap');
});

test('a loopback peer gets no special treatment', () => {
  // Regression, observed in production: behind an frp tcp tunnel every remote
  // phone arrives as 127.0.0.1, so trusting loopback silently adopted the first
  // device that connected from the public internet.
  const store = freshStore();
  const decision = authorizeDevice(store, viaTunnel('phone-from-internet'));

  assert.equal(decision.outcome, 'pending');
  assert.equal(store.hasApproved(), false, 'nothing may seed the allowlist on its own');
});

test('an approved device connects without re-notifying', () => {
  const store = freshStore();
  authorizeDevice(store, ctx('phone-1'));
  store.setStatus('phone-1', 'approved');

  const again = authorizeDevice(store, ctx('phone-1'));
  assert.equal(again.outcome, 'allow');
  assert.equal(again.isFirstSighting, false);
});

test('a retrying blocked device only notifies once', () => {
  const store = freshStore();
  const first = authorizeDevice(store, ctx('intruder'));
  const retry = authorizeDevice(store, ctx('intruder'));

  assert.equal(first.isFirstSighting, true);
  assert.equal(retry.isFirstSighting, false, 'a reconnect loop must not flood alerts');
  assert.equal(retry.outcome, 'pending');
});

test('a revoked device stays out even with a valid token', () => {
  const store = freshStore();
  authorizeDevice(store, ctx('phone-1'));
  store.setStatus('phone-1', 'revoked');

  assert.equal(authorizeDevice(store, ctx('phone-1')).outcome, 'revoked');
});

test('a request with no device id is refused, not recorded', () => {
  // Regression: minting an id server-side filled the allowlist with dead
  // `unidentified-*` rows — approval is keyed by the id the client sends, so
  // such a row could never be matched by the next request, and each one also
  // fired its own alert.
  const store = freshStore();
  const decision = authorizeDevice(store, ctx(null));

  assert.equal(decision.outcome, 'no-device-id');
  assert.equal(store.list().length, 0, 'nothing may be written for an unusable request');
  assert.equal(decision.isFirstSighting, false, 'and it must not alert');
});

test('a blank device id counts as none', () => {
  const store = freshStore();
  assert.equal(authorizeDevice(store, ctx('   ')).outcome, 'no-device-id');
  assert.equal(store.list().length, 0);
});

test('an unreadable allowlist denies everyone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-corrupt-'));
  const file = path.join(dir, 'devices.json');
  fs.writeFileSync(file, '{ this is not json');
  const store = new DeviceStore(file);

  assert.equal(authorizeDevice(store, ctx('phone-1')).outcome, 'unavailable');
});

test('a corrupt allowlist is never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-corrupt-'));
  const file = path.join(dir, 'devices.json');
  const damaged = '{ "half-written": ';
  fs.writeFileSync(file, damaged);

  const store = new DeviceStore(file);
  authorizeDevice(store, ctx('phone-1'));
  assert.equal(fs.readFileSync(file, 'utf-8'), damaged, 'must not clobber recoverable data');
});

test('the display ip is recorded even when the peer is the tunnel', () => {
  const store = freshStore();
  const decision = authorizeDevice(store, viaTunnel('phone-1'));
  assert.equal(decision.device.lastIp, '112.94.4.124', 'the owner needs the real address');
});

test('labels devices from the user agent', () => {
  assert.equal(labelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'), 'iPhone');
  assert.equal(labelFromUserAgent('Mozilla/5.0 (Linux; Android 15; Find N6) Mobile'), 'Android phone');
  assert.equal(labelFromUserAgent('Mozilla/5.0 (Macintosh) Chrome/140'), 'Mac · Chrome');
  assert.equal(labelFromUserAgent(null), 'Unknown client');
});

test('the label distinguishes an installed app from the same phone browser', () => {
  // Same hardware, same user agent, different localStorage — so two device ids
  // that would otherwise both read as plain "iPhone" in the devices list.
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)';
  assert.equal(deviceLabel(ua, 'browser'), 'iPhone');
  assert.equal(deviceLabel(ua, 'standalone'), 'iPhone · Home Screen');
  assert.equal(deviceLabel(ua, null), 'iPhone', 'an older client sending nothing still works');
});

test('the entry point is part of the stored name', () => {
  const store = freshStore();
  const decision = authorizeDevice(store, ctx('pwa-1', { displayMode: 'standalone' }));
  assert.equal(decision.device.name, 'iPhone · Home Screen');
});

test('an approval link stops working after its TTL', () => {
  // Alice's scenario: a stranger's device gets blocked, she glances at the alert,
  // knows it is not her, and just ignores it (does not revoke). Weeks later she
  // scrolls the chat and mis-taps that old link. Before the TTL that tap would
  // have approved the intruder.
  const store = freshStore();
  const t0 = 1_700_000_000_000;
  const decision = authorizeDevice(store, { ...ctx('intruder'), now: t0 });
  const nonce = decision.device.approvalNonce!;

  assert.ok(store.findByNonce(nonce, t0 + NONCE_TTL_MS / 2), 'usable inside the window');
  assert.equal(
    store.findByNonce(nonce, t0 + NONCE_TTL_MS + 1),
    undefined,
    'a stray tap after the window must approve nothing',
  );
});

test('a lapsed link is distinguishable from one that never existed', () => {
  const store = freshStore();
  const t0 = 1_700_000_000_000;
  const nonce = authorizeDevice(store, { ...ctx('intruder'), now: t0 }).device.approvalNonce!;

  assert.equal(store.hasLapsedNonce(nonce, t0 + NONCE_TTL_MS / 2), false, 'still live, not lapsed');
  assert.equal(store.hasLapsedNonce(nonce, t0 + NONCE_TTL_MS + 1), true);
  assert.equal(store.hasLapsedNonce('never-minted', t0 + NONCE_TTL_MS + 1), false);
});

test('a device that keeps knocking past the TTL gets a fresh link and a fresh alert', () => {
  // Otherwise expiry would make that device permanently unapprovable from the phone.
  const store = freshStore();
  const t0 = 1_700_000_000_000;
  const first = authorizeDevice(store, { ...ctx('intruder'), now: t0 });

  const within = authorizeDevice(store, { ...ctx('intruder'), now: t0 + NONCE_TTL_MS / 2 });
  assert.equal(within.isFirstSighting, false, 'inside the window: still no re-alert');
  assert.equal(within.device.approvalNonce, first.device.approvalNonce, 'same link');

  // Link always refreshes past the TTL, so the device never becomes unapprovable…
  const after = authorizeDevice(store, { ...ctx('intruder'), now: t0 + NONCE_TTL_MS + 1 });
  assert.notEqual(after.device.approvalNonce, first.device.approvalNonce, 'a new link');
  assert.equal(store.findByNonce(first.device.approvalNonce!, t0 + NONCE_TTL_MS + 2), undefined,
    'the superseded link must be dead');
  // …but the owner is only told again after the (longer) alert throttle.
  assert.equal(after.isFirstSighting, false, 'inside the throttle: no second alert');

  const muchLater = authorizeDevice(store, { ...ctx('intruder'), now: t0 + ALERT_THROTTLE_MS + 1 });
  assert.equal(muchLater.isFirstSighting, true, 'past the throttle: alert again');
});

test('the retry storm costs one alert per throttle window, not per attempt', () => {
  // With a 60s link TTL, 10 minutes spans ten link refreshes — the throttle is
  // what keeps that from becoming ten alerts. This is why the two constants had
  // to be decoupled when the TTL dropped to a minute.
  const store = freshStore();
  const t0 = 1_700_000_000_000;
  let alerts = 0;
  for (let i = 0; i < 60; i++) {
    const d = authorizeDevice(store, { ...ctx('intruder'), now: t0 + i * 10_000 });
    if (d.isFirstSighting) alerts++;
  }
  const expected = Math.floor((59 * 10_000) / ALERT_THROTTLE_MS) + 1;
  assert.equal(alerts, expected, `10 min of knocking = ${expected} alerts, not 60`);
  assert.ok(alerts <= 3, 'and it must stay a handful, not a stream');
});

test('a record predating expiry tracking is treated as expired, not as eternal', () => {
  // Fail closed: old JSON has no nonceExpiresAt, and the safe reading of a
  // missing expiry is "dead link", never "never expires".
  const store = freshStore();
  store.upsert({
    id: 'legacy', name: 'iPhone', status: 'pending',
    firstSeen: 1, lastSeen: 1, userAgent: 'ua', lastIp: '1.2.3.4',
    approvalNonce: 'legacy-nonce',
  });
  assert.equal(store.findByNonce('legacy-nonce', Date.now()), undefined);
});

test('approving clears both the nonce and its expiry', () => {
  const store = freshStore();
  const t0 = 1_700_000_000_000;
  authorizeDevice(store, { ...ctx('phone-1'), now: t0 });
  const approved = store.setStatus('phone-1', 'approved');
  assert.equal(approved?.approvalNonce, undefined);
  assert.equal(approved?.nonceExpiresAt, undefined);
});
