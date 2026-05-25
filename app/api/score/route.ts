// POST /api/score — single end-of-dance scoring endpoint.
//
// Input (multipart/form-data):
//   - attempt: Blob (user's recorded video, typically video/webm from MediaRecorder)
//   - referenceUrl: string (dance.video_url; absolute URL or /data/ path)
//
// Output:
//   200 { score: DanceScore, latencyMs: number }
//   4xx/5xx { error: string }
//
// Flow: write attempt Blob to /tmp/{uuid}.webm, transcode to mp4 (Gemini
// rejects webm), resolve reference (fetch URL or read from public/),
// call scoreDanceAttempt, return result.

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { scoreDanceAttempt } from '@/lib/scoring/gemini/score-attempt';
import { transcodeWebmToMp4Path } from '@/lib/video/transcode';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const cleanup: Array<() => Promise<void>> = [];

  try {
    const form = await req.formData();
    const attemptFile = form.get('attempt');
    const referenceUrl = form.get('referenceUrl');

    if (!(attemptFile instanceof Blob)) {
      return NextResponse.json({ error: 'attempt file missing' }, { status: 400 });
    }
    if (typeof referenceUrl !== 'string' || !referenceUrl) {
      return NextResponse.json({ error: 'referenceUrl missing' }, { status: 400 });
    }

    // Resolve reference: fetch if remote, read from public/ if local path.
    const referencePath = await resolveReferencePath(referenceUrl, cleanup);

    // Save + transcode attempt.
    const attemptBuf = Buffer.from(await attemptFile.arrayBuffer());
    const mimeType = attemptFile.type || 'video/webm';

    let attemptMp4Path: string;
    if (mimeType.startsWith('video/webm') || !mimeType.startsWith('video/mp4')) {
      const { mp4Path, cleanup: c } = await transcodeWebmToMp4Path(attemptBuf);
      cleanup.push(c);
      attemptMp4Path = mp4Path;
    } else {
      const direct = path.join(os.tmpdir(), `${crypto.randomUUID()}.mp4`);
      await fs.writeFile(direct, attemptBuf);
      cleanup.push(() => fs.unlink(direct).catch(() => {}));
      attemptMp4Path = direct;
    }

    const score = await scoreDanceAttempt(referencePath, attemptMp4Path);
    return NextResponse.json({ score, latencyMs: Date.now() - t0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/score]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await Promise.allSettled(cleanup.map((c) => c()));
  }
}

async function resolveReferencePath(
  referenceUrl: string,
  cleanup: Array<() => Promise<void>>,
): Promise<string> {
  // Remote URL → fetch to a temp file. Server-side fetch keeps the client
  // from having to re-upload the reference video (which it already loaded).
  if (referenceUrl.startsWith('http://') || referenceUrl.startsWith('https://')) {
    const res = await fetch(referenceUrl);
    if (!res.ok) {
      throw new Error(`reference fetch failed: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = path.join(os.tmpdir(), `${crypto.randomUUID()}-ref.mp4`);
    await fs.writeFile(tmp, buf);
    cleanup.push(() => fs.unlink(tmp).catch(() => {}));
    return tmp;
  }

  // Local path (e.g. /data/reference_dances/foo.mp4) → resolve under public/.
  // No cleanup since we're not creating a copy.
  const rel = referenceUrl.startsWith('/') ? referenceUrl.slice(1) : referenceUrl;
  const abs = path.join(process.cwd(), 'public', rel);
  await fs.access(abs); // throw if missing
  return abs;
}
