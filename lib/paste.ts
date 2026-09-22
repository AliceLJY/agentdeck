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
 * The Clipboard API only exists in a secure context, and plain HTTP is not a
 * rare fallback: the phone reaches AgentDeck at http://<tailscale-ip>:3109
 * through the tailscale node in its FlClash override (so VPN and tailscale can
 * run together). There, fall back to execCommand('copy') on a hidden textarea —
 * deprecated but still honoured inside the tap that triggered it.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable — try the legacy path below.
    }
  }
  return copyViaTextarea(text);
}

function copyViaTextarea(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', ''); // no soft keyboard on phones
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length); // iOS ignores select() alone
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
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
