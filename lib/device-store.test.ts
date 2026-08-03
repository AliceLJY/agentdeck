import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceStore, publicDeviceRecord, type DeviceRecord } from './device-store';

function tempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-store-'));
  return path.join(dir, 'devices.json');
}

/** Fixed clock so nonce-expiry assertions never depend on wall time. */
const NOW = 1_700_000_000_000;

const record = (over: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id: 'dev-1',
  name: 'iPhone',
  status: 'pending',
  firstSeen: 1,
  lastSeen: 1,
  userAgent: 'ua',
  lastIp: '198.51.100.9',
  approvalNonce: 'nonce-abc',
  nonceExpiresAt: NOW + 600_000,
  ...over,
});

test('a missing file reads as an empty allowlist', () => {
  const store = new DeviceStore(tempPath());
  assert.equal(store.isEmpty(), true);
  assert.equal(store.hasApproved(), false);
});

test('records survive a reload from disk', () => {
  const file = tempPath();
  new DeviceStore(file).upsert(record());

  const reopened = new DeviceStore(file);
  assert.equal(reopened.get('dev-1')?.name, 'iPhone');
});

test('the file is written owner-only', () => {
  const file = tempPath();
  new DeviceStore(file).upsert(record());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a pre-existing loose mode is tightened, not inherited', () => {
  // writeFileSync's mode argument only applies when it creates the file, so a
  // world-readable copy would otherwise stay world-readable through every write.
  const file = tempPath();
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  fs.chmodSync(file, 0o644);

  new DeviceStore(file).upsert(record());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a second instance sees the first one changes', () => {
  // The custom server and the Next route handlers may not share a module
  // graph, so every read re-reads the file rather than trusting memory.
  const file = tempPath();
  const a = new DeviceStore(file);
  const b = new DeviceStore(file);

  a.upsert(record());
  assert.equal(b.get('dev-1')?.status, 'pending');

  b.setStatus('dev-1', 'approved');
  assert.equal(a.get('dev-1')?.status, 'approved');
});

test('an approval nonce is single use', () => {
  const file = tempPath();
  const store = new DeviceStore(file);
  store.upsert(record());

  assert.equal(store.findByNonce('nonce-abc', NOW)?.id, 'dev-1');
  store.setStatus('dev-1', 'approved');
  assert.equal(store.findByNonce('nonce-abc', NOW), undefined, 'a spent nonce must not work twice');
});

test('an empty nonce never matches', () => {
  const store = new DeviceStore(tempPath());
  store.upsert(record({ approvalNonce: undefined }));
  assert.equal(store.findByNonce('', NOW), undefined);
});

test('revoking clears the approval link', () => {
  const store = new DeviceStore(tempPath());
  store.upsert(record({ status: 'approved', approvalNonce: 'still-here' }));
  const updated = store.setStatus('dev-1', 'revoked');
  assert.equal(updated?.approvalNonce, undefined);
});

test('lists newest-seen first', () => {
  const store = new DeviceStore(tempPath());
  store.upsert(record({ id: 'old', lastSeen: 10 }));
  store.upsert(record({ id: 'new', lastSeen: 99 }));
  assert.deepEqual(store.list().map((d) => d.id), ['new', 'old']);
});

test('touch updates last seen without changing status', () => {
  const store = new DeviceStore(tempPath());
  store.upsert(record({ status: 'approved' }));
  store.touch('dev-1', 500, '203.0.113.1');

  const updated = store.get('dev-1');
  assert.equal(updated?.lastSeen, 500);
  assert.equal(updated?.lastIp, '203.0.113.1');
  assert.equal(updated?.status, 'approved');
});

test('touching an unknown id is a no-op, not a silent insert', () => {
  const store = new DeviceStore(tempPath());
  store.touch('ghost', 1, '::1');
  assert.equal(store.get('ghost'), undefined);
});

test('the public device shape never exposes approval internals', () => {
  const publicRecord = publicDeviceRecord(record({
    lastAlertedAt: NOW,
    nonceExpiresAt: NOW + 60_000,
  }));

  assert.deepEqual(Object.keys(publicRecord).sort(), [
    'firstSeen',
    'id',
    'lastIp',
    'lastSeen',
    'name',
    'status',
    'userAgent',
  ]);
  assert.equal('approvalNonce' in publicRecord, false);
  assert.equal('nonceExpiresAt' in publicRecord, false);
  assert.equal('lastAlertedAt' in publicRecord, false);
});
