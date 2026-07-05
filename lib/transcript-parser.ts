import type { HistoryBackend } from './backends';
import type { ChatMessage, ToolCallInfo, TranscriptMeta } from './types';

/**
 * Incremental transcript parser: feed it raw JSONL lines from a live
 * Claude Code / Codex session file and it maintains an ordered, aggregated
 * chat message list plus session meta (model, tokens, branch, title).
 *
 * Aggregation model (verified against real files):
 * - Claude streams one content block per JSONL line; lines belonging to the
 *   same API response share `message.id`, so we upsert-merge on that id.
 * - Codex emits one `response_item` per line; consecutive `function_call`
 *   items are folded into one tool-only assistant message.
 *
 * parseLine() never throws — unknown types, partial writes, and format
 * drift all degrade to "skip the line".
 */

export interface ParseResult {
  upserts: ChatMessage[];
  metaChanged: boolean;
}

const EMPTY_RESULT: ParseResult = { upserts: [], metaChanged: false };
const MAX_SUMMARY = 80;
/** Cap the in-memory message list; oldest entries are dropped past this. */
export const MAX_TRANSCRIPT_MESSAGES = 1000;

export class TranscriptParser {
  readonly backend: HistoryBackend;
  readonly meta: TranscriptMeta = {};

  private messages = new Map<string, ChatMessage>();
  private order: string[] = [];
  private seq = 0;
  /** Codex: id of the trailing tool-only assistant message to fold calls into. */
  private codexToolMsgId: string | null = null;
  /** Claude: output tokens already counted per message.id (usage repeats per line). */
  private outByMsg = new Map<string, number>();

  constructor(backend: HistoryBackend) {
    this.backend = backend;
  }

  all(): ChatMessage[] {
    return this.order
      .map((id) => this.messages.get(id))
      .filter((m): m is ChatMessage => Boolean(m));
  }

  count(): number {
    return this.order.length;
  }

  parseLine(line: string): ParseResult {
    const trimmed = line.trim();
    if (!trimmed) return EMPTY_RESULT;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return EMPTY_RESULT; // partial write; watcher will re-feed the full line
    }
    if (!event || typeof event !== 'object') return EMPTY_RESULT;

