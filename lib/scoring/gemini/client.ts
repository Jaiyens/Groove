// Browser client for /api/score-gemini.
//
// Takes the attempt Blob (MediaRecorder output) + the reference video URL
// + the chunk window. Trims the reference to (chunkWindow ± 500ms padding)
// CLIENT-SIDE via a hidden <video> + canvas + MediaRecorder so we never
// ship a 15s reference for a 1.5s chunk (SPECK §windowing-fix). Then
// base64-encodes both clips and POSTs to the serverless endpoint.
//
// Mirroring (SPECK round-3 §Group-1): the front-facing camera captures the
// attempt mirrored, so the canvas pump also FLIPS the reference horizontally
// in the same pass — left/right in the reference now corresponds directly to
// left/right in the attempt. `referenceMirrored: true` rides on the payload so
// the prompt can stop asking the model to imagine a mirror correspondence.
// Fallback path (un-trimmed full reference) sends `referenceMirrored: false`
// — that path is rare and known-degraded.
//
// Motion-onset trim (SPECK round-3 §Group-2): the chunk window can include
// the source dancer's "walking back to camera" pre-roll. Telling the model
// "ignore those seconds" while showing them anyway did not work. Instead,
// we scan the leading region of each video for the first frame whose pixel
// diff exceeds 3× the rolling baseline, then start the recorded slice at
// that frame. The same scan runs on the attempt (no flip) so both videos
// land in Gemini's payload with t=0 == first dance movement. Both onset
// offsets are forwarded as `referenceMotionOnsetSec` / `attemptMotionOnsetSec`
// for diagnostic logging.
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
import { detectMotionOnsetIndex } from './motionOnset';

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
// How far past the leading edge of the trim window we scan looking for the
// first frame of dance movement. 3s is the practical upper bound for a
// "dancer walks back to camera" pre-roll; beyond that the chunker is broken
// upstream and motion-onset can't paper over it.
const MOTION_ONSET_SCAN_LIMIT_MS = 3_000;
// Sampling interval for the motion-onset scan. ~12 fps is dense enough to
// catch a first-beat hit without making the seek chain take forever on
// mobile Safari (seek-then-paint is ~30-50ms per step).
const MOTION_ONSET_SAMPLE_INTERVAL_MS = 80;
// Tiny image used for frame-diff. 64×64 is the spec value; trades resolution
// for a cheap O(4096) per-frame math op.
const MOTION_ONSET_TILE = 64;

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

// Load a video URL into a hidden DOM element and wait for metadata. Caller
// must call the returned `dispose` when done so the element is removed and
// the source revoked. Throws if DOM is unavailable (SSR or a stripped JSDOM).
async function openHiddenVideo(url: string): Promise<{ video: HTMLVideoElement; dispose: () => void }> {
  if (typeof document === 'undefined') {
    throw new Error('video: DOM unavailable');
  }
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.style.position = 'fixed';
  video.style.left = '-10000px';
  video.style.top = '-10000px';
  video.style.width = '1px';
  video.style.height = '1px';
  document.body.appendChild(video);
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
      reject(new Error('video failed to load metadata'));
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });

  const dispose = () => {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // ignore
    }
    if (video.parentNode) video.parentNode.removeChild(video);
  };

  return { video, dispose };
}

async function seekVideo(video: HTMLVideoElement, sec: number): Promise<void> {
  video.currentTime = sec;
  await new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      reject(new Error('video seek failed'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
  });
}

