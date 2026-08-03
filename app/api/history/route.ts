import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedApiDevice } from '@/lib/api-auth';
import { normalizeBackendFilter } from '@/lib/backends';
import { buildHistoryIndex } from '@/lib/history-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authError = await requireApprovedApiDevice(req.headers);
  if (authError) return authError;

  const limit = Number(req.nextUrl.searchParams.get('limit') || '25');
  const projectId = req.nextUrl.searchParams.get('projectId') || undefined;
  const backend = normalizeBackendFilter(req.nextUrl.searchParams.get('backend'));

  try {
    const index = await buildHistoryIndex({ backend, limit, projectId });
    return NextResponse.json(index);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load history';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
