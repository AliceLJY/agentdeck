import { NextRequest, NextResponse } from 'next/server';
import { deviceStore } from '@/lib/device-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One-tap approval reached from the Telegram alert. Authorised by the
 * single-use nonce in the link itself, NOT by the access token — the whole
 * point is that the owner taps it from their phone's Telegram, which has no
 * token. The nonce is minted per pending device and cleared the instant it is
 * spent (see DeviceStore.setStatus), so a forwarded or logged link cannot
 * approve anything twice.
 */
export async function GET(req: NextRequest) {
  const nonce = req.nextUrl.searchParams.get('nonce') || '';
  const device = deviceStore.findByNonce(nonce);

  if (!device) {
    return htmlResponse(
      'Link expired',
      'This approval link has already been used or is no longer valid. If a device still needs access, open it again to trigger a fresh request.',
      410,
    );
  }

  deviceStore.setStatus(device.id, 'approved');
  console.log(`[agentdeck] Device ${device.id} (${device.name}) approved via link`);

  return htmlResponse(
    'Device approved',
    `${device.name} can now connect. If you did not request this, revoke it from the Devices panel and rotate your access token.`,
    200,
  );
}

function htmlResponse(title: string, body: string, status: number): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0f19;color:#e5e7eb;display:flex;min-height:100dvh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:22rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#9ca3af;line-height:1.5;font-size:.95rem}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
