// Browser client for /api/score-gemini.
//
// Takes the attempt Blob (MediaRecorder output) + the reference video URL
// + the chunk window. Trims the reference to (chunkWindow ± 500ms padding)
// CLIENT-SIDE via a hidden <video> + canvas + MediaRecorder so we never
// ship a 15s reference for a 1.5s chunk (SPECK §windowing-fix). Then
// base64-encodes both clips and POSTs to the serverless endpoint.
//
// Timeout: 30s (SPECK §Hard rule 7) — past that, callers should treat it
// as a Gemini failure and fall back to MediaPipe silently. We DON'T retry
// — Gemini latency is the same order of magnitude as the retry budget, and
// a failed call is more likely a malformed video than a transient network.
//
// Trim fallback: if client-side trimming fails (CORS-tainted canvas,
// MediaRecorder missing, seek hangs, anything), we fall back to sending
// the FULL reference with the chunk window in `referenceChunkStartSec` /
// `referenceChunkEndSec`. The prompt understands either shape — it just
// ignores the padding interior seconds. Less efficient (bigger upload,
// more for Gemini to chew on) but the user still gets a valid score.

import { GeminiScoreSchema, type GeminiScore } from './types';

export type GeminiResult =
  | { kind: 'success'; score: GeminiScore; latencyMs: number }
  | { kind: 'error'; reason: string };

export type ScoreWithGeminiArgs = {
  attemptBlob: Blob;
  referenceVideoUrl: string;
  chunkStartMs: number;
  chunkEndMs: number;
  legsVisible: boolean;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const REFERENCE_PADDING_MS = 500;

async function blobToBase64(blob: Blob): Promise<string> {
  // FileReader gives us a data URL; strip the `data:...;base64,` prefix.
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

async function fetchReferenceAsBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`reference fetch failed: ${res.status}`);
  return res.blob();
}

interface TrimResult {
  blob: Blob;
  mimeType: string;
  // Where (in seconds) the actual choreography begins inside the trimmed
  // clip. Equals REFERENCE_PADDING_MS/1000 when the chunk has room for
  // full padding on the leading side; less when the chunk starts near 0.
  referenceChunkStartSec: number;
  referenceChunkEndSec: number;
}

// Client-side reference trimming via hidden <video> + canvas +
// MediaRecorder. Plays the reference in realtime from the padded
// start to the padded end while a canvas captures frames; the
// resulting Blob is the encoded trimmed clip. Throws on any failure
// so callers can fall back to the un-trimmed path.
async function trimReferenceClientSide(
  url: string,
  chunkStartMs: number,
  chunkEndMs: number,
): Promise<TrimResult> {
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
    throw new Error('trim: DOM or MediaRecorder unavailable');
  }

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  // Off-screen but in the DOM so iOS doesn't refuse to play it.
  video.style.position = 'fixed';
  video.style.left = '-10000px';
  video.style.top = '-10000px';
  video.style.width = '1px';
  video.style.height = '1px';
  document.body.appendChild(video);

  const cleanup = () => {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // ignore
    }
    if (video.parentNode) video.parentNode.removeChild(video);
  };

  try {
    video.src = url;

    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
        reject(new Error('reference video failed to load metadata'));
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
    });

    const durationSec = video.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error(`reference video duration unknown (${durationSec})`);
    }

    const trimStartMs = Math.max(0, chunkStartMs - REFERENCE_PADDING_MS);
    const trimEndMs = Math.min(durationSec * 1000, chunkEndMs + REFERENCE_PADDING_MS);
    if (trimEndMs <= trimStartMs) {
      throw new Error(`invalid trim window: start=${trimStartMs}ms end=${trimEndMs}ms`);
    }
    const trimDurationMs = trimEndMs - trimStartMs;
    const referenceChunkStartSec = (chunkStartMs - trimStartMs) / 1000;
    const referenceChunkEndSec = referenceChunkStartSec + (chunkEndMs - chunkStartMs) / 1000;

    // Seek to the padded start.
    video.currentTime = trimStartMs / 1000;
    await new Promise<void>((resolve, reject) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        reject(new Error('reference seek failed'));
      };
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
    });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 1280;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('trim: canvas 2d context unavailable');

    // Draw one frame so the captureStream has content from t=0.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    type CapturableCanvas = HTMLCanvasElement & {
      captureStream?: (frameRate?: number) => MediaStream;
    };
    const capturable = canvas as CapturableCanvas;
    if (typeof capturable.captureStream !== 'function') {
      throw new Error('trim: canvas.captureStream unavailable');
    }
    const stream = capturable.captureStream(30);

    // Prefer VP9 → VP8 → whatever the browser defaults to.
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    const recordedChunks: Blob[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
    };

    recorder.start();
    await video.play();
    const playStartedAt = performance.now();

    // Frame pump until elapsed playback ≥ trim duration. Use rAF so we
    // pace with the browser's refresh; the canvas captureStream samples
    // the canvas on each redraw.
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        const elapsed = performance.now() - playStartedAt;
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch (err) {
          // Likely a tainted canvas if the reference URL doesn't return
          // permissive CORS headers. Bail so the caller can fall back.
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (elapsed >= trimDurationMs || video.ended) {
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });

    try {
      recorder.requestData();
    } catch {
      // ignore — older browsers don't support mid-flight requestData
    }
    await new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (ev) => reject(new Error(`MediaRecorder error: ${String(ev)}`));
      try {
        recorder.stop();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    stream.getTracks().forEach((t) => t.stop());

    const blob = new Blob(recordedChunks, { type: mimeType });
    if (blob.size === 0) {
      throw new Error('trim: empty output blob');
    }

    return {
      blob,
      mimeType,
      referenceChunkStartSec,
      referenceChunkEndSec,
    };
  } finally {
    cleanup();
  }
}