// Scan a video for the first frame where motion clears the rolling-baseline
// threshold. Returns an absolute time in seconds within the source video, or
// null if no onset is detected within the scan window.
//
// Cost: ~scanWindowSec / sampleIntervalSec seeks. Each seek + draw is ~30-
// 50ms on mobile Safari, so a 3s scan @ 80ms = ~37 samples = ~1.5s wall time.
async function detectMotionOnsetInVideo(
  video: HTMLVideoElement,
  scanStartSec: number,
  scanEndSec: number,
): Promise<number | null> {
  if (typeof document === 'undefined') return null;

  const tile = MOTION_ONSET_TILE;
  const canvas = document.createElement('canvas');
  canvas.width = tile;
  canvas.height = tile;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const samples: number[] = [];
  const sampleTimes: number[] = [];
  let prev: Uint8ClampedArray | null = null;

  const intervalSec = MOTION_ONSET_SAMPLE_INTERVAL_MS / 1000;
  for (let t = scanStartSec; t <= scanEndSec; t += intervalSec) {
    try {
      await seekVideo(video, t);
      ctx.drawImage(video, 0, 0, tile, tile);
      const data = ctx.getImageData(0, 0, tile, tile).data;

      if (prev) {
        let sum = 0;
        // Luminance-weighted diff. Step by 4 (RGBA) and skip alpha.
        for (let i = 0; i < data.length; i += 4) {
          const lumCur = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          const lumPrev = prev[i] * 0.299 + prev[i + 1] * 0.587 + prev[i + 2] * 0.114;
          sum += Math.abs(lumCur - lumPrev);
        }
        const meanDiff = sum / (data.length / 4);
        samples.push(meanDiff);
        sampleTimes.push(t);
      } else {
        // First frame: nothing to diff against; record baseline 0 so
        // detectMotionOnsetIndex's leading-edge rule still applies.
        samples.push(0);
        sampleTimes.push(t);
      }
      prev = new Uint8ClampedArray(data);
    } catch {
      // CORS-tainted canvas or seek error — bail and let the caller pick
      // a sensible default.
      return null;
    }
  }

  const onsetIdx = detectMotionOnsetIndex(samples);
  if (onsetIdx === null) return null;
  return sampleTimes[onsetIdx];
}

// Record a slice of an already-loaded video to a Blob via canvas + MediaRecorder.
// `flipHorizontally` mirrors the reference to match the front-camera-mirrored
// attempt (SPECK round-3 §Group-1).
async function captureVideoSlice(
  video: HTMLVideoElement,
  startSec: number,
  endSec: number,
  flipHorizontally: boolean,
): Promise<{ blob: Blob; mimeType: string }> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('capture: MediaRecorder unavailable');
  }
  if (endSec <= startSec) {
    throw new Error(`capture: invalid window start=${startSec}s end=${endSec}s`);
  }

  await seekVideo(video, startSec);

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 720;
  canvas.height = video.videoHeight || 1280;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('capture: canvas 2d context unavailable');

  if (flipHorizontally) {
    // Horizontal flip set once: every subsequent drawImage emits a mirrored
    // frame without a per-frame save/restore.
    ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
  }

  // Draw one frame so the captureStream has content from t=0.
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  type CapturableCanvas = HTMLCanvasElement & {
    captureStream?: (frameRate?: number) => MediaStream;
  };
  const capturable = canvas as CapturableCanvas;
  if (typeof capturable.captureStream !== 'function') {
    throw new Error('capture: canvas.captureStream unavailable');
  }
  const stream = capturable.captureStream(30);

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

  const durationMs = (endSec - startSec) * 1000;
  recorder.start();
  await video.play();
  const playStartedAt = performance.now();

  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      const elapsed = performance.now() - playStartedAt;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (elapsed >= durationMs || video.ended) {
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
    throw new Error('capture: empty output blob');
  }
  return { blob, mimeType };
}

interface TrimReferenceResult {
  blob: Blob;
  mimeType: string;
  // Where (in seconds) the chunk choreography starts and ends inside the
  // trimmed clip. With motion-onset trim, the chunk starts at 0 because the
  // first frame of the trimmed clip IS the first dance movement.
  referenceChunkStartSec: number;
  referenceChunkEndSec: number;
  // Absolute seconds in the SOURCE reference where motion onset was
  // detected. null when no onset detected within scan window (kept the
  // legacy padded-trim semantics).
  motionOnsetSec: number | null;
}

