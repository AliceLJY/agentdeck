import { randomUUID, randomBytes } from 'crypto';
import type { DeviceRecord, DeviceStore } from './device-store';

export type AuthOutcome = 'allow' | 'pending' | 'revoked' | 'unavailable';

/**
 * Loopback means "someone already on this Mac", which is a strictly stronger
 * position than holding the token — they could read the token off disk anyway.
 * That is the only place trust-on-first-use is safe to offer.
 */
export function isLoopbackIp(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
}

export interface AuthDecision {
  outcome: AuthOutcome;
  device: DeviceRecord;
  /** True when this call created the record — the moment worth notifying about.
   *  A phone retrying every few seconds must not fire a notification per retry. */
  isFirstSighting: boolean;
  /** Set when the device was auto-approved because the allowlist was empty. */
  bootstrapped?: boolean;
}

export interface AuthContext {
  deviceId?: string | null;
  userAgent?: string | null;
  ip: string;
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
 * Trust-on-first-use is deliberately narrow: only a loopback caller can be
 * adopted, and only while no device is approved yet. That keeps `npm start` on
 * the Mac frictionless without ever handing the same shortcut to the public
 * tunnel — an empty allowlist reached from the network is a request to approve,
 * not a reason to trust. AGENTDECK_STRICT_BOOTSTRAP=1 disables adoption
 * entirely, including from loopback.
 */
export function authorizeDevice(
  store: DeviceStore,
  ctx: AuthContext,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AuthDecision {
  const id = (ctx.deviceId || '').trim() || `unidentified-${randomUUID()}`;

  // A damaged allowlist denies everything rather than degrading to "empty",
  // which would otherwise re-open the adoption path.
  if (store.isUnreadable()) {
    return {
      outcome: 'unavailable',
      device: {
        id,
        name: labelFromUserAgent(ctx.userAgent),
        status: 'pending',
        firstSeen: ctx.now,
        lastSeen: ctx.now,
        userAgent: ctx.userAgent || '',
        lastIp: ctx.ip,
      },
      isFirstSighting: false,
    };
  }

  const existing = store.get(id);

  if (existing) {
    if (existing.status === 'approved') {
      store.touch(id, ctx.now, ctx.ip);
      return { outcome: 'allow', device: existing, isFirstSighting: false };
    }
    if (existing.status === 'revoked') {
      store.touch(id, ctx.now, ctx.ip);
      return { outcome: 'revoked', device: existing, isFirstSighting: false };
    }
    store.touch(id, ctx.now, ctx.ip);
    return { outcome: 'pending', device: existing, isFirstSighting: false };
  }

  const strictBootstrap = env.AGENTDECK_STRICT_BOOTSTRAP === '1';
  const adoptSilently =
    !strictBootstrap && !store.hasApproved() && isLoopbackIp(ctx.ip);

  const record: DeviceRecord = {
    id,
    name: labelFromUserAgent(ctx.userAgent),
    status: adoptSilently ? 'approved' : 'pending',
    firstSeen: ctx.now,
    lastSeen: ctx.now,
    userAgent: ctx.userAgent || '',
    lastIp: ctx.ip,
    ...(adoptSilently ? {} : { approvalNonce: mintApprovalNonce() }),
  };
  store.upsert(record);

  return adoptSilently
    ? { outcome: 'allow', device: record, isFirstSighting: true, bootstrapped: true }
    : { outcome: 'pending', device: record, isFirstSighting: true };
}
