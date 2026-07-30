import { randomBytes } from 'crypto';
import type { DeviceRecord, DeviceStore } from './device-store';

export type AuthOutcome = 'allow' | 'pending' | 'revoked' | 'unavailable' | 'no-device-id';

export interface AuthDecision {
  outcome: AuthOutcome;
  device: DeviceRecord;
  /** True when this call created the record — the moment worth notifying about.
   *  A phone retrying every few seconds must not fire a notification per retry. */
  isFirstSighting: boolean;
}

export interface AuthContext {
  deviceId?: string | null;
  userAgent?: string | null;
  /**
   * Which entry point the browser is running as ('standalone' for an installed
   * home-screen app, 'browser' otherwise). Display only — each entry point has
   * its own localStorage and therefore its own device id, so the label is what
   * lets the owner tell three otherwise identical "iPhone" rows apart.
   */
  displayMode?: string | null;
  /**
   * Address of the connecting peer. Recorded and shown, never used to decide:
   * behind an frp tcp tunnel every remote client arrives as 127.0.0.1, so
   * "looks local" carries no information about who is actually calling.
   */
  peerIp: string;
  /** Best-effort address for the alert and the devices list. May be forged. */
  displayIp: string;
  now: number;
}

/**
 * Turns a raw User-Agent into something recognisable in an approval prompt.
 * Deliberately coarse: the label is a memory aid for the owner, never a
 * security signal, so "iPhone" beats a full UA string nobody reads.
 */
export function labelFromUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown client';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh|Mac OS X/i.test(ua)) {
    if (/Chrome/i.test(ua)) return 'Mac · Chrome';
    if (/Safari/i.test(ua)) return 'Mac · Safari';
    return 'Mac';
  }
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown client';
}

/**
 * Names a device by hardware *and* entry point. An installed home-screen app
 * and the same phone's browser have separate localStorage, so they are two
 * device ids with identical user agents — without this the devices list shows
 * several indistinguishable "iPhone" rows and none of them can be acted on.
 */
export function deviceLabel(
  ua: string | null | undefined,
  displayMode?: string | null,
): string {
  const base = labelFromUserAgent(ua);
  return displayMode === 'standalone' ? `${base} · Home Screen` : base;
}

export function mintApprovalNonce(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Decides whether a connection may proceed, recording the device on the way.
 *
 * The token check still happens upstream — this is the second factor. Its
 * whole point is that a stolen token alone is not enough: the thief's browser
 * has no approved device id, so it lands in `pending` and the owner is told.
 *
 * There is deliberately NO trust-on-first-use. An earlier version adopted the
 * first caller when it arrived from loopback, on the theory that loopback means
 * "already on this Mac". Behind an frp tcp tunnel that theory is false: every
 * remote client reaches the server as 127.0.0.1, so the very first phone to
 * connect from the public internet was being adopted silently — observed in
 * production, not hypothetically. Every device now goes through approval, which
 * is also one special case fewer to get wrong. The owner cannot be locked out
 * because the approval link reaches them over Telegram (or, unconfigured, in
 * the server log alongside `scripts/device-approve.mjs`).
 */
export function authorizeDevice(
  store: DeviceStore,
  ctx: AuthContext,
): AuthDecision {
  const id = (ctx.deviceId || '').trim();
  const name = deviceLabel(ctx.userAgent, ctx.displayMode);

  const placeholder = (): DeviceRecord => ({
    id: id || 'no-device-id',
    name,
    status: 'pending',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
    userAgent: ctx.userAgent || '',
    lastIp: ctx.displayIp,
  });

  // A client that sends no device id cannot be approved — approval is keyed by
  // that id, so a record created here could never be matched by the next
  // request. Minting one anyway is what filled the allowlist with dead
  // `unidentified-*` rows and fired an alert for each. Refuse instead.
  if (!id) {
    return { outcome: 'no-device-id', device: placeholder(), isFirstSighting: false };
  }

  // A damaged allowlist denies everything rather than degrading to "empty".
  if (store.isUnreadable()) {
    return { outcome: 'unavailable', device: placeholder(), isFirstSighting: false };
  }

  const existing = store.get(id);

  if (existing) {
    if (existing.status === 'approved') {
      store.touch(id, ctx.now, ctx.displayIp);
      return { outcome: 'allow', device: existing, isFirstSighting: false };
    }
    if (existing.status === 'revoked') {
      store.touch(id, ctx.now, ctx.displayIp);
      return { outcome: 'revoked', device: existing, isFirstSighting: false };
    }
    store.touch(id, ctx.now, ctx.displayIp);
    return { outcome: 'pending', device: existing, isFirstSighting: false };
  }

  const record: DeviceRecord = {
    id,
    name,
    status: 'pending',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
    userAgent: ctx.userAgent || '',
    lastIp: ctx.displayIp,
    approvalNonce: mintApprovalNonce(),
  };
  store.upsert(record);

  return { outcome: 'pending', device: record, isFirstSighting: true };
}