async function trimReferenceClientSide(
  url: string,
  chunkStartMs: number,
  chunkEndMs: number,
): Promise<TrimReferenceResult> {
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
    throw new Error('trim: DOM or MediaRecorder unavailable');
  }

  const { video, dispose } = await openHiddenVideo(url);
  try {
    const durationSec = video.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error(`reference video duration unknown (${durationSec})`);
    }

    const trimStartMs = Math.max(0, chunkStartMs - REFERENCE_PADDING_MS);
    const trimEndMs = Math.min(durationSec * 1000, chunkEndMs + REFERENCE_PADDING_MS);
    if (trimEndMs <= trimStartMs) {
      throw new Error(`invalid trim window: start=${trimStartMs}ms end=${trimEndMs}ms`);
    }

    // Motion-onset scan covers the leading padding region plus some of the
    // chunk interior — the chunker can place the choreography start well
    // past `chunkStartMs` when the source has long pre-roll.
    const scanStartSec = trimStartMs / 1000;
    const scanEndSec = Math.min(
      trimEndMs / 1000,
      scanStartSec + MOTION_ONSET_SCAN_LIMIT_MS / 1000,
    );
    const onsetAbsSec = await detectMotionOnsetInVideo(video, scanStartSec, scanEndSec);

    // Effective start of the recorded slice. If onset was detected, start
    // ~50ms before it so the very first hit isn't clipped; else fall back
    // to the legacy padded start.
    const effectiveStartSec = onsetAbsSec !== null
      ? Math.max(trimStartMs / 1000, onsetAbsSec - 0.05)
      : trimStartMs / 1000;
    const effectiveEndSec = trimEndMs / 1000;

    const { blob, mimeType } = await captureVideoSlice(
      video,
      effectiveStartSec,
      effectiveEndSec,
      /* flipHorizontally */ true,
    );

    // Chunk position within the trimmed slice. With motion-onset trim, the
    // dance starts at 0; without, it starts at (chunkStartMs - trimStartMs).
    const referenceChunkStartSec =
      onsetAbsSec !== null ? 0 : (chunkStartMs - trimStartMs) / 1000;
    const referenceChunkEndSec =
      referenceChunkStartSec + (chunkEndMs - chunkStartMs) / 1000;

    return {
      blob,
      mimeType,
      referenceChunkStartSec,
      referenceChunkEndSec,
      motionOnsetSec: onsetAbsSec,
    };
  } finally {
    dispose();
  }
}

interface TrimAttemptResult {
  blob: Blob;
  mimeType: string;
  motionOnsetSec: number | null;
}

