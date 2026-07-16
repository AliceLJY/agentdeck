import type { ClaudeTranscriptMessage } from './history-index';

const timestampFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatTranscriptMessageBlock(message: ClaudeTranscriptMessage): string {
  const timestamp = formatTimestamp(message.timestamp);
  const header = timestamp ? `${message.role.toUpperCase()} ${timestamp}` : message.role.toUpperCase();
  return `${header}\n\n${message.text}`;
}

function formatTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const requestedTimeZone = process.env.CC_TERMINAL_TIME_ZONE?.trim() || 'Asia/Singapore';
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = timestampFormatter(requestedTimeZone);
  } catch {
    formatter = timestampFormatter('Asia/Singapore');
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(time))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const { year, month, day, hour, minute } = parts;
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function timestampFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = timestampFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  timestampFormatters.set(timeZone, formatter);
  return formatter;
}