export async function scoreWithGemini(
  args: ScoreWithGeminiArgs,
): Promise<GeminiResult> {
  const { attemptBlob, referenceVideoUrl, chunkStartMs, chunkEndMs, legsVisible, signal } = args;

  const controller = new AbortController();
  const composedSignal = signal
    ? mergeSignals(signal, controller.signal)
    : controller.signal;
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    // Try the client-side trim first. If it throws, fall back to the
    // un-trimmed reference + explicit chunk window in seconds — prompt
    // handles both shapes (SPECK §windowing-fix fallback path).
    let referenceBlob: Blob;
    let referenceMimeType: string;
    let referenceChunkStartSec: number;
    let referenceChunkEndSec: number;
    let trimMode: 'trimmed' | 'full-fallback';
    try {
      const trim = await trimReferenceClientSide(
        referenceVideoUrl,
        chunkStartMs,
        chunkEndMs,
      );
      referenceBlob = trim.blob;
      referenceMimeType = trim.mimeType;
      referenceChunkStartSec = trim.referenceChunkStartSec;
      referenceChunkEndSec = trim.referenceChunkEndSec;
      trimMode = 'trimmed';
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[gemini-client] client-side trim failed; sending full reference with window hint',
        err,
      );
      referenceBlob = await fetchReferenceAsBlob(referenceVideoUrl, composedSignal);
      referenceMimeType = referenceBlob.type || 'video/mp4';
      // When we send the full reference, the prompt window is the
      // chunk's absolute position in the full reference, in seconds.
      referenceChunkStartSec = chunkStartMs / 1000;
      referenceChunkEndSec = chunkEndMs / 1000;
      trimMode = 'full-fallback';
    }

    const [attemptBase64, referenceBase64] = await Promise.all([
      blobToBase64(attemptBlob),
      blobToBase64(referenceBlob),
    ]);

    // eslint-disable-next-line no-console
    console.log('[gemini-client] sending', {
      trimMode,
      referenceBytes: referenceBase64.length,
      attemptBytes: attemptBase64.length,
      chunkStartMs,
      chunkEndMs,
      referenceChunkStartSec,
      referenceChunkEndSec,
      legsVisible,
    });

    const res = await fetch('/api/score-gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: composedSignal,
      body: JSON.stringify({
        referenceVideoBase64: referenceBase64,
        attemptVideoBase64: attemptBase64,
        referenceMimeType,
        attemptMimeType: attemptBlob.type || 'video/webm',
        legsVisible,
        referenceChunkStartSec,
        referenceChunkEndSec,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        const errJson = (await res.json()) as { error?: string };
        detail = errJson.error ? `: ${errJson.error}` : '';
      } catch {
        // body wasn't JSON, drop it
      }
      return { kind: 'error', reason: `gemini api ${res.status}${detail}` };
    }

    const json = (await res.json()) as { score?: unknown; latencyMs?: unknown };
    const parsed = GeminiScoreSchema.safeParse(json.score);
    if (!parsed.success) {
      return { kind: 'error', reason: 'response failed schema validation' };
    }
    const latencyMs = typeof json.latencyMs === 'number' ? json.latencyMs : 0;
    return { kind: 'success', score: parsed.data, latencyMs };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Was it our internal timeout or a caller cancel?
      if (signal?.aborted) return { kind: 'error', reason: 'cancelled' };
      return { kind: 'error', reason: 'timeout' };
    }
    return {
      kind: 'error',
      reason: err instanceof Error ? err.message : 'unknown error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (a.aborted) ctrl.abort();
  else a.addEventListener('abort', onAbort, { once: true });
  if (b.aborted) ctrl.abort();
  else b.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}
