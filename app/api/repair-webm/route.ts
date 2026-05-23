// POST /api/repair-webm — last-resort server-side webm container fix.
//
// Why this exists: the browser-side pipeline has two ways to recover a
// MediaRecorder webm's duration metadata —
//   (a) repairWebmDuration (lib/scoring/gemini/webmFix.ts) walks the EBML
//       bytes and rewrites the Duration header via fix-webm-duration, then
//   (b) finalizeWebmDuration (lib/scoring/gemini/webmDuration.ts) opens a
//       hidden <video> and runs the seek-to-MAX_SAFE_INTEGER trick.
// When BOTH fail, the attempt blob is unrecoverable client-side and the
// pipeline would otherwise send it to Gemini as-is, with a broken or
// zero duration, and Gemini would predictably rule "not dancing." This
// endpoint runs a true re-mux through ffmpeg so the container is
// re-indexed from cluster boundaries, fixing the duration without
// transcoding the video stream.
//
// SPECK overnight Group 3 §server-side fallback. Implementation note:
// the spec called for ffmpeg.wasm via @ffmpeg/ffmpeg but that package's
// v0.12+ release dropped Node.js support ("ffmpeg.wasm does not support
// nodejs" error on FFmpeg() construction). Falling back to the spec's
// "child_process.spawn('ffmpeg', ...)" Plan B. This requires ffmpeg to
// be on PATH — true on the dev machine, NOT true on Vercel's default
// Node runtime. Production deployment will need a custom build that
// includes a static ffmpeg binary, or a layered approach (e.g.
// vercel-ffmpeg-binary, lambda layer, or off-platform worker). The
// route surfaces this clearly via the kind=spawn-enotfound error tag
// so a caller can distinguish "ffmpeg missing" from "ffmpeg ran but
// failed."

import { spawn } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Cap input size at ~20MB base64 (~15MB binary). MediaRecorder webm at
// 720p ~7s is ~2MB; anything orders larger is probably an upload bug,
// and we don't want a single bad caller to chew through the 30s budget
// trying to repair garbage.
const MAX_INPUT_BASE64_LEN = 20 * 1024 * 1024;
// Bound the ffmpeg invocation so a hung child can't pin the route.
// Leaves slack inside maxDuration=30 for response serialization.
const FFMPEG_TIMEOUT_MS = 25_000;

