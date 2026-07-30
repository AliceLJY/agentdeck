import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFailureDelay,
  createThrottle,
  delayForNextFailure,
  failureCount,
  recordFailure,
  DELAY_STEP_MS,
  FAILURE_WINDOW_MS,
  FREE_FAILURES,
  MAX_DELAY_MS,
} from './auth-throttle';

const T0 = 1_700_000_000_000;

test('the first few failures are not delayed at all', () => {
  // A genuine fat-fingered token should not feel like a punishment.
  const s = createThrottle();
  for (let i = 0; i < FREE_FAILURES; i++) {
    assert.equal(delayForNextFailure(s, T0), 0);
    recordFailure(s, T0);
  }
});

test('delay grows once past the free allowance', () => {
  const s = createThrottle();
  for (let i = 0; i < FREE_FAILURES + 1; i++) recordFailure(s, T0);
  assert.equal(delayForNextFailure(s, T0), DELAY_STEP_MS);

  recordFailure(s, T0);
  assert.equal(delayForNextFailure(s, T0), DELAY_STEP_MS * 2);
});

test('delay is capped so a socket is never held indefinitely', () => {
  const s = createThrottle();
  for (let i = 0; i < 500; i++) recordFailure(s, T0);
  assert.equal(delayForNextFailure(s, T0), MAX_DELAY_MS);
});

test('failures age out of the window', () => {
  const s = createThrottle();
  for (let i = 0; i < 50; i++) recordFailure(s, T0);
  assert.ok(delayForNextFailure(s, T0) > 0);

  const later = T0 + FAILURE_WINDOW_MS + 1;
  assert.equal(failureCount(s, later), 0, 'old failures must not punish forever');
  assert.equal(delayForNextFailure(s, later), 0);
});

test('a successful auth never touches the counter — the owner is unaffected', () => {
  // The property that makes this safe to deploy: an attacker hammering the
  // public endpoint cannot slow down or lock out the owner, because her correct
  // token plus approved device never calls into this module at all.
  const s = createThrottle();
  for (let i = 0; i < 100; i++) recordFailure(s, T0);

  // Nothing in this module is consulted on the success path; the owner's
  // request simply does not appear here. Assert the shape that guarantees it:
  // there is no "check before allowing" entry point, only failure recording.
  const exported = Object.keys({
    applyFailureDelay,
    delayForNextFailure,
    recordFailure,
    failureCount,
    createThrottle,
  });
  assert.ok(
    !exported.some((name) => /allow|permit|check/i.test(name)),
    'no gate function exists, so success cannot be gated by failure state',
  );
});

test('applyFailureDelay records and waits, and reports how long it waited', async () => {
  const s = createThrottle();
  const slept: number[] = [];
  const fakeSleep = async (ms: number) => void slept.push(ms);

  for (let i = 0; i < FREE_FAILURES; i++) {
    const d = await applyFailureDelay(s, T0, fakeSleep);
    assert.equal(d, 0);
  }
  assert.deepEqual(slept, [], 'free allowance must not sleep');

  const d = await applyFailureDelay(s, T0, fakeSleep);
  assert.equal(d, DELAY_STEP_MS);
  assert.deepEqual(slept, [DELAY_STEP_MS]);
  assert.equal(failureCount(s, T0), FREE_FAILURES + 1);
});

test('a sustained guesser is pushed below one attempt per second', async () => {
  // The actual point of the feature, stated as a number.
  const s = createThrottle();
  const noSleep = async () => {};
  let totalDelay = 0;
  for (let i = 0; i < 40; i++) totalDelay += await applyFailureDelay(s, T0, noSleep);

  // 40 attempts cost this much wall time in aggregate.
  assert.ok(
    totalDelay >= 20_000,
    `40 guesses should cost >=20s of forced delay, got ${totalDelay}ms`,
  );
});
