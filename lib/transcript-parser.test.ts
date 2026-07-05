import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptParser, summarizeToolInput, MAX_TRANSCRIPT_MESSAGES } from './transcript-parser';

const ts = '2026-07-05T10:00:00.000Z';

function claudeLine(extra: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: ts, sessionId: 'sess-1', gitBranch: 'main', ...extra });
}

function codexLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: ts, type, payload });
}

describe('TranscriptParser (claude)', () => {
  it('parses user text and skips injected/meta content', () => {
    const p = new TranscriptParser('claude');

    const r1 = p.parseLine(claudeLine({
      type: 'user', uuid: 'u-1',
      message: { role: 'user', content: [{ type: 'text', text: '帮我看看这个布局' }, { type: 'image', source: {} }] },
    }));
    assert.equal(r1.upserts.length, 1);
    assert.equal(r1.upserts[0].role, 'user');
    assert.ok(r1.upserts[0].text.includes('帮我看看这个布局'));
    assert.ok(r1.upserts[0].text.includes('*[image]*'));

    // meta / injected lines produce no messages
    assert.equal(p.parseLine(claudeLine({ type: 'user', isMeta: true, message: { role: 'user', content: 'x' } })).upserts.length, 0);
    assert.equal(p.parseLine(claudeLine({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/foo</command-name>' }] },
    })).upserts.length, 0);
    assert.equal(p.parseLine(claudeLine({
      type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] },
    })).upserts.length, 0);
    assert.equal(p.count(), 1);
  });

  it('aggregates streamed assistant lines by message.id (one block per line)', () => {
    const p = new TranscriptParser('claude');
    const base = {
      type: 'assistant',
      message: { id: 'msg_A', role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } },
    };

    // line 1: thinking only — no visible content yet
    const r1 = p.parseLine(claudeLine({
      ...base, uuid: 'a-1',
      message: { ...base.message, content: [{ type: 'thinking', thinking: 'hmm' }] },
    }));
    assert.equal(r1.upserts.length, 0);
    assert.equal(r1.metaChanged, true); // model + usage arrived

    // line 2: text block
    const r2 = p.parseLine(claudeLine({
      ...base, uuid: 'a-2',
      message: { ...base.message, content: [{ type: 'text', text: '先看现状' }], usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 25 } },
    }));
    assert.equal(r2.upserts.length, 1);
    assert.equal(r2.upserts[0].id, 'msg_A');
    assert.equal(r2.upserts[0].text, '先看现状');

    // line 3: tool_use block merges into the same message
    const r3 = p.parseLine(claudeLine({
      ...base, uuid: 'a-3',
      message: { ...base.message, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git status' } }] },
    }));
    assert.equal(r3.upserts.length, 1);
    assert.equal(r3.upserts[0].id, 'msg_A');
    assert.equal(r3.upserts[0].tools.length, 1);
    assert.equal(r3.upserts[0].tools[0].name, 'Bash');
    assert.equal(r3.upserts[0].tools[0].summary, 'git status');

    assert.equal(p.count(), 1);
    // usage delta counted once per message despite repeats: 25, not 5+25+25
    assert.equal(p.meta.totalOutTokens, 25);
    assert.equal(p.meta.contextTokens, 100);
    assert.equal(p.meta.model, 'claude-opus-4-8');
    assert.equal(p.meta.gitBranch, 'main');
  });

  it('skips sidechain lines and captures ai-title', () => {
    const p = new TranscriptParser('claude');
    assert.equal(p.parseLine(claudeLine({
      type: 'assistant', isSidechain: true, uuid: 's-1',
      message: { id: 'msg_S', role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] },
    })).upserts.length, 0);

    const r = p.parseLine(JSON.stringify({ type: 'ai-title', aiTitle: '优化 UI 布局', sessionId: 'sess-1' }));
    assert.equal(r.metaChanged, true);
    assert.equal(p.meta.aiTitle, '优化 UI 布局');
  });

  it('never throws on malformed input', () => {
    const p = new TranscriptParser('claude');
    assert.equal(p.parseLine('{"type": "assistant", "message": ').upserts.length, 0);
    assert.equal(p.parseLine('null').upserts.length, 0);
    assert.equal(p.parseLine('42').upserts.length, 0);
    assert.equal(p.parseLine(claudeLine({ type: 'file-history-snapshot' })).upserts.length, 0);
  });

  it('caps the in-memory message list', () => {
    const p = new TranscriptParser('claude');
    for (let i = 0; i < MAX_TRANSCRIPT_MESSAGES + 50; i++) {
      p.parseLine(claudeLine({
        type: 'user', uuid: `u-${i}`,
        message: { role: 'user', content: `msg ${i}` },
      }));
    }
    assert.equal(p.count(), MAX_TRANSCRIPT_MESSAGES);
    assert.equal(p.all()[0].text, 'msg 50');
  });
});

