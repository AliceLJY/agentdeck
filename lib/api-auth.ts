import { NextResponse } from 'next/server';
import { applyFailureDelay, globalThrottle } from './auth-throttle';
import { DEVICE_ID_HEADER } from './device-headers';
import { deviceStore } from './device-service';
import type { DeviceStore } from './device-store';

type HeaderReader = Pick<Headers, 'get'>;
type TokenEnv = Readonly<Record<string, string | undefined>>;
type DeviceReader = Pick<DeviceStore, 'get' | 'isUnreadable'>;

export type ApiAccessDecision =
  | { outcome: 'allow'; deviceId: string }
  | { outcome: 'deny'; status: 401 | 403 | 503; error: string };

/**
 * Checks sensitive HTTP APIs without enrolling or touching the caller. Unknown
 * devices must go through /api/devices/self, where the owner notification and
 * one-time approval nonce live.
 *
 * simplified: the approved device id is still an opaque handle, not a second
 * secret. Add per-device credentials if the threat model expands to leakage of
 * both the shared token and an approved id.
 */
export function checkApprovedApiDevice(
  headers: HeaderReader,
  env: TokenEnv = process.env,
  store: DeviceReader = deviceStore,
): ApiAccessDecision {
  const expectedToken = env.AGENTDECK_TOKEN || env.CC_TERMINAL_TOKEN;
  if (!expectedToken || headers.get('x-token') !== expectedToken) {
    return { outcome: 'deny', status: 401, error: 'Unauthorized' };
  }

  if (store.isUnreadable()) {
    return { outcome: 'deny', status: 503, error: 'Device allowlist unavailable' };
  }

  const deviceId = headers.get(DEVICE_ID_HEADER)?.trim() || '';
  if (!deviceId || store.get(deviceId)?.status !== 'approved') {
    return { outcome: 'deny', status: 403, error: 'Approved device required' };
  }

  return { outcome: 'allow', deviceId };
}

/** Returns an HTTP error for a blocked caller, or null when the route may run. */
export async function requireApprovedApiDevice(
  headers: HeaderReader,
): Promise<NextResponse | null> {
  const decision = checkApprovedApiDevice(headers);
  if (decision.outcome === 'allow') return null;

  if (decision.status === 401) {
    await applyFailureDelay(globalThrottle, Date.now());
  }
  return NextResponse.json({ error: decision.error }, { status: decision.status });
}