    try {
      return this.backend === 'codex'
        ? this.parseCodexEvent(event)
        : this.parseClaudeEvent(event);
    } catch {
      return EMPTY_RESULT; // format drift must never kill the stream
    }
  }

  // ─── Claude ───

  private parseClaudeEvent(event: Record<string, unknown>): ParseResult {
    let metaChanged = false;

    if (typeof event.gitBranch === 'string' && event.gitBranch && event.gitBranch !== this.meta.gitBranch) {
      this.meta.gitBranch = event.gitBranch;
      metaChanged = true;
    }
    if (typeof event.sessionId === 'string' && event.sessionId && event.sessionId !== this.meta.transcriptId) {
      this.meta.transcriptId = event.sessionId;
      metaChanged = true;
    }

    if (event.type === 'ai-title') {
      if (typeof event.aiTitle === 'string' && event.aiTitle) {
        this.meta.aiTitle = event.aiTitle;
        metaChanged = true;
      }
      return { upserts: [], metaChanged };
    }

    // Sub-agent transcripts share the file; keep the chat view on the main thread.
    if (event.isSidechain === true) return { upserts: [], metaChanged };
    if (event.type !== 'user' && event.type !== 'assistant') {
      return { upserts: [], metaChanged };
    }

    const message = asRecord(event.message);
    if (!message) return { upserts: [], metaChanged };
    const timestamp = typeof event.timestamp === 'string'
      ? event.timestamp
      : new Date().toISOString();

    if (event.type === 'user') {
      if (event.isMeta === true) return { upserts: [], metaChanged };
      const text = claudeUserText(message.content);
      if (!text) return { upserts: [], metaChanged };
      const id = typeof event.uuid === 'string' && event.uuid ? event.uuid : `u${this.seq++}`;
      const msg: ChatMessage = { id, role: 'user', text, tools: [], timestamp };
      this.upsert(msg);
      this.codexToolMsgId = null;
      return { upserts: [msg], metaChanged };
    }

    // assistant — aggregate streamed lines on message.id
    const msgId = typeof message.id === 'string' && message.id
      ? message.id
      : (typeof event.uuid === 'string' && event.uuid ? event.uuid : `a${this.seq++}`);

    if (typeof message.model === 'string' && message.model && message.model !== this.meta.model) {
      this.meta.model = message.model;
      metaChanged = true;
    }
    if (this.applyClaudeUsage(msgId, asRecord(message.usage))) metaChanged = true;

    const content = Array.isArray(message.content) ? message.content : [];
    const existing = this.messages.get(msgId);
    const msg: ChatMessage = existing ?? { id: msgId, role: 'assistant', text: '', tools: [], timestamp };

    let changed = false;
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        msg.text = msg.text ? `${msg.text}\n\n${block.text}` : block.text;
        changed = true;
      } else if (block.type === 'tool_use') {
        msg.tools.push(toToolInfo(block.id, block.name, block.input));
        changed = true;
      }
      // thinking / redacted_thinking / images: skipped by design
    }

    if (!existing && !changed) return { upserts: [], metaChanged };
    if (!existing) this.upsert(msg);
    return { upserts: changed || !existing ? [msg] : [], metaChanged };
  }

  private applyClaudeUsage(msgId: string, usage: Record<string, unknown> | null): boolean {
    if (!usage) return false;
    const input = numberOr0(usage.input_tokens)
      + numberOr0(usage.cache_read_input_tokens)
      + numberOr0(usage.cache_creation_input_tokens);
    const output = numberOr0(usage.output_tokens);

    let changed = false;
    if (input > 0 && input !== this.meta.contextTokens) {
      this.meta.contextTokens = input;
      changed = true;
    }
    // usage repeats on every streamed line of the same message — count the delta only
    const prev = this.outByMsg.get(msgId) || 0;
    if (output > prev) {
      this.meta.totalOutTokens = (this.meta.totalOutTokens || 0) + (output - prev);
      this.outByMsg.set(msgId, output);
      changed = true;
    }
    return changed;
  }

  // ─── Codex ───

  private parseCodexEvent(event: Record<string, unknown>): ParseResult {
    const payload = asRecord(event.payload);
    if (!payload) return EMPTY_RESULT;
    const timestamp = typeof event.timestamp === 'string'
      ? event.timestamp
      : new Date().toISOString();

    if (event.type === 'session_meta') {
      let metaChanged = false;
      if (typeof payload.id === 'string' && payload.id && payload.id !== this.meta.transcriptId) {
        this.meta.transcriptId = payload.id;
        metaChanged = true;
      }
      return { upserts: [], metaChanged };
    }

    if (event.type === 'turn_context') {
      const model = typeof payload.model === 'string' ? payload.model : '';
      if (model && model !== this.meta.model) {
        this.meta.model = model;
        return { upserts: [], metaChanged: true };
      }
      return EMPTY_RESULT;
    }

    if (event.type === 'event_msg') {
      if (payload.type === 'token_count') return this.applyCodexTokens(payload);
      return EMPTY_RESULT;
    }

    if (event.type !== 'response_item') return EMPTY_RESULT;

    if (payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') return EMPTY_RESULT; // drops 'developer' injections
      const text = codexMessageText(payload.content);
      if (!text) return EMPTY_RESULT;
      if (role === 'user' && isCodexInjectedText(text)) return EMPTY_RESULT;

      const id = typeof payload.id === 'string' && payload.id ? payload.id : `${role[0]}${this.seq++}`;
      const msg: ChatMessage = { id, role, text, tools: [], timestamp };
      this.upsert(msg);
      this.codexToolMsgId = null;
      return { upserts: [msg], metaChanged: false };
    }

    const tool = codexToolFromPayload(payload);
    if (tool) {
      // Fold consecutive tool calls into one tool-only assistant message.
      let msg = this.codexToolMsgId ? this.messages.get(this.codexToolMsgId) : undefined;
      if (!msg) {
        msg = { id: `t${this.seq++}`, role: 'assistant', text: '', tools: [], timestamp };
        this.upsert(msg);
        this.codexToolMsgId = msg.id;
      }
      msg.tools.push(tool);
      return { upserts: [msg], metaChanged: false };
    }

    return EMPTY_RESULT;
  }

  private applyCodexTokens(payload: Record<string, unknown>): ParseResult {
    const info = asRecord(payload.info);
    if (!info) return EMPTY_RESULT;
    const total = asRecord(info.total_token_usage);
    const last = asRecord(info.last_token_usage) || total;

    let changed = false;
    if (last) {
      const ctx = numberOr0(last.input_tokens) + numberOr0(last.cached_input_tokens);
      if (ctx > 0 && ctx !== this.meta.contextTokens) {
        this.meta.contextTokens = ctx;
        changed = true;
      }
    }
    if (total) {
      const out = numberOr0(total.output_tokens);
      if (out > 0 && out !== this.meta.totalOutTokens) {
        this.meta.totalOutTokens = out; // already cumulative
        changed = true;
      }
    }
    return { upserts: [], metaChanged: changed };
  }

  // ─── Shared ───

  private upsert(msg: ChatMessage): void {
    if (!this.messages.has(msg.id)) {
      this.order.push(msg.id);
      if (this.order.length > MAX_TRANSCRIPT_MESSAGES) {
        const dropped = this.order.splice(0, this.order.length - MAX_TRANSCRIPT_MESSAGES);
        for (const id of dropped) {
          this.messages.delete(id);
          this.outByMsg.delete(id);
        }
      }
    }
    this.messages.set(msg.id, msg);
  }
}

