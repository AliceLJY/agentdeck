import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, resolveServerHost } from './server-config';

test('binds to loopback by default', () => {
  assert.equal(resolveServerHost({}), '127.0.0.1');
});

test('allows an explicit network bind address', () => {
  assert.equal(resolveServerHost({ CC_TERMINAL_HOST: ' 0.0.0.0 ' }), '0.0.0.0');
});

test('recognizes loopback hostnames', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});
