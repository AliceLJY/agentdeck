import { NextRequest, NextResponse } from 'next/server';
import { normalizeBackend } from '@/lib/backends';
import { readClaudeTranscript, readCodexTranscript } from '@/lib/history-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.headers.get('x-token');
  if (token !== process.env.CC_TERMINAL_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const projectId = req.nextUrl.searchParams.get('projectId');
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const backend = normalizeBackend(req.nextUrl.searchParams.get('backend'));

  if (!projectId || !sessionId) {
    return NextResponse.json(
      { error: 'projectId and sessionId are required' },
      { status: 400 },
    );
  }

  try {
    const transcript = backend === 'codex'
      ? await readCodexTranscript({ projectId, sessionId })
      : await readClaudeTranscript({ projectId, sessionId });
    return NextResponse.json(transcript);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load transcript';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
