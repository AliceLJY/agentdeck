import type { DeviceRecord } from './device-store';

export interface NotifyConfig {
  botToken?: string;
  chatId?: string;
  publicUrl?: string;
}

export function readNotifyConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NotifyConfig {
  return {
    botToken: env.AGENTDECK_TG_BOT_TOKEN?.trim() || undefined,
    chatId: env.AGENTDECK_TG_CHAT_ID?.trim() || undefined,
    publicUrl: env.AGENTDECK_PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined,
  };
}

/**
 * Composes the owner-facing alert. Kept separate from delivery so the wording
 * is testable without a network, and so the same text can go to the log when
 * Telegram is not configured.
 *
 * Sent as plain text on purpose: the User-Agent is attacker-controlled, and
 * Telegram's HTML/Markdown modes would let a crafted one inject formatting or
 * a bogus link next to a message the owner is about to trust.
 */
const RULE = '━━━━━━━━━━━━━━━━━━━━';

export function composeApprovalMessage(
  device: DeviceRecord,
  config: NotifyConfig,
): string {
  const when = new Date(device.firstSeen).toLocaleString('sv-SE');
  // Deliberately loud. This alert may land in a chat that also carries daily
  // pet-style cards, and an alert that looks like the routine traffic around it
  // gets swiped past — the one time it matters is the one time it must not.
  const lines = [
    '⛔⛔⛔ SECURITY ALERT ⛔⛔⛔',
    RULE,
    'UNKNOWN DEVICE REQUESTING ACCESS',
    RULE,
    '',
    `Device:  ${device.name}`,
    `IP:      ${device.lastIp}`,
    `Time:    ${when}`,
    `Agent:   ${truncate(device.userAgent, 120)}`,
    '',
  ];

  if (config.publicUrl && device.approvalNonce) {
    lines.push(
      '✅ IF THIS IS YOU — tap to approve (link expires in 15 min):',
      `${config.publicUrl}/api/devices/approve?nonce=${device.approvalNonce}`,
      '',
      RULE,
      '⚠️ IF THIS IS NOT YOU:',
      '   1. Do NOT tap that link.',
      '   2. Someone has your access token — rotate it now.',
      '   3. The device stays blocked until approved, so there is no rush,',
      '      but the token is what leaked.',
      '   4. This link dies on its own in 15 minutes — a stray tap on an old',
      '      alert later cannot let anything in.',
    );
  } else {
    lines.push(
      '✅ IF THIS IS YOU — approve on the Mac:',
      `   device id ${device.id}`,
      '   (set AGENTDECK_PUBLIC_URL for a one-tap link here instead)',
      '',
      RULE,
      '⚠️ IF THIS IS NOT YOU: someone has your access token — rotate it now.',
    );
  }

  return lines.join('\n');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export type Fetcher = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Best-effort delivery: a failed notification must never take the server down
 * or block the connection path, so every error is logged and swallowed.
 * Returns whether the message actually went out.
 */
export async function notifyOwner(
  text: string,
  config: NotifyConfig,
  fetcher: Fetcher = fetch as unknown as Fetcher,
): Promise<boolean> {
  if (!config.botToken || !config.chatId) {
    console.warn('[agentdeck] Device alert (Telegram not configured):\n' + text);
    return false;
  }

  try {
    const res = await fetcher(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      console.error(`[agentdeck] Telegram alert failed: HTTP ${res.status}`);
      return false;
    }
    // Log the success too. Without this the only evidence of delivery is the
    // absence of an error, which cannot answer "did the alert actually go out?"
    // months later — the one question worth asking after a real intrusion.
    console.log(`[agentdeck] Telegram alert delivered to chat …${config.chatId.slice(-4)}`);
    return true;
  } catch (err) {
    console.error('[agentdeck] Telegram alert failed:', err);
    return false;
  }
}
