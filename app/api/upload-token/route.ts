// POST /api/upload-token — generates a one-shot Vercel Blob upload token
// for the client. The client SDK (`@vercel/blob/client.upload`) calls this
// to get a signed URL it can PUT directly to, bypassing Vercel's 4.5MB
// serverless body limit for the user's webcam recording.
//
// Constraints we enforce here:
//   - content type must be a webm/mp4 video
//   - max size 60MB (~60s of 720p at 1500kbps with safety margin)
//   - random filename suffix to prevent collisions
//
// Requires BLOB_READ_WRITE_TOKEN in env (auto-set when a Blob store is
// connected in the Vercel dashboard; pull locally via `vercel env pull`).

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['video/webm', 'video/mp4'],
        maximumSizeInBytes: 60 * 1024 * 1024,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {
        // No-op — the blob is deleted by /api/score after scoring.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