describe('TranscriptParser (codex)', () => {
  it('parses messages, folds consecutive tool calls, drops developer/injected content', () => {
    const p = new TranscriptParser('codex');

    p.parseLine(codexLine('session_meta', { id: 'codex-sess-1', cwd: '/tmp/x', timestamp: ts }));
    assert.equal(p.meta.transcriptId, 'codex-sess-1');

    // developer & injected user content dropped
    assert.equal(p.parseLine(codexLine('response_item', {
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>…' }],
    })).upserts.length, 0);
    assert.equal(p.parseLine(codexLine('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }],
    })).upserts.length, 0);

    const u = p.parseLine(codexLine('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '查一下内存策略' }],
    }));
    assert.equal(u.upserts[0].role, 'user');

    // two consecutive function_calls fold into one tool-only assistant message
    const t1 = p.parseLine(codexLine('response_item', {
      type: 'function_call', name: 'search_memory', arguments: '{"query":"memory strategy"}', call_id: 'call_1',
    }));
    const t2 = p.parseLine(codexLine('response_item', {
      type: 'function_call', name: 'read_file', arguments: '{"path":"/tmp/a.md"}', call_id: 'call_2',
    }));
    assert.equal(t1.upserts[0].id, t2.upserts[0].id);
    assert.equal(t2.upserts[0].tools.length, 2);
    assert.equal(t2.upserts[0].tools[0].summary, 'memory strategy');

    // assistant text closes the fold
    const a = p.parseLine(codexLine('response_item', {
      type: 'message', role: 'assistant', id: 'am-1', content: [{ type: 'output_text', text: '查到了,结论如下' }],
    }));
    assert.equal(a.upserts[0].text, '查到了,结论如下');

    // a later function_call starts a NEW tool message
    const t3 = p.parseLine(codexLine('response_item', {
      type: 'function_call', name: 'write_file', arguments: '{}', call_id: 'call_3',
    }));
    assert.notEqual(t3.upserts[0].id, t1.upserts[0].id);

    assert.equal(p.count(), 4); // user + tools + assistant + tools
  });

  it('reads token_count into meta and model from turn_context', () => {
    const p = new TranscriptParser('codex');
    p.parseLine(codexLine('turn_context', { model: 'gpt-5.2-codex' }));
    assert.equal(p.meta.model, 'gpt-5.2-codex');

    const r = p.parseLine(codexLine('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 21936, cached_input_tokens: 4000, output_tokens: 900 },
        last_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 120 },
      },
    }));
    assert.equal(r.metaChanged, true);
    assert.equal(p.meta.contextTokens, 9000);
    assert.equal(p.meta.totalOutTokens, 900);
  });

  it('parses local_shell_call actions', () => {
    const p = new TranscriptParser('codex');
    const r = p.parseLine(codexLine('response_item', {
      type: 'local_shell_call', call_id: 'c1', action: { command: ['bash', '-lc', 'ls ~'] },
    }));
    assert.equal(r.upserts[0].tools[0].name, 'shell');
    assert.ok(r.upserts[0].tools[0].summary.includes('ls ~'));
  });
});

describe('summarizeToolInput', () => {
  it('prefers meaningful fields and truncates', () => {
    assert.equal(summarizeToolInput('Bash', { command: 'git log', description: 'x' }), 'git log');
    assert.equal(summarizeToolInput('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
    assert.equal(summarizeToolInput('X', { weird: 1 }), '{"weird":1}');
    assert.equal(summarizeToolInput('X', 'plain string arg'), 'plain string arg');
    const long = summarizeToolInput('X', { command: 'a'.repeat(300) });
    assert.ok(long.length <= 80);
  });
});
