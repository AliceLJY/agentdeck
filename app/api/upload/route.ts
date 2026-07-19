import { NextRequest, NextResponse } from 'next/server';
import { writePrivateUpload } from '@/lib/secure-upload';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export async function POST(req: NextRequest) {
  // Simple token auth
  const token = req.headers.get('x-token');
  if (token !== process.env.CC_TERMINAL_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

    console.log(`[cc-terminal] File uploaded: ${filepath} (${file.size} bytes)`);

    return NextResponse.json({
      path: filepath,
      name: file.name,
      size: file.size,
    });
  } catch (err) {
    console.error('[cc-terminal] Upload error:', err);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
