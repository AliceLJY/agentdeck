import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from './device-service';

test('prefers the forwarded address Caddy sets', () => {
  assert.equal(clientIp({ 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1'), '203.0.113.7');
});

test('takes the first hop of a forwarded chain', () => {
  assert.equal(
    clientIp({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }, '127.0.0.1'),
    '203.0.113.7',
  );
});

test('handles a repeated header arriving as an array', () => {
  assert.equal(clientIp({ 'x-forwarded-for': ['198.51.100.2', '10.0.0.1'] }), '198.51.100.2');
});

test('falls back to the socket address behind a plain tcp tunnel', () => {
  // frp in tcp mode adds no headers, so the socket is all there is.
  assert.equal(clientIp({}, '192.168.3.243'), '192.168.3.243');
});

test('reports unknown rather than empty when there is nothing to go on', () => {
  assert.equal(clientIp({}), 'unknown');
});
