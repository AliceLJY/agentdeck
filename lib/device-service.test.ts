import test from 'node:test';
import assert from 'node:assert/strict';
import { authIp, displayIp, PEER_HEADER } from './device-service';

test('authIp uses the socket and ignores X-Forwarded-For entirely', () => {
  // The bypass this guards: a remote caller claiming to be loopback would
  // otherwise be adopted while the allowlist is still empty.
  assert.equal(
    authIp({ 'x-forwarded-for': '127.0.0.1' }, '203.0.113.7'),
    '203.0.113.7',
  );
});

test('authIp falls back to the stamped peer header when there is no socket', () => {
  // Route handlers cannot reach the socket; the custom server stamps this.
  assert.equal(authIp({ [PEER_HEADER]: '127.0.0.1' }), '127.0.0.1');
});

test('authIp still ignores X-Forwarded-For in the route-handler path', () => {
  assert.equal(
    authIp({ 'x-forwarded-for': '127.0.0.1', [PEER_HEADER]: '203.0.113.7' }),
    '203.0.113.7',
  );
});

test('authIp reports unknown rather than guessing', () => {
  assert.equal(authIp({}), 'unknown');
  // 'unknown' must not read as loopback anywhere downstream.
  assert.notEqual(authIp({}), '127.0.0.1');
});

test('displayIp prefers the forwarded address so the owner sees the real phone', () => {
  assert.equal(displayIp({ 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1'), '203.0.113.7');
});

test('displayIp takes the first hop of a forwarded chain', () => {
  assert.equal(
    displayIp({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }, '127.0.0.1'),
    '203.0.113.7',
  );
});

test('displayIp handles a repeated header arriving as an array', () => {
  assert.equal(displayIp({ 'x-forwarded-for': ['198.51.100.2', '10.0.0.1'] }), '198.51.100.2');
});

test('displayIp falls back to the socket behind a plain tcp tunnel', () => {
  // frp in tcp mode adds no headers, so the socket is all there is.
  assert.equal(displayIp({}, '192.168.3.243'), '192.168.3.243');
});

test('displayIp reports unknown when there is nothing to go on', () => {
  assert.equal(displayIp({}), 'unknown');
});
