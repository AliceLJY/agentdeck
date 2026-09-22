import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTranscriptMessageBlock, shortTranscriptId } from './history-format';

test('shortTranscriptId shows eight recognisable characters, skipping kimi’s shared prefix', () => {
  assert.equal(shortTranscriptId('3f012c13-213b-4581-a639-91d35be9595b'), '3f012c13');
  assert.equal(shortTranscriptId('session_a5c31249-7e55-4638-96d7-b1cf1362cdd3'), 'a5c31249');
});

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
