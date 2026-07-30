'use client';

/**
 * Client-side device identity. The id is minted once per browser and kept in
 * localStorage next to the token; it is an opaque handle, never a secret — the
 * server's allowlist decides what an id is allowed to do, so a copied id is
 * only useful on a device the owner already approved.
 *
 * 'ccrt-' prefix matches the pre-rename token key: renaming a localStorage key
 * silently orphans the stored value, which here would make every approved
 * device look brand new after an upgrade and bounce them all to pending.
 */
const DEVICE_ID_KEY = 'ccrt-device-id';

export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage disabled: fall back to a per-load id. The device
    // will read as new on every visit (extra approvals) but never as someone
    // else's approved device — failing closed, which is the safe direction.
    return `ephemeral-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * How this browser was launched. An installed home-screen app and the same
 * phone's browser have separate localStorage, so they are genuinely two
 * devices — this is what lets the devices list say which is which instead of
 * showing several identical rows.
 */
export function getDisplayMode(): 'standalone' | 'browser' {
  if (typeof window === 'undefined') return 'browser';
  try {
    const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
    const matches = window.matchMedia?.('(display-mode: standalone)').matches === true;
    return iosStandalone || matches ? 'standalone' : 'browser';
  } catch {
    return 'browser';
  }
}

/** Builds the terminal WebSocket URL with both factors the server checks. */
export function terminalWsUrl(token: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws/terminal?token=${encodeURIComponent(
    token,
  )}&deviceId=${encodeURIComponent(getDeviceId())}&displayMode=${getDisplayMode()}`;
}

export type AccessState =
  | 'checking'
  | 'approved'
  | 'pending'
  | 'revoked'
  | 'unauthorized'
  | 'no-device-id'
  | 'error';

/**
 * Pre-flight the WebSocket cannot do: a browser cannot read the status of a
 * failed upgrade, so without this the UI could not distinguish "wrong token"
 * from "waiting for approval". The real enforcement is still the WS layer.
 */
export async function checkDeviceAccess(token: string): Promise<AccessState> {
  try {
    const res = await fetch(
      `/api/devices/self?deviceId=${encodeURIComponent(
        getDeviceId(),
      )}&displayMode=${getDisplayMode()}`,
      { headers: { 'x-token': token }, cache: 'no-store' },
    );
    if (res.status === 401) return 'unauthorized';
    // 400 = this browser sent no device id, so it can never be approved. Worth
    // its own state: retrying will not help, and the fix is on this side.
    if (res.status === 400) return 'no-device-id';
    // 503 = the server cannot read its allowlist and is denying everyone. It is
    // surfaced as an error, not as pending: retrying is right, approving is not.
    if (!res.ok) return 'error';
    const body = (await res.json()) as { status?: string };
    if (body.status === 'approved') return 'approved';
    if (body.status === 'revoked') return 'revoked';
    return 'pending';
  } catch {
    return 'error';
  }
}