// Re-record the attempt starting at its motion-onset moment so that both
// videos arrive at Gemini with t=0 == first dance movement. If detection
// fails (no onset, DOM unavailable, CORS taint), we pass the original blob
// through unchanged with motionOnsetSec=null — caller treats it as the
// degraded fallback path.
async function trimAttemptForOnset(attemptBlob: Blob): Promise<TrimAttemptResult> {
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
    return { blob: attemptBlob, mimeType: attemptBlob.type || 'video/webm', motionOnsetSec: null };
  }

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { blob: attemptBlob, mimeType: attemptBlob.type || 'video/webm', motionOnsetSec: null };
  }

  const objectUrl = URL.createObjectURL(attemptBlob);
  try {
    const { video, dispose } = await openHiddenVideo(objectUrl);
    try {
      const durationSec = video.duration;
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        // Some MediaRecorder outputs don't surface a valid duration. Fall
        // back to passing the blob through.
        return { blob: attemptBlob, mimeType: attemptBlob.type || 'video/webm', motionOnsetSec: null };
      }

      const scanEndSec = Math.min(durationSec, MOTION_ONSET_SCAN_LIMIT_MS / 1000);
      const onsetAbsSec = await detectMotionOnsetInVideo(video, 0, scanEndSec);

      if (onsetAbsSec === null) {
        return { blob: attemptBlob, mimeType: attemptBlob.type || 'video/webm', motionOnsetSec: null };
      }

      // Start slightly before onset to keep the first hit intact.
      const effectiveStartSec = Math.max(0, onsetAbsSec - 0.05);
      const effectiveEndSec = durationSec;
      const { blob, mimeType } = await captureVideoSlice(
        video,
        effectiveStartSec,
        effectiveEndSec,
        /* flipHorizontally */ false,
      );
      return { blob, mimeType, motionOnsetSec: onsetAbsSec };
    } finally {
      dispose();
    }
  } catch {
    // Anything went wrong with the attempt re-encode — degrade silently.
    return { blob: attemptBlob, mimeType: attemptBlob.type || 'video/webm', motionOnsetSec: null };
  } finally {
    URL.revokeObjectURL(objectUrl);
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
    let referenceMirrored: boolean;
    let referenceMotionOnsetSec: number | null = null;
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
      referenceMotionOnsetSec = trim.motionOnsetSec;
      trimMode = 'trimmed';
      referenceMirrored = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[gemini-client] client-side trim failed; sending full reference with window hint (un-mirrored fallback)',
        err,
      );
      referenceBlob = await fetchReferenceAsBlob(referenceVideoUrl, composedSignal);
      referenceMimeType = referenceBlob.type || 'video/mp4';
      // When we send the full reference, the prompt window is the
      // chunk's absolute position in the full reference, in seconds.
      referenceChunkStartSec = chunkStartMs / 1000;
      referenceChunkEndSec = chunkEndMs / 1000;
      trimMode = 'full-fallback';
      referenceMirrored = false;
    }

    // Motion-onset trim the attempt (no flip). Always best-effort: if the
    // re-encode fails, we send the original blob with onset=null.
    const attemptTrim = await trimAttemptForOnset(attemptBlob);
    const attemptMotionOnsetSec = attemptTrim.motionOnsetSec;
    const attemptToSend = attemptTrim.blob;
    const attemptMimeTypeToSend = attemptTrim.mimeType;

    const [attemptBase64, referenceBase64] = await Promise.all([
      blobToBase64(attemptToSend),
      blobToBase64(referenceBlob),
    ]);

    // Both videos motion-onset trimmed when BOTH detected an onset and the
    // reference path didn't degrade to the full-fallback. The prompt's
    // "videos start at first movement" clause only fires when both legs of
    // the pipeline produced an aligned slice.
    const videosMotionOnsetTrimmed =
      trimMode === 'trimmed' &&
      referenceMotionOnsetSec !== null &&
      attemptMotionOnsetSec !== null;

    // eslint-disable-next-line no-console
    console.log('[gemini-client] sending', {
      trimMode,
      referenceMirrored,
      referenceMotionOnsetSec,
      attemptMotionOnsetSec,
      videosMotionOnsetTrimmed,
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
        attemptMimeType: attemptMimeTypeToSend || 'video/webm',
        legsVisible,
        referenceChunkStartSec,
        referenceChunkEndSec,
        referenceMirrored,
        referenceMotionOnsetSec,
        attemptMotionOnsetSec,
        videosMotionOnsetTrimmed,
      }),
    });

    if (!res.ok) {
      // Server returns { error, reason? } on 502 — the route's classified
      // FailureReason tag, when available, is more useful than the bare
      // status code. Tag the reason `gemini_failed_after_retry` on a 502
      // so the UI/caller can tell "retry already happened" apart from a
      // first-attempt failure.
      let detail = '';
      let upstreamReason: string | undefined;
      try {
        const errJson = (await res.json()) as { error?: string; reason?: string };
        detail = errJson.error ? `: ${errJson.error}` : '';
        upstreamReason = errJson.reason;
      } catch {
        // body wasn't JSON, drop it
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[gemini-client] api ${res.status} reason=${upstreamReason ?? 'unknown'}${detail}`,
      );
      if (res.status === 502) {
        return {
          kind: 'error',
          reason: `gemini_failed_after_retry${upstreamReason ? `:${upstreamReason}` : ''}`,
        };
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
