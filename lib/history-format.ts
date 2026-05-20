import type { ClaudeTranscriptMessage } from './history-index';

export function formatTranscriptMessageBlock(message: ClaudeTranscriptMessage): string {
  const timestamp = formatTimestamp(message.timestamp);
  const header = timestamp ? `${message.role.toUpperCase()} ${timestamp}` : message.role.toUpperCase();
  return `${header}\n\n${message.text}`;
}

function formatTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
