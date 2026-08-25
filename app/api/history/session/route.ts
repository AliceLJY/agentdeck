import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedApiDevice } from '@/lib/api-auth';
import { normalizeBackend } from '@/lib/backends';
import { readAgyTranscript, readClaudeTranscript, readCodexTranscript, readKimiTranscript } from '@/lib/history-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authError = await requireApprovedApiDevice(req.headers);
  if (authError) return authError;

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
    let transcript;
    if (backend === 'codex') {
      transcript = await readCodexTranscript({ projectId, sessionId });
    } else if (backend === 'kimi') {
      transcript = await readKimiTranscript({ projectId, sessionId });
    } else if (backend === 'agy') {
      // agy used to fall through to the Claude reader here, which looks for
      // agy ids under ~/.claude/projects — the Chat pane for every agy
      // session was an unconditional 500 dressed up as "empty".
      transcript = await readAgyTranscript({ projectId, sessionId });
    } else {
      transcript = await readClaudeTranscript({ projectId, sessionId });
    }
    return NextResponse.json(transcript);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load transcript';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
