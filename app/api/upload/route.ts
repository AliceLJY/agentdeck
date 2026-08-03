import { NextRequest, NextResponse } from 'next/server';
import { requireApprovedApiDevice } from '@/lib/api-auth';
import { writePrivateUpload } from '@/lib/secure-upload';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export async function POST(req: NextRequest) {
  const authError = await requireApprovedApiDevice(req.headers);
  if (authError) return authError;

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 20MB)' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const filepath = await writePrivateUpload(file.name, buffer);

    console.log(`[agentdeck] File uploaded: ${filepath} (${file.size} bytes)`);

    return NextResponse.json({
      path: filepath,
      name: file.name,
      size: file.size,
    });
  } catch (err) {
    console.error('[agentdeck] Upload error:', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
