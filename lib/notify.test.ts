import test from 'node:test';
import assert from 'node:assert/strict';
import { composeApprovalMessage, notifyOwner, readNotifyConfig, type Fetcher } from './notify';
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

test('without a public url it falls back to approving on the Mac', () => {
  const text = composeApprovalMessage(device, {});
  assert.doesNotMatch(text, /api\/devices\/approve/);
  assert.match(text, /dev-1/);
});

test('a long user agent is truncated so the alert stays readable', () => {
  const text = composeApprovalMessage({ ...device, userAgent: 'x'.repeat(400) }, {});
  const uaLine = text.split('\n').find((l) => l.startsWith('User-Agent:'))!;
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
