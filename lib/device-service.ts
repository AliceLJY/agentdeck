import { DeviceStore } from './device-store';
import { authorizeDevice, type AuthContext, type AuthDecision } from './device-auth';
import { composeApprovalMessage, notifyOwner, readNotifyConfig } from './notify';

/**
 * Shared allowlist instance. Every read re-reads the JSON file, so the custom
 * server and the Next.js route handlers stay consistent even when they do not
 * share a module graph.
 */
export const deviceStore = new DeviceStore();

/** Trusted only for display. A forged X-Forwarded-For changes what the owner
 *  sees in the alert, never whether the device is allowed in — that decision
 *  rests entirely on the device id being already approved. */
export function clientIp(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  socketAddress?: string,
): string {
  const forwarded = headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) return first.split(',')[0]!.trim();
  return socketAddress || 'unknown';
}

/**
 * Authorizes a device and fires the owner alert when — and only when — the
 * record is created. A blocked phone reconnecting on a loop would otherwise
 * turn the alert into a notification flood, and a flood gets muted, which is
 * exactly when the real intrusion arrives.
 */
export async function authorizeAndNotify(ctx: AuthContext): Promise<AuthDecision> {
  const decision = authorizeDevice(deviceStore, ctx);

  if (decision.outcome === 'unavailable') {
    console.error('[agentdeck] Denying connection: device allowlist unreadable');
    return decision;
  }

  if (decision.outcome === 'pending' && decision.isFirstSighting) {
    const config = readNotifyConfig();
    const text = composeApprovalMessage(decision.device, config);
    void notifyOwner(text, config);
    console.warn(
      `[agentdeck] Blocked unknown device ${decision.device.id} (${decision.device.name}) from ${decision.device.lastIp}`,
    );
  }

  if (decision.bootstrapped) {
    console.log(
      `[agentdeck] Adopted first device ${decision.device.id} (${decision.device.name}) — allowlist was empty`,
    );
  }

  return decision;
}
