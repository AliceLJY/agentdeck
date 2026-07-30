'use client';

import { useCallback, useEffect, useState } from 'react';
import { getDeviceId } from '@/lib/device-client';

interface DeviceRow {
  id: string;
  name: string;
  status: 'approved' | 'pending' | 'revoked';
  firstSeen: number;
  lastSeen: number;
  lastIp: string;
  userAgent: string;
}

interface DevicesPanelProps {
  token: string;
  onClose: () => void;
}

/**
 * The panel that makes "my phone was stolen" actionable from whatever device is
 * still in your hands — the reason this is UI and not just a curl recipe. It
 * also answers the question the deck could not answer at all before: who is
 * connected, and from where.
 */
export default function DevicesPanel({ token, onClose }: DevicesPanelProps) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const thisDevice = getDeviceId();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/devices', {
        headers: { 'x-token': token },
        cache: 'no-store',
      });
      if (!res.ok) {
        setError(res.status === 503 ? 'Allowlist unreadable on the server' : `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { devices: DeviceRow[] };
      setDevices(body.devices);
      setError(null);
    } catch {
      setError('Could not reach the server');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (deviceId: string, action: 'approve' | 'revoke' | 'delete') => {
      setBusy(deviceId);
      try {
        await fetch('/api/devices', {
          method: 'POST',
          headers: { 'x-token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, deviceId }),
        });
        await load();
      } finally {
        setBusy(null);
      }
    },
    [token, load],
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="w-full sm:max-w-lg max-h-[85dvh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold">Devices</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 px-2 py-1"
          >
            Done
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {!error && devices === null && (
            <p className="text-sm text-gray-500">Loading…</p>
          )}
          {devices?.length === 0 && (
            <p className="text-sm text-gray-500">No devices recorded yet.</p>
          )}

          <ul className="flex flex-col gap-2">
            {devices?.map((d) => (
              <li
                key={d.id}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{d.name}</span>
                      {d.id === thisDevice && (
                        <span className="text-[10px] uppercase tracking-wide text-blue-600 dark:text-blue-400">
                          this device
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {statusLabel(d.status)} · {d.lastIp} · seen {relative(d.lastSeen)}
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-1">
                    {d.status === 'pending' && (
                      <button
                        type="button"
                        disabled={busy === d.id}
                        onClick={() => void act(d.id, 'approve')}
                        className="text-xs rounded-md bg-blue-600 text-white px-2 py-1 disabled:opacity-50"
                      >
                        Approve
                      </button>
                    )}
                    {d.status !== 'revoked' && (
                      <button
                        type="button"
                        disabled={busy === d.id}
                        onClick={() => void act(d.id, 'revoke')}
                        className="text-xs rounded-md border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 px-2 py-1 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    )}
                    {d.status === 'revoked' && (
                      <button
                        type="button"
                        disabled={busy === d.id}
                        onClick={() => void act(d.id, 'delete')}
                        className="text-xs rounded-md border border-gray-300 dark:border-gray-700 px-2 py-1 disabled:opacity-50"
                      >
                        Forget
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
            Revoking affects only that device. If a token leaked rather than a
            phone, rotate <code>AGENTDECK_TOKEN</code> as well — revoking a
            device does not invalidate the token.
          </p>
        </div>
      </div>
    </div>
  );
}

function statusLabel(status: DeviceRow['status']): string {
  if (status === 'approved') return 'Approved';
  if (status === 'pending') return 'Waiting for approval';
  return 'Revoked';
}

function relative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