type ChildResult =
  | { kind: 'ok'; stdout: Buffer; stderr: string }
  | { kind: 'spawn-enoent' }
  | { kind: 'spawn-error'; message: string }
  | { kind: 'nonzero-exit'; code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { kind: 'timeout'; partialStderr: string };

// Run ffmpeg with the input on stdin and capture the output on stdout.
// Args are `-i pipe:0 -c copy -fflags +genpts pipe:1` — copy codecs (no
// transcode) but force ffmpeg to regenerate timestamps and write a
// proper container index. The `-y` is harmless when writing to pipe.
async function runFFmpegRemux(input: Buffer): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve) => {
    let child;
    try {
      child = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', 'pipe:0',
        '-c', 'copy',
        '-fflags', '+genpts',
        '-f', 'webm',
        'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({
        kind: 'spawn-error',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ kind: 'timeout', partialStderr: stderr });
    }, FFMPEG_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT means ffmpeg isn't on PATH — surface that distinctly so the
      // caller can tell "binary missing" from "binary ran but errored."
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        resolve({ kind: 'spawn-enoent' });
        return;
      }
      resolve({
        kind: 'spawn-error',
        message: err.message,
      });
    });

    child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk as Buffer));
    child.stderr?.on('data', (chunk) => {
      stderr += (chunk as Buffer).toString('utf8');
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ kind: 'ok', stdout: Buffer.concat(stdoutChunks), stderr });
      } else {
        resolve({ kind: 'nonzero-exit', code, signal, stderr });
      }
    });

    // Pipe input then close stdin so ffmpeg knows the stream is over.
    try {
      child.stdin?.end(input);
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({
        kind: 'spawn-error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export async function POST(req: NextRequest) {
  let body: { webmBase64?: unknown };
  try {
    body = (await req.json()) as { webmBase64?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { webmBase64 } = body;
  if (typeof webmBase64 !== 'string' || webmBase64.length === 0) {
    return NextResponse.json({ error: 'missing webmBase64' }, { status: 400 });
  }
  if (webmBase64.length > MAX_INPUT_BASE64_LEN) {
    return NextResponse.json(
      { error: `webmBase64 too large (${webmBase64.length} > ${MAX_INPUT_BASE64_LEN})` },
      { status: 413 },
    );
  }

  let inputBuf: Buffer;
  try {
    inputBuf = Buffer.from(webmBase64, 'base64');
  } catch (err) {
    return NextResponse.json(
      { error: `base64 decode failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
  }
  if (inputBuf.length === 0) {
    return NextResponse.json({ error: 'decoded webm is empty' }, { status: 400 });
  }

  const startedAt = Date.now();
  const result = await runFFmpegRemux(inputBuf);
  const elapsedMs = Date.now() - startedAt;

  if (result.kind === 'spawn-enoent') {
    // eslint-disable-next-line no-console
    console.error('[repair-webm] failed', {
      reason: 'spawn-enoent',
      hint: 'ffmpeg binary not found on PATH; install ffmpeg or wire a vercel-ffmpeg-binary build',
      bytesBefore: inputBuf.length,
      elapsedMs,
    });
    return NextResponse.json(
      { error: 'ffmpeg binary unavailable on server', reason: 'spawn-enoent' },
      { status: 500 },
    );
  }
  if (result.kind === 'spawn-error') {
    // eslint-disable-next-line no-console
    console.error('[repair-webm] failed', {
      reason: 'spawn-error',
      message: result.message,
      bytesBefore: inputBuf.length,
      elapsedMs,
    });
    return NextResponse.json(
      { error: `ffmpeg spawn failed: ${result.message}`, reason: 'spawn-error' },
      { status: 500 },
    );
  }
  if (result.kind === 'timeout') {
    // eslint-disable-next-line no-console
    console.error('[repair-webm] failed', {
      reason: 'timeout',
      timeoutMs: FFMPEG_TIMEOUT_MS,
      partialStderr: result.partialStderr.slice(0, 500),
      bytesBefore: inputBuf.length,
      elapsedMs,
    });
    return NextResponse.json(
      { error: 'ffmpeg timed out', reason: 'timeout' },
      { status: 504 },
    );
  }
  if (result.kind === 'nonzero-exit') {
    // eslint-disable-next-line no-console
    console.error('[repair-webm] failed', {
      reason: 'nonzero-exit',
      code: result.code,
      signal: result.signal,
      stderr: result.stderr.slice(0, 500),
      bytesBefore: inputBuf.length,
      elapsedMs,
    });
    return NextResponse.json(
      { error: `ffmpeg exit ${result.code}: ${result.stderr.slice(0, 200)}`, reason: 'nonzero-exit' },
      { status: 500 },
    );
  }

  const outBuf = result.stdout;
  if (outBuf.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[repair-webm] failed', {
      reason: 'empty-output',
      stderr: result.stderr.slice(0, 500),
      bytesBefore: inputBuf.length,
      elapsedMs,
    });
    return NextResponse.json(
      { error: 'ffmpeg produced empty output', reason: 'empty-output' },
      { status: 500 },
    );
  }

  // eslint-disable-next-line no-console
  console.log('[repair-webm] succeeded', {
    bytesBefore: inputBuf.length,
    bytesAfter: outBuf.length,
    elapsedMs,
  });

  return NextResponse.json({
    webmBase64: outBuf.toString('base64'),
    bytesBefore: inputBuf.length,
    bytesAfter: outBuf.length,
    elapsedMs,
  });
}
