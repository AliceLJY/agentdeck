import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTranscriptMessageBlock } from './history-format';

test('formats transcript messages as readable log blocks', () => {
  const block = formatTranscriptMessageBlock({
    id: 'm1',
    role: 'assistant',
    timestamp: '2026-05-01T00:17:48+08:00',
    text: '看到，测试连通。\n需要我做什么？',
  });

  assert.equal(
    block,
    'ASSISTANT 2026-05-01 00:17\n\n看到，测试连通。\n需要我做什么？',
  );
});
