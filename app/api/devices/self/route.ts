import { NextRequest, NextResponse } from 'next/server';
import { authIp, authorizeAndNotify, displayIp } from '@/lib/device-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pre-flight the browser runs before opening the terminal WebSocket.
 *
 * It exists because a browser cannot read the status code or body of a failed
 * WebSocket upgrade — without this the UI could not tell "wrong token" apart
 * from "waiting for the owner to approve this device". The WebSocket layer
 * repeats the same check, so a client that skips this call gains nothing.
 */
export async function GET(req: NextRequest) {
  const token = req.headers.get('x-token');
  if (token !== (process.env.AGENTDECK_TOKEN || process.env.CC_TERMINAL_TOKEN)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deviceId = req.nextUrl.searchParams.get('deviceId');
  const headers = Object.fromEntries(req.headers.entries());

  const decision = await authorizeAndNotify({
    deviceId,
    userAgent: req.headers.get('user-agent'),
    displayMode: req.nextUrl.searchParams.get('displayMode'),
    // No socket here — authIp reads only the peer header the custom server
    // stamps from the socket, so X-Forwarded-For cannot reach this decision.
    peerIp: authIp(headers),
    displayIp: displayIp(headers),
    now: Date.now(),
  });

  if (decision.outcome === 'unavailable') {
    return NextResponse.json({ status: 'unavailable' }, { status: 503 });
  }

  if (decision.outcome === 'no-device-id') {
    return NextResponse.json({ status: 'no-device-id' }, { status: 400 });
  }

  return NextResponse.json({
    status: decision.outcome === 'allow' ? 'approved' : decision.outcome,
    deviceId: decision.device.id,
    name: decision.device.name,
  });
}
