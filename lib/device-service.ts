import { DeviceStore } from './device-store';
import { authorizeDevice, type AuthContext, type AuthDecision } from './device-auth';
import { composeApprovalMessage, notifyOwner, readNotifyConfig } from './notify';

/**
 * Shared allowlist instance. Every read re-reads the JSON file, so the custom
 * server and the Next.js route handlers stay consistent even when they do not
 * share a module graph.
 */
export const deviceStore = new DeviceStore();

/**
 * Header the custom server stamps with the real transport peer on every request,
 * overwriting anything the client sent under the same name. Route handlers have
 * no access to the socket, so this is their only trustworthy source — and it is
 * trustworthy precisely because the outermost layer always overwrites it.
 */
export const PEER_HEADER = 'x-agentdeck-peer';

function firstHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(',')[0]?.trim() || undefined;
}

/**
 * The address allowed to influence a decision. Derived only from the socket, or
 * from PEER_HEADER which the server stamps from the socket — never from
 * X-Forwarded-For, which any caller can set. Getting this wrong is a real
 * bypass: a remote request claiming `X-Forwarded-For: 127.0.0.1` would look
 * like loopback and adopt itself while the allowlist is still empty.
 */
export function authIp(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  socketAddress?: string,
): string {
  return socketAddress || firstHeader(headers, PEER_HEADER) || 'unknown';
}

/**
 * The address shown to the owner in the alert and the devices list. Prefers
 * X-Forwarded-For because behind Caddy that is the only way to see the phone's
 * real address — and a forged value here only misleads a human reading a log,
 * it can never widen access.
 */
export function displayIp(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  socketAddress?: string,
): string {
  return (
    firstHeader(headers, 'x-forwarded-for') ||
    socketAddress ||
    firstHeader(headers, PEER_HEADER) ||
    'unknown'
  );
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

  // Logged, never stored: a client with no device id cannot be approved, so
  // recording it would only add a row nothing can ever match. The user agent is
  // kept because the cause is still unidentified — this line is the evidence
  // the next occurrence will be diagnosed from.
  if (decision.outcome === 'no-device-id') {
    console.error(
      `[agentdeck] Rejecting request without a device id — ua=${JSON.stringify(
        decision.device.userAgent.slice(0, 160),
      )} ip=${decision.device.lastIp}`,
    );
    return decision;
  }

  if (decision.outcome === 'pending' && decision.isFirstSighting) {
    const config = readNotifyConfig();
    const text = composeApprovalMessage(decision.device, config);
    void notifyOwner(text, config);
    console.warn(
      `[agentdeck] Blocked unknown device ${decision.device.id} (${decision.device.name}) from ${decision.device.lastIp} (peer ${ctx.peerIp})`,
    );
  }

  return decision;
}
