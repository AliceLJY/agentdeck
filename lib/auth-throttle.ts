/**
 * Slows down repeated authentication failures.
 *
 * Two constraints shaped this, and both rule out a conventional per-IP limiter:
 *
 * 1. Behind an frp tcp tunnel every remote client arrives as 127.0.0.1, so
 *    there is no usable client identity to bucket by. Bucketing by
 *    X-Forwarded-For instead would be worse than nothing — the caller sets that
 *    header, so an attacker gets a fresh quota per forged value.
 * 2. A shared quota that a stranger can exhaust would lock the owner out of her
 *    own terminal, turning a hardening measure into a denial-of-service lever.
 *
 * So this counts *failures only* and answers with delay rather than refusal.
 * A correct token plus an approved device never touches the counter, so normal
 * use is unaffected no matter what anyone else is doing; a guesser gets pushed
 * from thousands of attempts per second down to well under one, and nobody can
 * lock anybody out.
 *
 * Worth being clear about what this is NOT for: a 64-hex-char token carries 256
 * bits, which no amount of guessing will reach. This exists to stop free,
 * high-rate knocking (log flooding, resource burn) and to keep the failure mode
 * sane if a shorter token is ever configured.
 */

/** Failures within this window count toward the current penalty. */
export const FAILURE_WINDOW_MS = 60 * 1000;
/** Failures allowed before delay kicks in at all. */
export const FREE_FAILURES = 5;
/** Added per failure beyond the free allowance. */
export const DELAY_STEP_MS = 250;
/** Hard cap, so a socket is never held open indefinitely. */
export const MAX_DELAY_MS = 3000;

export interface ThrottleState {
  failures: number[];
}

export function createThrottle(): ThrottleState {
  return { failures: [] };
}

/** Drops timestamps that fell out of the window. Called on every read. */
function prune(state: ThrottleState, now: number): void {
  const cutoff = now - FAILURE_WINDOW_MS;
  state.failures = state.failures.filter((t) => t > cutoff);
}

/**
 * How long the *next* failure response should be held back. Read before
 * answering a failure; a successful auth should never call this.
 */
export function delayForNextFailure(state: ThrottleState, now: number): number {
  prune(state, now);
  const over = state.failures.length - FREE_FAILURES;
  if (over <= 0) return 0;
  return Math.min(over * DELAY_STEP_MS, MAX_DELAY_MS);
}

/** Records a failed authentication attempt. */
export function recordFailure(state: ThrottleState, now: number): void {
  prune(state, now);
  state.failures.push(now);
}

/** Current failure count in the window — for logging, not for decisions. */
export function failureCount(state: ThrottleState, now: number): number {
  prune(state, now);
  return state.failures.length;
}

/**
 * Process-wide state. Deliberately not shared with the Next route handlers:
 * they may not share this module graph (the devices-path bug earlier today came
 * from assuming they did), and two independent counters both still slow their
 * own surface down. Nothing here needs to agree across the two.
 */
export const globalThrottle = createThrottle();

/** Sleeps for the computed delay, if any. Safe to await unconditionally. */
export async function applyFailureDelay(
  state: ThrottleState,
  now: number,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<number> {
  // Record first, then price it: with FREE_FAILURES = 5 the fifth failure must
  // still be free and the sixth must not. Pricing before recording quietly
  // granted one extra free attempt — the constant said 5, the behaviour was 6.
  recordFailure(state, now);
  const delay = delayForNextFailure(state, now);
  if (delay > 0) await sleep(delay);
  return delay;
}
