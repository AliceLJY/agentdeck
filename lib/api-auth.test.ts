import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkApprovedApiDevice } from './api-auth';
import { DEVICE_ID_HEADER } from './device-headers';
import type { DeviceRecord } from './device-store';

const TOKEN = 'test-token';

const device = (status: DeviceRecord['status']): DeviceRecord => ({
  id: `${status}-device`,
  name: 'Test device',
  status,
  firstSeen: 1,
  lastSeen: 1,
  userAgent: 'test',
  lastIp: '203.0.113.7',
});

const records = new Map<string, DeviceRecord>([
  ['approved-device', device('approved')],
  ['pending-device', device('pending')],
  ['revoked-device', device('revoked')],
]);

const store = {
  isUnreadable: () => false,
  get: (id: string) => records.get(id),
};

function headers(token?: string, deviceId?: string): Headers {
  const result = new Headers();
  if (token) result.set('x-token', token);
  if (deviceId) result.set(DEVICE_ID_HEADER, deviceId);
  return result;
}

test('a valid token without an approved caller is forbidden', () => {
  assert.deepEqual(
    checkApprovedApiDevice(headers(TOKEN), { AGENTDECK_TOKEN: TOKEN }, store),
    { outcome: 'deny', status: 403, error: 'Approved device required' },
  );
});

test('pending and revoked callers cannot use protected APIs', () => {
  for (const id of ['pending-device', 'revoked-device']) {
    const decision = checkApprovedApiDevice(
      headers(TOKEN, id),
      { AGENTDECK_TOKEN: TOKEN },
      store,
    );
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.status, 403);
  }
});

test('an approved caller with the valid token is allowed', () => {
  assert.deepEqual(
    checkApprovedApiDevice(
      headers(TOKEN, 'approved-device'),
      { AGENTDECK_TOKEN: TOKEN },
      store,
    ),
    { outcome: 'allow', deviceId: 'approved-device' },
  );
});

test('the device id never substitutes for a missing or wrong token', () => {
  for (const token of [undefined, 'wrong-token']) {
    const decision = checkApprovedApiDevice(
      headers(token, 'approved-device'),
      { AGENTDECK_TOKEN: TOKEN },
      store,
    );
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.status, 401);
  }
});

test('the legacy token variable remains supported', () => {
  assert.equal(
    checkApprovedApiDevice(
      headers(TOKEN, 'approved-device'),
      { CC_TERMINAL_TOKEN: TOKEN },
      store,
    ).outcome,
    'allow',
  );
});

test('an unreadable allowlist fails closed', () => {
  const decision = checkApprovedApiDevice(
    headers(TOKEN, 'approved-device'),
    { AGENTDECK_TOKEN: TOKEN },
    { isUnreadable: () => true, get: () => device('approved') },
  );
  assert.equal(decision.outcome, 'deny');
  assert.equal(decision.status, 503);
});

test('every sensitive HTTP route uses the shared approved-device guard', () => {
  const protectedRoutes = [
    ['app/api/devices/route.ts', 2],
    ['app/api/history/route.ts', 1],
    ['app/api/history/session/route.ts', 1],
    ['app/api/upload/route.ts', 1],
  ] as const;

  for (const [route, expectedCalls] of protectedRoutes) {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    const calls = source.match(/requireApprovedApiDevice\(req\.headers\)/g)?.length || 0;
    assert.equal(calls, expectedCalls, route);
  }
});

test('device enrollment and Telegram nonce approval stay outside the guard', () => {
  for (const route of [
    'app/api/devices/self/route.ts',
    'app/api/devices/approve/route.ts',
  ]) {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    assert.doesNotMatch(source, /requireApprovedApiDevice/, route);
  }
});
