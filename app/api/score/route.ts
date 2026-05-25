// POST /api/score — single end-of-dance scoring endpoint.
//
// Input (JSON):
//   - attemptBlobUrl: string (Vercel Blob URL — client uploaded the
//     webcam recording directly to Blob storage, bypassing the 4.5MB
//     serverless body limit)
//   - attemptContentType?: string (defaults to 'video/webm')
//   - referenceUrl: string (dance.video_url; absolute URL or /data/ path)
//
// Output:
//   200 { score: DanceScore, latencyMs: number }
//   4xx/5xx { error: string }
//
// Flow: fetch the user's video from blob storage, transcode WebM→MP4
// (Gemini rejects webm), resolve the reference (fetch URL or read from
// public/), call scoreDanceAttempt, return result. The user's blob is
// deleted in the finally block — privacy + storage cost.

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { del } from '@vercel/blob';

import { scoreDanceAttempt } from '@/lib/scoring/gemini/score-attempt';
import { transcodeWebmToMp4Path } from '@/lib/video/transcode';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const cleanup: Array<() => Promise<void>> = [];
  let attemptBlobUrl: string | null = null;

  try {
    const body = (await req.json()) as {
      attemptBlobUrl?: string;
      attemptContentType?: string;
      referenceUrl?: string;
    };

    if (!body.attemptBlobUrl) {
      return NextResponse.json({ error: 'attemptBlobUrl missing' }, { status: 400 });
    }
    if (!body.referenceUrl) {
      return NextResponse.json({ error: 'referenceUrl missing' }, { status: 400 });
    }

    attemptBlobUrl = body.attemptBlobUrl;
    const mimeType = body.attemptContentType ?? 'video/webm';

    const attemptRes = await fetch(attemptBlobUrl);
    if (!attemptRes.ok) {
      throw new Error(`attempt blob fetch failed: ${attemptRes.status} ${attemptRes.statusText}`);
    }
    const attemptBuf = Buffer.from(await attemptRes.arrayBuffer());

    const referencePath = await resolveReferencePath(body.referenceUrl, cleanup);

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
    // Delete the user's video from blob storage (best-effort). Failure
    // here doesn't change the score response — orphan blobs eventually
    // get reaped if you set a TTL policy on the bucket.
    if (attemptBlobUrl) {
      try {
        await del(attemptBlobUrl);
      } catch (e) {
        console.warn('[/api/score] blob delete failed', e);
      }
    }
    await Promise.allSettled(cleanup.map((c) => c()));
  }
}

async function resolveReferencePath(
  referenceUrl: string,
  cleanup: Array<() => Promise<void>>,
): Promise<string> {
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
  const rel = referenceUrl.startsWith('/') ? referenceUrl.slice(1) : referenceUrl;
  const abs = path.join(process.cwd(), 'public', rel);
  await fs.access(abs);
  return abs;
}
