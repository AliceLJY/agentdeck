/**
 * Wrap text in bracketed-paste markers.
 *
 * A multi-line paste sent raw to the PTY submits on every newline — the TUI
 * reads each `\n` as Enter. Inside these markers it arrives as one block and
 * the user decides when to submit. The server does the same for `chat_input`
 * (see lib/ws-handler.ts); this is the client-side path for terminal pastes.
 */
export function bracketed(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/**
 * Write to the clipboard for a copy button. Returns false when unavailable.
 *
 * simplified: secure-context Clipboard API only. The tunnel keeps a plain-HTTP
 * route as a fallback for the day sslip.io goes down, and there the button
 * reports failure instead of copying. Add the execCommand path only if that
 * fallback route stops being rare.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the clipboard for a paste button. Returns null when the read is
 * unavailable or denied — Clipboard.readText needs a secure context (HTTPS)
 * and, on iOS, a user gesture plus the system paste confirmation.
 */
export async function readClipboard(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    const text = await navigator.clipboard.readText();
    return text || null;
  } catch {
    return null;
  }
}
