import { NextRequest, NextResponse } from 'next/server';
import { deviceStore } from '@/lib/device-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const token = req.headers.get('x-token');
  return token === (process.env.AGENTDECK_TOKEN || process.env.CC_TERMINAL_TOKEN);
}

/** List every known device so the owner can see who is connected and act. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ devices: deviceStore.list() });
}

/**
 * Approve / revoke / rename / delete a device from the in-app panel. Revoke is
 * the answer to "my phone was stolen": it flips one record to `revoked` and
 * every other device keeps working — the coarse "rotate the shared token"
 * hammer is no longer the only option.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

function respond(device: unknown): NextResponse {
  if (!device) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, device });
}
