import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedApiDevice } from '@/lib/api-auth';
import { deviceStore } from '@/lib/device-service';
import { publicDeviceRecord, type DeviceRecord } from '@/lib/device-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List every known device so the owner can see who is connected and act. */
export async function GET(req: NextRequest) {
  const authError = await requireApprovedApiDevice(req.headers);
  if (authError) return authError;
  return NextResponse.json({ devices: deviceStore.list().map(publicDeviceRecord) });
}

/**
 * Approve / revoke / rename / delete a device from the in-app panel. Revoke is
 * the answer to "my phone was stolen": it flips one record to `revoked` and
 * every other device keeps working — the coarse "rotate the shared token"
 * hammer is no longer the only option.
 */
export async function POST(req: NextRequest) {
  const authError = await requireApprovedApiDevice(req.headers);
  if (authError) return authError;

  let payload: { action?: string; deviceId?: string; name?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { action, deviceId, name } = payload;
  if (!deviceId) {
    return NextResponse.json({ error: 'deviceId required' }, { status: 400 });
  }

  switch (action) {
    case 'approve': {
      const updated = deviceStore.setStatus(deviceId, 'approved');
      return respond(updated);
    }
    case 'revoke': {
      const updated = deviceStore.setStatus(deviceId, 'revoked');
      return respond(updated);
    }
    case 'rename': {
      if (!name?.trim()) {
        return NextResponse.json({ error: 'name required' }, { status: 400 });
      }
      const updated = deviceStore.rename(deviceId, name.trim());
      return respond(updated);
    }
    case 'delete': {
      deviceStore.remove(deviceId);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}

function respond(device: DeviceRecord | undefined): NextResponse {
  if (!device) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, device: publicDeviceRecord(device) });
}