// ─── Content helpers ───

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function claudeUserText(content: unknown): string {
  if (typeof content === 'string') return filterUserText(content);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = filterUserText(block.text);
      if (text) parts.push(text);
    } else if (block.type === 'image') {
      parts.push('*[image]*');
    }
    // tool_result blocks intentionally skipped — results show in the terminal
  }
  return parts.join('\n\n').trim();
}

/** Drop TUI-injected user content (slash-command envelopes, reminders). */
function filterUserText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('<command-')) return '';
  if (trimmed.startsWith('<local-command-')) return '';
  if (trimmed.startsWith('<system-reminder>')) return '';
  return trimmed;
}

function codexMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (
      (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
      && typeof block.text === 'string' && block.text.trim()
    ) {
      parts.push(block.text.trim());
    } else if (block.type === 'input_image' || block.type === 'image') {
      parts.push('*[image]*');
    }
  }
  return parts.join('\n\n').trim();
}

function isCodexInjectedText(text: string): boolean {
  return text.startsWith('# AGENTS.md instructions for ')
    || text.startsWith('<environment_context>')
    || text.startsWith('<user_instructions>')
    || text.startsWith('<permissions instructions>');
}

function codexToolFromPayload(payload: Record<string, unknown>): ToolCallInfo | null {
  const id = typeof payload.call_id === 'string' && payload.call_id
    ? payload.call_id
    : (typeof payload.id === 'string' ? payload.id : '');

  if (payload.type === 'function_call') {
    const name = typeof payload.name === 'string' && payload.name ? payload.name : 'tool';
    return { id: id || name, name, summary: summarizeToolInput(name, parseMaybeJson(payload.arguments)) };
  }
  if (payload.type === 'local_shell_call') {
    const action = asRecord(payload.action);
    const command = action && Array.isArray(action.command) ? action.command.join(' ') : '';
    return { id: id || 'shell', name: 'shell', summary: truncate(command, MAX_SUMMARY) };
  }
  if (payload.type === 'custom_tool_call') {
    const name = typeof payload.name === 'string' && payload.name ? payload.name : 'tool';
    return { id: id || name, name, summary: summarizeToolInput(name, parseMaybeJson(payload.input)) };
  }
  if (payload.type === 'image_generation_call') {
    return { id: id || 'image_generation', name: 'image_generation', summary: '' };
  }
  // web_search_call / reasoning / function_call_output / …: not rendered
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Pick the most human-meaningful field of a tool input for a one-line summary. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (typeof input === 'string') return truncate(input, MAX_SUMMARY);
  const record = asRecord(input);
  if (!record) return '';
  const preferred = [
    'command', 'file_path', 'path', 'pattern', 'query', 'url',
    'description', 'prompt', 'skill', 'subject', 'title', 'text',
  ];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return truncate(value.trim(), MAX_SUMMARY);
  }
  const keys = Object.keys(record);
  if (keys.length === 0) return '';
  try {
    return truncate(JSON.stringify(record), MAX_SUMMARY);
  } catch {
    return keys.slice(0, 3).join(', ');
  }
}

function toToolInfo(id: unknown, name: unknown, input: unknown): ToolCallInfo {
  const toolName = typeof name === 'string' && name ? name : 'tool';
  return {
    id: typeof id === 'string' && id ? id : toolName,
    name: toolName,
    summary: summarizeToolInput(toolName, input),
  };
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}
