import test from 'node:test';
import assert from 'node:assert/strict';
import { composeApprovalMessage, notifyOwner, readNotifyConfig, type Fetcher } from './notify';
import { nonceTtlLabel, NONCE_TTL_MS } from './device-auth';
import type { DeviceRecord } from './device-store';

const device: DeviceRecord = {
  id: 'dev-1',
  name: 'iPhone',
  status: 'pending',
  firstSeen: 1_700_000_000_000,
  lastSeen: 1_700_000_000_000,
  userAgent: 'Mozilla/5.0 (iPhone)',
  lastIp: '203.0.113.7',
  approvalNonce: 'nonce-abc',
};

test('reads config and trims a trailing slash off the public url', () => {
  const config = readNotifyConfig({
    AGENTDECK_TG_BOT_TOKEN: ' bot-token ',
    AGENTDECK_TG_CHAT_ID: ' 123 ',
    AGENTDECK_PUBLIC_URL: 'https://term.example.com/',
  });
  assert.equal(config.botToken, 'bot-token');
  assert.equal(config.chatId, '123');
  assert.equal(config.publicUrl, 'https://term.example.com');
});

test('the alert carries a one-tap approval link', () => {
  const text = composeApprovalMessage(device, { publicUrl: 'https://term.example.com' });
  assert.match(text, /iPhone/);
  assert.match(text, /203\.0\.113\.7/);
  assert.match(
    text,
    /https:\/\/term\.example\.com\/api\/devices\/approve\?nonce=nonce-abc/,
  );
});

test('the alert reads as an alarm, not as routine traffic', () => {
  // It shares a chat with daily pet-style cards; looking similar to them is how
  // a real intrusion notice gets swiped past.
  const text = composeApprovalMessage(device, { publicUrl: 'https://term.example.com' });
  assert.match(text.split('\n')[0]!, /SECURITY ALERT/, 'first line must announce itself');
  assert.match(text.split('\n')[0]!, /⛔/);
  assert.match(text, /IF THIS IS NOT YOU/, 'must tell the owner what to do when it is an attack');
  assert.match(text, /rotate it now/i, 'the actual remedy is rotating the token');
});

test('without a public url it falls back to approving on the Mac', () => {
  const text = composeApprovalMessage(device, {});
  assert.doesNotMatch(text, /api\/devices\/approve/);
  assert.match(text, /dev-1/);
  // The attack-path guidance must survive the fallback, not only the happy path.
  assert.match(text, /IF THIS IS NOT YOU/);
});

test('a long user agent is truncated so the alert stays readable', () => {
  const text = composeApprovalMessage({ ...device, userAgent: 'x'.repeat(400) }, {});
  const uaLine = text.split('\n').find((l) => l.startsWith('Agent:'));
  assert.ok(uaLine, 'the alert must still carry the user-agent line');
  assert.ok(uaLine.length < 160, `user-agent line was ${uaLine.length} chars`);
});

test('an unconfigured bot logs instead of throwing', async () => {
  const sent = await notifyOwner('hello', {}, async () => {
    throw new Error('must not be called');
  });
  assert.equal(sent, false);
});

test('a telegram outage never propagates to the connection path', async () => {
  const failing: Fetcher = async () => {
    throw new Error('network down');
  };
  const sent = await notifyOwner('hello', { botToken: 't', chatId: '1' }, failing);
  assert.equal(sent, false);
});

test('a non-2xx telegram reply is reported as not sent', async () => {
  const sent = await notifyOwner(
    'hello',
    { botToken: 't', chatId: '1' },
    async () => ({ ok: false, status: 403 }),
  );
  assert.equal(sent, false);
});

test('a delivered alert is logged, so delivery is auditable later', async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await notifyOwner('hello', { botToken: 't', chatId: '1234567890' }, async () => ({
      ok: true,
      status: 200,
    }));
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1, 'a successful send must leave evidence in the log');
  assert.match(lines[0]!, /delivered/);
  // Only the last digits — the log must not become a place chat ids leak from.
  assert.match(lines[0]!, /…7890/);
  assert.doesNotMatch(lines[0]!, /1234567890/);
});

test('posts the message to the configured chat', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const sent = await notifyOwner(
    'hello',
    { botToken: 'bot-token', chatId: 'chat-9' },
    async (url, init) => {
      calls.push({ url, body: init?.body ?? '' });
      return { ok: true, status: 200 };
    },
  );

  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/botbot-token\/sendMessage$/);
  const payload = JSON.parse(calls[0]!.body) as { chat_id: string; text: string; parse_mode?: string };
  assert.equal(payload.chat_id, 'chat-9');
  assert.equal(payload.text, 'hello');
  // No parse_mode: the attacker-controlled user agent must never be parsed as
  // markup that could forge a second link next to the real approval one.
  assert.equal(payload.parse_mode, undefined);
});

test('the alert quotes the real TTL, and no stale duration survives in the copy', () => {
  // Regression with teeth: when NONCE_TTL_MS went 15min → 60s, three strings
  // kept saying "15 minutes" — both the alert she reads and the expiry page she
  // lands on lied about how long she had. This test fails if a future TTL change
  // leaves any hardcoded duration behind.
  const text = composeApprovalMessage(device, { publicUrl: 'https://term.example.com' });
  const label = nonceTtlLabel();

  assert.ok(text.includes(label), `alert must quote "${label}"`);

  // Any duration mentioned must be the derived one. Collect every "<n> minute(s)"
  // / "<n> second(s)" in the text and assert they all match the label.
  const durations = text.match(/\d+\s*(?:minutes?|seconds?|min\b)/g) ?? [];
  assert.ok(durations.length > 0, 'the alert should state a lifetime at all');
  for (const d of durations) {
    assert.equal(d, label, `stale duration "${d}" in the alert; expected "${label}"`);
  }
});

test('nonceTtlLabel reads naturally at both scales', () => {
  // Guards the pluralisation, since the constant may move either way again.
  assert.match(nonceTtlLabel(), /^(1 minute|\d+ minutes|\d+ seconds)$/);
  assert.equal(NONCE_TTL_MS > 0, true);
});
