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
export function composeApprovalMessage(
  device: DeviceRecord,
  config: NotifyConfig,
): string {
  const when = new Date(device.firstSeen).toLocaleString('sv-SE');
  const lines = [
    '🔐 AgentDeck: a new device is asking to connect',
    '',
    `Device: ${device.name}`,
    `IP: ${device.lastIp}`,
    `Time: ${when}`,
    `User-Agent: ${truncate(device.userAgent, 120)}`,
    '',
  ];

  if (config.publicUrl && device.approvalNonce) {
    lines.push(
      'Approve (only if this is you):',
      `${config.publicUrl}/api/devices/approve?nonce=${device.approvalNonce}`,
      '',
      'If this was not you, ignore this message — the device stays blocked, and',
      'your access token should be rotated.',
    );
  } else {
    lines.push(
      `Approve on the Mac: device id ${device.id}`,
      'Set AGENTDECK_PUBLIC_URL to get a one-tap approval link here instead.',
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
    return true;
  } catch (err) {
    console.error('[agentdeck] Telegram alert failed:', err);
    return false;
  }
}
