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
import { finalizeWebmDuration } from './webmDuration';
import { repairWebmDuration } from './webmFix';
import { renderSideBySideVideo } from './composite';
import { getMirrorEnabled } from '@/lib/preferences/mirror';
import {
  isCaptureEnabled,
  saveAttempt,
  blobToBase64Safe,
  type SavedAttempt,
} from '@/lib/debug/attemptStore';

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
  // SPECK overnight Track 2 §debug-scoring: optional context for the
  // debug capture store. Without these the saved record still works,
  // but the list view shows '<unknown>' for dance/chunk.
  danceId?: string;
  chunkIndex?: number;
};

// Client-side timeout for the /api/score-gemini round trip. Must be > the
// server's total budget (TOTAL_BUDGET_MS in app/api/score-gemini/route.ts).
// Otherwise the client gives up before the server's retry path can finish,
// every transient Gemini 503 forces a MediaPipe fallback even when the
// retry would have succeeded, and the user sees `FALLBACK SCORING` on a
// perfectly-valid attempt.
//
// Server budget: first attempt ~11s + retry ~26s + overhead ≈ 37s worst case.
// Floor: 35s (one full server budget). We pick 40s for headroom — three
// seconds of slack on top of the floor.
export const SERVER_BUDGET_FLOOR_MS = 35_000;
export const DEFAULT_TIMEOUT_MS = 40_000;
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

// Short hint for log lines so we don't dump full URLs (could be signed,
// could include credentials). For blob: URLs it surfaces the blob-id tail;
// for http(s) URLs it surfaces the trailing path segment.
function shortUrlHint(url: string): string {
  if (!url) return '<empty>';
  if (url.startsWith('blob:')) {
    const idx = url.lastIndexOf('/');
    return `blob:…${url.slice(idx + 1, idx + 13)}`;
  }
  try {
    const u = new URL(url);
    const tail = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return `${u.hostname}/…/${tail.slice(0, 32)}`;
  } catch {
    return `<unparseable len=${url.length}>`;
  }
}

// Load a video URL into a hidden DOM element and wait for metadata. Caller
// must call the returned `dispose` when done so the element is removed and
// the source revoked. Throws if DOM is unavailable (SSR or a stripped JSDOM).
async function openHiddenVideo(url: string): Promise<{ video: HTMLVideoElement; dispose: () => void }> {
  if (typeof document === 'undefined') {
    // eslint-disable-next-line no-console
    console.warn('[gemini-client] motion-onset openHiddenVideo: DOM unavailable', {
      urlHint: shortUrlHint(url),
    });
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

  // eslint-disable-next-line no-console
  console.log('[gemini-client] motion-onset openHiddenVideo: awaiting metadata', {
    urlHint: shortUrlHint(url),
  });
  const openStartedAt = performance.now();

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      // eslint-disable-next-line no-console
      console.log('[gemini-client] motion-onset openHiddenVideo: metadata loaded', {
        urlHint: shortUrlHint(url),
        durationSec: video.duration,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        readyState: video.readyState,
        networkState: video.networkState,
        elapsedMs: Math.round(performance.now() - openStartedAt),
      });
      resolve();
    };
    const onError = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      // eslint-disable-next-line no-console
      console.warn('[gemini-client] motion-onset openHiddenVideo: metadata failed', {
        urlHint: shortUrlHint(url),
        // Surface every diagnostic the element exposes at error time so we
        // can tell CORS taint apart from decode error apart from network 4xx.
        readyState: video.readyState,
        networkState: video.networkState,
        errorCode: video.error?.code ?? null,
        errorMessage: video.error?.message ?? null,
        elapsedMs: Math.round(performance.now() - openStartedAt),
      });
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
  const targetSec = sec;
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
      // eslint-disable-next-line no-console
      console.warn('[gemini-client] motion-onset seekVideo: seek failed', {
        targetSec,
        currentTime: video.currentTime,
        readyState: video.readyState,
        networkState: video.networkState,
        errorCode: video.error?.code ?? null,
        errorMessage: video.error?.message ?? null,
      });
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
//
// Round-4 diagnosis: every early-return path emits a distinct log line under
// the `[gemini-client] motion-onset` prefix with the values that triggered
// the return. Field operations: search for `motion-onset detect:` to see
// every entry/exit; `motion-onset detect early-return:` to see only the
// failure paths.
async function detectMotionOnsetInVideo(
  video: HTMLVideoElement,
  scanStartSec: number,
  scanEndSec: number,
): Promise<number | null> {
  const fnStartedAt = performance.now();
  // eslint-disable-next-line no-console
  console.log('[gemini-client] motion-onset detect: entry', {
    scanStartSec,
    scanEndSec,
    scanWindowSec: scanEndSec - scanStartSec,
    sampleIntervalMs: MOTION_ONSET_SAMPLE_INTERVAL_MS,
    expectedSampleCount: Math.max(
      0,
      Math.floor((scanEndSec - scanStartSec) / (MOTION_ONSET_SAMPLE_INTERVAL_MS / 1000)) + 1,
    ),
    videoDurationSec: video.duration,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    readyState: video.readyState,
  });

  if (typeof document === 'undefined') {
    // eslint-disable-next-line no-console
    console.warn('[gemini-client] motion-onset detect early-return: DOM unavailable');
    return null;
  }

  const tile = MOTION_ONSET_TILE;
  const canvas = document.createElement('canvas');
  canvas.width = tile;
  canvas.height = tile;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // eslint-disable-next-line no-console
    console.warn('[gemini-client] motion-onset detect early-return: canvas 2d ctx unavailable', {
      tile,
    });
    return null;
  }

  const samples: number[] = [];
  const sampleTimes: number[] = [];
  let prev: Uint8ClampedArray | null = null;
  let lastMeanDiff = 0;
  let lastIterationT = scanStartSec;
  let iterationCount = 0;

  const intervalSec = MOTION_ONSET_SAMPLE_INTERVAL_MS / 1000;
  for (let t = scanStartSec; t <= scanEndSec; t += intervalSec) {
    iterationCount += 1;
    lastIterationT = t;
    // Track which step inside the iteration faulted so the catch can name
    // it instead of returning a generic "something failed."
    let phase: 'seek' | 'drawImage' | 'getImageData' | 'diff' = 'seek';
    try {
      await seekVideo(video, t);
      phase = 'drawImage';
      ctx.drawImage(video, 0, 0, tile, tile);
      phase = 'getImageData';
      const data = ctx.getImageData(0, 0, tile, tile).data;
      phase = 'diff';

      if (prev) {
        let sum = 0;
        // Luminance-weighted diff. Step by 4 (RGBA) and skip alpha.
        for (let i = 0; i < data.length; i += 4) {
          const lumCur = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          const lumPrev = prev[i] * 0.299 + prev[i + 1] * 0.587 + prev[i + 2] * 0.114;
          sum += Math.abs(lumCur - lumPrev);
        }
        const meanDiff = sum / (data.length / 4);
        lastMeanDiff = meanDiff;
        samples.push(meanDiff);
        sampleTimes.push(t);
      } else {
        // First frame: nothing to diff against; record baseline 0 so
        // detectMotionOnsetIndex's leading-edge rule still applies.
        samples.push(0);
        sampleTimes.push(t);
      }
      prev = new Uint8ClampedArray(data);
    } catch (err) {
      // CORS-tainted canvas or seek error — bail and let the caller pick
      // a sensible default. We surface WHICH phase faulted so a CORS-
      // tainted canvas (drawImage / getImageData) is distinguishable from
      // a seek failure (seek phase) without re-running.
      // eslint-disable-next-line no-console
      console.warn('[gemini-client] motion-onset detect early-return: iteration threw', {
        phase,
        iterationT: t,
        iterationIndex: iterationCount - 1,
        samplesSoFar: samples.length,
        elapsedMs: Math.round(performance.now() - fnStartedAt),
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // Sample summary — even when an onset IS found, this gives us a sanity
  // check on what the input distribution looks like.
  const stats = summarizeSamples(samples);
  // eslint-disable-next-line no-console
  console.log('[gemini-client] motion-onset detect: scan complete', {
    iterationsRun: iterationCount,
    samplesCollected: samples.length,
    lastIterationT,
    lastMeanDiff,
    elapsedMs: Math.round(performance.now() - fnStartedAt),
    ...stats,
  });

  const onsetIdx = detectMotionOnsetIndex(samples);
  if (onsetIdx === null) {
    // Round-4 algorithm: returns null only when the windowed max is below
    // the 0.5 absolute floor — i.e. the stream is essentially still or
    // the canvas read produced near-blank frames (CORS taint that didn't
    // throw, frozen video, blank source). The 50%-of-max rule otherwise
    // always finds an onset, so this branch now narrows the diagnosis:
    // sampleMax below 0.5 = video is silent for our purposes; check the
    // openHiddenVideo metadata log + the per-iteration phase tags above.
    // eslint-disable-next-line no-console
    console.warn('[gemini-client] motion-onset detect early-return: no onset found within scan window', {
      samplesCollected: samples.length,
      ...stats,
    });
    return null;
  }

  // eslint-disable-next-line no-console
  console.log('[gemini-client] motion-onset detect: onset found', {
    onsetIdx,
    onsetSec: sampleTimes[onsetIdx],
    onsetSample: samples[onsetIdx],
    samplesCollected: samples.length,
    elapsedMs: Math.round(performance.now() - fnStartedAt),
  });
  return sampleTimes[onsetIdx];
}

// Stats helper used only by motion-onset logs. Pure, returns serializable
// numbers so the log line stays readable. Min and max are useful for
// "stream is saturated" / "stream is silent" diagnoses respectively; mean
// helps spot a noisy-but-flat distribution where no single sample stands
// out enough to clear the 3× rolling-baseline rule.
function summarizeSamples(samples: number[]): {
  sampleMax: number;
  sampleMin: number;
  sampleMean: number;
} {
  if (samples.length === 0) {
    return { sampleMax: 0, sampleMin: 0, sampleMean: 0 };
  }
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;
  for (const s of samples) {
    if (s > max) max = s;
    if (s < min) min = s;
    sum += s;
  }
  return {
    sampleMax: Number(max.toFixed(3)),
    sampleMin: Number(min.toFixed(3)),
    sampleMean: Number((sum / samples.length).toFixed(3)),
  };
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
  // Whether the captured slice was horizontally flipped — surfaced so
  // the caller can set `referenceMirrored` on the Gemini payload to
  // match. SPECK overnight Group 2 §mirror-unification.
  mirror: boolean;
}

async function trimReferenceClientSide(
  url: string,
  chunkStartMs: number,
  chunkEndMs: number,
): Promise<TrimReferenceResult> {
  // eslint-disable-next-line no-console
  console.log('[gemini-client] motion-onset trimReference: entry', {
    urlHint: shortUrlHint(url),
    chunkStartMs,
    chunkEndMs,
  });

  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
    // eslint-disable-next-line no-console
    console.warn('[gemini-client] motion-onset trimReference early-return: DOM or MediaRecorder unavailable', {
      hasDocument: typeof document !== 'undefined',
      hasMediaRecorder: typeof MediaRecorder !== 'undefined',
    });
    throw new Error('trim: DOM or MediaRecorder unavailable');
  }

  const { video, dispose } = await openHiddenVideo(url);
  try {
    // Round-4 Fix 1: even though the reference is fetched from a normal
    // URL (not a MediaRecorder blob), apply the seek-to-end-then-back
    // pass defensively — some CDNs serve webm with un-finalized indexes
    // and the helper short-circuits when the duration already looks
    // sane, so it costs nothing for the normal case.
    const refDurationFix = await finalizeWebmDuration(
      video,
      (sec) => seekVideo(video, sec),
    );
    // eslint-disable-next-line no-console
    console.log('[gemini-client] motion-onset trimReference: duration-finalize', refDurationFix);

    const durationSec = video.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      // eslint-disable-next-line no-console
      console.warn('[gemini-client] motion-onset trimReference early-return: duration invalid', {
        durationSec,
        isFinite: Number.isFinite(durationSec),
        urlHint: shortUrlHint(url),
      });
      throw new Error(`reference video duration unknown (${durationSec})`);
    }

    const trimStartMs = Math.max(0, chunkStartMs - REFERENCE_PADDING_MS);
    const trimEndMs = Math.min(durationSec * 1000, chunkEndMs + REFERENCE_PADDING_MS);
    if (trimEndMs <= trimStartMs) {
      // eslint-disable-next-line no-console
      console.warn('[gemini-client] motion-onset trimReference early-return: invalid trim window', {
        trimStartMs,
        trimEndMs,
        chunkStartMs,
        chunkEndMs,
        durationSec,
      });
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
    // eslint-disable-next-line no-console
    console.log('[gemini-client] motion-onset trimReference: scanning', {
      durationSec,
      trimStartMs,
      trimEndMs,
      scanStartSec,
      scanEndSec,
    });
    const onsetAbsSec = await detectMotionOnsetInVideo(video, scanStartSec, scanEndSec);

    // Effective start of the recorded slice. If onset was detected, start
    // ~50ms before it so the very first hit isn't clipped; else fall back
    // to the legacy padded start.
    const effectiveStartSec = onsetAbsSec !== null
      ? Math.max(trimStartMs / 1000, onsetAbsSec - 0.05)
      : trimStartMs / 1000;
    const effectiveEndSec = trimEndMs / 1000;

    // eslint-disable-next-line no-console
    console.log('[gemini-client] motion-onset trimReference: onset outcome → capture window', {
      onsetAbsSec,
      effectiveStartSec,
      effectiveEndSec,
    });

    // SPECK overnight Group 2 §mirror-unification: flip is no longer
    // hardcoded — it follows the shared mirror preference so the Gemini
    // composite reference matches whatever the user is seeing in Mode A
    // and on the holding screen. The caller surfaces the chosen value
    // as `referenceMirrored` on the API payload below.
    const mirror = getMirrorEnabled();
    const { blob, mimeType } = await captureVideoSlice(
      video,
      effectiveStartSec,
      effectiveEndSec,
      /* flipHorizontally */ mirror,
    );

    // Chunk position within the trimmed slice. With motion-onset trim, the
    // dance starts at 0; without, it starts at (chunkStartMs - trimStartMs).
    const referenceChunkStartSec =
      onsetAbsSec !== null ? 0 : (chunkStartMs - trimStartMs) / 1000;
    const referenceChunkEndSec =
      referenceChunkStartSec + (chunkEndMs - chunkStartMs) / 1000;

    // eslint-disable-next-line no-console
    console.log('[gemini-client] motion-onset trimReference: done', {
      motionOnsetSec: onsetAbsSec,
      referenceChunkStartSec,
      referenceChunkEndSec,
      blobBytes: blob.size,
      mimeType,
      mirror,
    });

    return {
      blob,
      mimeType,
      referenceChunkStartSec,
      referenceChunkEndSec,
      motionOnsetSec: onsetAbsSec,
      mirror,
    };
  } finally {
    dispose();
  }
}

interface TrimAttemptResult {
  blob: Blob;
  mimeType: string;
  motionOnsetSec: number | null;
  // SPECK overnight Track 2 §debug-scoring: surfaced so the caller can
  // log them into the debug capture record. They were already computed
  // inside the function; just propagating them out.
  durationSource: DurationSource | null;
  authoritativeDurationSec: number;
}

// Below this threshold a duration is implausibly short — the attempt is at
// most a smudge of a frame and motion-onset would scan a near-zero window.
// SPECK overnight Group 1 §duration-source: the same floor that webmDuration's
// `minPlausibleDurationSec` default uses, kept here for the inferred-duration
// validity check.
const MIN_PLAUSIBLE_DURATION_SEC = 0.5;

// Decide which duration source to trust for the attempt blob.
//
// Pre-Group-1 history: the pipeline ran repair → finalize → use video.duration.
// On real devices the EBML scan inferred ~6.7s correctly but the browser's
// seek-to-MAX_SAFE_INTEGER trick reported ~1.4s; motion-onset then scanned
// ~1s and Gemini saw a person starting to move, ruling "not dancing." The
// repair library knows the right answer; we trust it when it produces one.
//
// Decision rule (SPECK overnight Group 1):
//   - inferredDurationSec is a finite number ≥ MIN_PLAUSIBLE_DURATION_SEC →
//     authoritative duration is the inferred value; source 'webm-repair-inferred'.
//   - else (null, NaN, < 0.5s) → fall back to finalizeWebmDuration on a hidden
//     <video> and use whatever it reports; source 'browser-finalize'.
//
// Caller still opens the hidden <video> for the seek+draw pipeline (motion
// scan and slice re-encode need an HTMLVideoElement), but trim/scan math
// keys off `authoritativeDurationSec`, not `video.duration`.
// 'server-repair' is added when both client-side paths (EBML scan and
// browser seek-trick) failed AND /api/repair-webm successfully re-muxed
// the blob to produce a plausible duration. SPECK overnight Group 3.
type DurationSource = 'webm-repair-inferred' | 'browser-finalize' | 'server-repair';

interface DurationDecision {
  authoritativeDurationSec: number;
  source: DurationSource;
  // Surfaced for the diagnostic log line so a future field run can tell
  // "we used the inferred value" apart from "inferred was null, we used
  // the browser's value" at a glance.
  inferredDurationSec: number | null;
  finalizedDurationSec: number | null;
}

// Pure decision wrapper — finalize-on-demand is injected so unit tests
// can pin the inferred-vs-browser branch logic without a DOM harness.
export async function decideAttemptDuration(
  inferredDurationSec: number | null,
  runBrowserFinalize: () => Promise<number>,
): Promise<DurationDecision> {
  if (
    typeof inferredDurationSec === 'number' &&
    Number.isFinite(inferredDurationSec) &&
    inferredDurationSec >= MIN_PLAUSIBLE_DURATION_SEC
  ) {
    return {
      authoritativeDurationSec: inferredDurationSec,
      source: 'webm-repair-inferred',
      inferredDurationSec,
      finalizedDurationSec: null,
    };
  }
  // Fall back to the browser's seek-to-end pass.
  const finalizedDurationSec = await runBrowserFinalize();
  return {
    authoritativeDurationSec: finalizedDurationSec,
    source: 'browser-finalize',
    inferredDurationSec,
    finalizedDurationSec,
  };
}

// Re-record the attempt starting at its motion-onset moment so that both
// videos arrive at Gemini with t=0 == first dance movement. If detection
// fails (no onset, DOM unavailable, CORS taint), we pass the original blob
// through unchanged with motionOnsetSec=null — caller treats it as the
// degraded fallback path.
async function trimAttemptForOnset(attemptBlob: Blob): Promise<TrimAttemptResult> {
  // eslint-disable-next-line no-console
  console.log('[gemini-client] motion-onset trimAttempt: entry', {
    blobBytes: attemptBlob.size,
    blobType: attemptBlob.type,
  });

  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
    // eslint-disable-next-line no-console
    console.warn('[gemini-client] motion-onset trimAttempt early-return: DOM or MediaRecorder unavailable', {
      hasDocument: typeof document !== 'undefined',
      hasMediaRecorder: typeof MediaRecorder !== 'undefined',
    });
    return {
      blob: attemptBlob,
      mimeType: attemptBlob.type || 'video/webm',
      motionOnsetSec: null,
      durationSource: null,
      authoritativeDurationSec: 0,
    };
  }

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[gemini-client] motion-onset trimAttempt early-return: URL.createObjectURL unavailable', {
      hasURL: typeof URL !== 'undefined',
    });
    return {
      blob: attemptBlob,
      mimeType: attemptBlob.type || 'video/webm',
      motionOnsetSec: null,
      durationSource: null,
      authoritativeDurationSec: 0,
    };
  }

  // Round-5 Fix 2 (SPECK): rewrite the EBML metadata before the blob
  // ever hits a <video> element. The previous seek-trick made duration
  // FINITE but not CORRECT — real attempts ~7s were landing around 2s.
  // repairWebmDuration walks the EBML bytes to read the last cluster's
  // Timecode and hands the inferred duration to fix-webm-duration for
  // the actual header rewrite. Returns the original blob unchanged on
  // parse failure (best-effort).
  const repair = await repairWebmDuration(attemptBlob);
  // eslint-disable-next-line no-console
  console.log('[gemini-client] motion-onset trimAttempt: webm-repair', {
    blobBytesBefore: repair.blobBytesBefore,
    blobBytesAfter: repair.blobBytesAfter,
    repaired: repair.repaired,
    inferredDurationSec: repair.inferredDurationSec,
  });

  // Working blob + duration tracking. We may swap workingBlob mid-flight
  // if the server-repair fallback fires (SPECK overnight Group 3): the
  // server returns a re-muxed webm with a proper container index, and
  // from that point on we use the server's blob for motion-onset scan,
  // slice capture, and the final returned blob.
  let workingBlob: Blob = repair.blob;
  let workingObjectUrl: string | null = null;

  try {
    // Phase 1: open the client-repaired blob and decide duration.
    workingObjectUrl = URL.createObjectURL(workingBlob);
    let phase1 = await openHiddenVideo(workingObjectUrl);
    let video = phase1.video;
    let disposeVideo = phase1.dispose;

    let decision: DurationDecision;
    try {
      // SPECK overnight Group 1 §duration-source: the inferred duration
      // from the EBML scan, when valid, IS the authoritative duration.
      // We only fall back to finalizeWebmDuration when the scan couldn't
      // infer a plausible value. This stops the browser's <video>.duration
      // from overriding the library's correct answer.
      decision = await decideAttemptDuration(
        repair.inferredDurationSec,
        async () => {
          const fix = await finalizeWebmDuration(
            video,
            (sec) => seekVideo(video, sec),
          );
          return fix.durationAfter;
        },
      );
      // eslint-disable-next-line no-console
      console.log('[gemini-client] motion-onset trimAttempt: duration-source', {
        source: decision.source,
        durationSec: decision.authoritativeDurationSec,
        inferredDurationSec: decision.inferredDurationSec,
        finalizedDurationSec: decision.finalizedDurationSec,
      });
    } catch (err) {
      disposeVideo();
      throw err;
    }

    // SPECK overnight Group 3 §server-side fallback: when EBML inferred
    // came back null AND the browser-finalize produced an implausible
    // duration (NaN, < 0.5s, > 60s), escalate to /api/repair-webm. This
    // is the last-resort path; ffmpeg re-mux can fix containers that
    // neither client-side approach can recover.
    if (
      decision.source === 'browser-finalize' &&
      !isPlausibleDuration(decision.authoritativeDurationSec)
    ) {
      // eslint-disable-next-line no-console
      console.log('[gemini-client] motion-onset trimAttempt: escalating to server-repair', {
        clientDurationSec: decision.authoritativeDurationSec,
        clientSource: decision.source,
        blobBytes: workingBlob.size,
      });
      const serverResult = await runServerRepair(workingBlob);
      if (serverResult.kind === 'ok') {
        // Close the current video, swap blobs, re-open. Then re-run the
        // duration decision so the EBML scan reads the new container.
        disposeVideo();
        if (workingObjectUrl) URL.revokeObjectURL(workingObjectUrl);
        workingBlob = serverResult.blob;
        workingObjectUrl = URL.createObjectURL(workingBlob);
        const phase2 = await openHiddenVideo(workingObjectUrl);
        video = phase2.video;
        disposeVideo = phase2.dispose;

        // Re-scan the server-repaired blob's EBML; ffmpeg's output is
        // properly indexed so this should produce a plausible inferred.
        const reRepair = await repairWebmDuration(workingBlob);
        const reDecision = await decideAttemptDuration(
          reRepair.inferredDurationSec,
          async () => {
            const fix = await finalizeWebmDuration(
              video,
              (sec) => seekVideo(video, sec),
            );
            return fix.durationAfter;
          },
        );
        decision = {
          authoritativeDurationSec: reDecision.authoritativeDurationSec,
          source: 'server-repair',
          inferredDurationSec: reDecision.inferredDurationSec,
          finalizedDurationSec: reDecision.finalizedDurationSec,
        };
        // eslint-disable-next-line no-console
        console.log('[gemini-client] motion-onset trimAttempt: duration-source (post-server-repair)', {
          source: decision.source,
          durationSec: decision.authoritativeDurationSec,
          inferredDurationSec: decision.inferredDurationSec,
          finalizedDurationSec: decision.finalizedDurationSec,
          bytesBefore: serverResult.bytesBefore,
          bytesAfter: serverResult.bytesAfter,
        });
      } else {
        // eslint-disable-next-line no-console
        console.warn('[gemini-client] motion-onset trimAttempt: server-repair failed; staying on browser-finalize', {
          reason: serverResult.reason,
        });
      }
    }

    try {
      const durationSec = decision.authoritativeDurationSec;
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        // All paths exhausted — no plausible duration available.
        // eslint-disable-next-line no-console
        console.warn('[gemini-client] motion-onset trimAttempt early-return: duration invalid (after all duration sources)', {
          durationSec,
          isFinite: Number.isFinite(durationSec),
          durationSource: decision.source,
          inferredDurationSec: decision.inferredDurationSec,
          finalizedDurationSec: decision.finalizedDurationSec,
          blobBytes: workingBlob.size,
          blobType: workingBlob.type,
        });
        return {
          blob: workingBlob,
          mimeType: workingBlob.type || 'video/webm',
          motionOnsetSec: null,
          durationSource: decision.source,
          authoritativeDurationSec: decision.authoritativeDurationSec,
        };
      }

      const scanEndSec = Math.min(durationSec, MOTION_ONSET_SCAN_LIMIT_MS / 1000);
      // eslint-disable-next-line no-console
      console.log('[gemini-client] motion-onset trimAttempt: scanning', {
        durationSec,
        scanStartSec: 0,
        scanEndSec,
        durationSource: decision.source,
      });
      const onsetAbsSec = await detectMotionOnsetInVideo(video, 0, scanEndSec);

      if (onsetAbsSec === null) {
        // eslint-disable-next-line no-console
        console.warn('[gemini-client] motion-onset trimAttempt early-return: detect returned null', {
          durationSec,
          scanEndSec,
        });
        return {
          blob: workingBlob,
          mimeType: workingBlob.type || 'video/webm',
          motionOnsetSec: null,
          durationSource: decision.source,
          authoritativeDurationSec: decision.authoritativeDurationSec,
        };
      }

      // Start slightly before onset to keep the first hit intact. End at
      // the authoritative duration — NOT video.duration, because when the
      // duration-source is 'webm-repair-inferred' the browser's value is
      // known wrong and using it would re-introduce the 1.4s trim bug.
      const effectiveStartSec = Math.max(0, onsetAbsSec - 0.05);
      const effectiveEndSec = durationSec;
      // eslint-disable-next-line no-console
      console.log('[gemini-client] motion-onset trimAttempt: onset outcome → capture window', {
        onsetAbsSec,
        effectiveStartSec,
        effectiveEndSec,
        durationSource: decision.source,
      });
      const { blob, mimeType } = await captureVideoSlice(
        video,
        effectiveStartSec,
        effectiveEndSec,
        /* flipHorizontally */ false,
      );
      // eslint-disable-next-line no-console
      console.log('[gemini-client] motion-onset trimAttempt: done', {
        motionOnsetSec: onsetAbsSec,
        blobBytes: blob.size,
        mimeType,
        durationSource: decision.source,
      });
      return {
        blob,
        mimeType,
        motionOnsetSec: onsetAbsSec,
        durationSource: decision.source,
        authoritativeDurationSec: decision.authoritativeDurationSec,
      };
    } finally {
      disposeVideo();
    }
  } catch (err) {
    // Anything went wrong with the attempt re-encode — degrade silently.
    // We surface WHICH error landed here so a metadata-load failure (from
    // openHiddenVideo) is distinguishable from a captureVideoSlice fault.
    // eslint-disable-next-line no-console
    console.warn('[gemini-client] motion-onset trimAttempt early-return: outer threw', {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return {
      blob: workingBlob,
      mimeType: workingBlob.type || 'video/webm',
      motionOnsetSec: null,
      durationSource: null,
      authoritativeDurationSec: 0,
    };
  } finally {
    if (workingObjectUrl) URL.revokeObjectURL(workingObjectUrl);
  }
}

// SPECK overnight Group 3 §server-side fallback: we treat any duration
// outside this window as implausible enough to justify a network round-
// trip to /api/repair-webm. 60s upper bound matches MediaRecorder
// usage in this app — Mode B chunks are bounded by chunker output and
// never exceed ~30s; > 60s is almost certainly a metadata bug.
function isPlausibleDuration(sec: number): boolean {
  return Number.isFinite(sec) && sec >= MIN_PLAUSIBLE_DURATION_SEC && sec <= 60;
}

type ServerRepairResult =
  | { kind: 'ok'; blob: Blob; bytesBefore: number; bytesAfter: number }
  | { kind: 'err'; reason: string };

// POST the blob to /api/repair-webm as base64, expect a re-muxed webm back.
// Best-effort: any network/server failure falls through to the caller's
// existing browser-finalize result. The route's `reason` tag is included
// in the err for log diagnostics.
async function runServerRepair(blob: Blob): Promise<ServerRepairResult> {
  try {
    const webmBase64 = await blobToBase64(blob);
    const res = await fetch('/api/repair-webm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webmBase64 }),
    });
    if (!res.ok) {
      let reason = `http ${res.status}`;
      try {
        const errJson = (await res.json()) as { error?: string; reason?: string };
        reason = errJson.reason ?? errJson.error ?? reason;
      } catch {
        // body not JSON; keep status-based reason
      }
      return { kind: 'err', reason };
    }
    const json = (await res.json()) as {
      webmBase64?: unknown;
      bytesBefore?: unknown;
      bytesAfter?: unknown;
    };
    if (typeof json.webmBase64 !== 'string' || json.webmBase64.length === 0) {
      return { kind: 'err', reason: 'response missing webmBase64' };
    }
    // Decode base64 → Uint8Array → Blob. The native atob path is
    // available in every browser this app targets.
    const binary = atob(json.webmBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const repaired = new Blob([bytes], { type: 'video/webm' });
    return {
      kind: 'ok',
      blob: repaired,
      bytesBefore: typeof json.bytesBefore === 'number' ? json.bytesBefore : blob.size,
      bytesAfter: typeof json.bytesAfter === 'number' ? json.bytesAfter : repaired.size,
    };
  } catch (err) {
    return {
      kind: 'err',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}


export async function scoreWithGemini(
  args: ScoreWithGeminiArgs,
): Promise<GeminiResult> {
  const {
    attemptBlob,
    referenceVideoUrl,
    chunkStartMs,
    chunkEndMs,
    legsVisible,
    signal,
    danceId,
    chunkIndex,
  } = args;

  const controller = new AbortController();
  const composedSignal = signal
    ? mergeSignals(signal, controller.signal)
    : controller.signal;
  const callStartedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  // SPECK overnight Track 2 §debug-scoring: in-flight accumulator for the
  // capture store. Populated as the function progresses; fired-and-forgotten
  // at the end inside captureIfEnabled(). Never blocks the user-facing
  // scoring path — every failure mode resolves silently (logged only).
  const captureTrace: {
    requestPayload: unknown;
    responseRaw: unknown;
    motionOnsetRefSec: number | null;
    motionOnsetAttemptSec: number | null;
    mirror: boolean;
    durationSource: SavedAttempt['durationSource'];
    authoritativeDurationSec: number;
  } = {
    requestPayload: null,
    responseRaw: null,
    motionOnsetRefSec: null,
    motionOnsetAttemptSec: null,
    mirror: false,
    durationSource: null,
    authoritativeDurationSec: 0,
  };

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
      captureTrace.motionOnsetRefSec = trim.motionOnsetSec;
      captureTrace.mirror = trim.mirror;
      trimMode = 'trimmed';
      // SPECK overnight Group 2 §mirror-unification: trim.mirror reflects
      // the user's persisted preference at call time. The previous code
      // always sent `true` here; the prompt's literal-left/right clause
      // is correct only when mirror was actually applied during capture.
      referenceMirrored = trim.mirror;
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
    captureTrace.motionOnsetAttemptSec = attemptMotionOnsetSec;
    captureTrace.durationSource = attemptTrim.durationSource;
    captureTrace.authoritativeDurationSec = attemptTrim.authoritativeDurationSec;

    // Both videos motion-onset trimmed when BOTH detected an onset and the
    // reference path didn't degrade to the full-fallback. The prompt's
    // "videos start at first movement" clause only fires when both legs of
    // the pipeline produced an aligned slice.
    const videosMotionOnsetTrimmed =
      trimMode === 'trimmed' &&
      referenceMotionOnsetSec !== null &&
      attemptMotionOnsetSec !== null;

    // SPECK overnight Group 4 §composite: try the side-by-side renderer
    // first. If it succeeds, ship the composite to /api/score-gemini-composite
    // and skip the two-video path entirely. If it fails (any reason),
    // fall through silently to the existing two-video pipeline.
    //
    // We pass the already-trimmed blobs and tell the renderer NOT to apply
    // mirror at composite time — trimReferenceClientSide already applied
    // the mirror at trim time (when the preference said so), and
    // double-flipping would un-mirror. The mirror BOOLEAN is forwarded
    // separately to the composite endpoint so the prompt can describe
    // the left/right correspondence.
    if (trimMode === 'trimmed' && videosMotionOnsetTrimmed) {
      const composite = await renderSideBySideVideo({
        // Object URL for the trimmed reference so the composer can
        // consume it as a <video src>. The reference here is already
        // mirrored if the preference was on at trim time.
        referenceUrl: URL.createObjectURL(referenceBlob),
        attemptBlob: attemptToSend,
        mirror: false, // do NOT double-flip; trim already mirrored
        motionOnsetRefSec: 0, // trimmed clip starts at onset
        motionOnsetAttemptSec: 0, // trimmed clip starts at onset
        chunkDurationSec: Math.min(7, (chunkEndMs - chunkStartMs) / 1000 + 1),
      });

      if (composite.kind === 'success') {
        const compositeBase64 = await blobToBase64(composite.blob);
        // eslint-disable-next-line no-console
        console.log('[gemini-client] sending composite', {
          mirror: referenceMirrored,
          legsVisible,
          compositeBytes: compositeBase64.length,
          mimeType: composite.mimeType,
          durationSec: composite.durationSec,
        });
        const compositeRequestPayload = {
          endpoint: '/api/score-gemini-composite',
          compositeMimeType: composite.mimeType,
          compositeDurationSec: composite.durationSec,
          compositeBytes: compositeBase64.length,
          legsVisible,
          mirror: referenceMirrored,
        };
        captureTrace.requestPayload = compositeRequestPayload;
        const compRes = await fetch('/api/score-gemini-composite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: composedSignal,
          body: JSON.stringify({
            compositeVideoBase64: compositeBase64,
            compositeMimeType: composite.mimeType,
            legsVisible,
            mirror: referenceMirrored,
          }),
        });
        if (compRes.ok) {
          const cJson = (await compRes.json()) as { score?: unknown; latencyMs?: unknown };
          captureTrace.responseRaw = cJson;
          const cParsed = GeminiScoreSchema.safeParse(cJson.score);
          if (cParsed.success) {
            const latencyMs = typeof cJson.latencyMs === 'number' ? cJson.latencyMs : 0;
            await captureIfEnabled({
              args,
              attemptToSend,
              attemptMimeTypeToSend,
              latencyMs,
              danceId,
              chunkIndex,
              trace: captureTrace,
            });
            return { kind: 'success', score: cParsed.data, latencyMs };
          }
          // eslint-disable-next-line no-console
          console.warn('[gemini-client] composite response failed schema; falling back to two-video', cParsed.error.flatten());
        } else {
          // eslint-disable-next-line no-console
          console.warn('[gemini-client] composite endpoint non-ok; falling back to two-video', {
            status: compRes.status,
          });
        }
      } else {
        // eslint-disable-next-line no-console
        console.log('[gemini-client] composite failed, falling back to two-video', {
          reason: composite.reason,
          detail: composite.detail,
        });
      }
    } else {
      // eslint-disable-next-line no-console
      console.log('[gemini-client] composite skipped (preconditions not met)', {
        trimMode,
        videosMotionOnsetTrimmed,
      });
    }

    const [attemptBase64, referenceBase64] = await Promise.all([
      blobToBase64(attemptToSend),
      blobToBase64(referenceBlob),
    ]);

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

    const twoVideoRequestPayload = {
      endpoint: '/api/score-gemini',
      referenceMimeType,
      attemptMimeType: attemptMimeTypeToSend || 'video/webm',
      legsVisible,
      referenceChunkStartSec,
      referenceChunkEndSec,
      referenceMirrored,
      referenceMotionOnsetSec,
      attemptMotionOnsetSec,
      videosMotionOnsetTrimmed,
      referenceBytes: referenceBase64.length,
      attemptBytes: attemptBase64.length,
    };
    captureTrace.requestPayload = twoVideoRequestPayload;
    captureTrace.mirror = referenceMirrored;

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
    captureTrace.responseRaw = json;
    const parsed = GeminiScoreSchema.safeParse(json.score);
    if (!parsed.success) {
      return { kind: 'error', reason: 'response failed schema validation' };
    }
    const latencyMs = typeof json.latencyMs === 'number' ? json.latencyMs : 0;
    await captureIfEnabled({
      args,
      attemptToSend,
      attemptMimeTypeToSend,
      latencyMs,
      danceId,
      chunkIndex,
      trace: captureTrace,
    });
    return { kind: 'success', score: parsed.data, latencyMs };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Was it our internal timeout or a caller cancel?
      if (signal?.aborted) return { kind: 'error', reason: 'cancelled' };
      // Surface the elapsed wall-clock time so we can tell "client gave
      // up early" (elapsed ≈ DEFAULT_TIMEOUT_MS) apart from "Gemini
      // genuinely didn't return" (elapsed much shorter, which would
      // imply some other AbortError path). The server's retry budget is
      // ~37s; if elapsedMs is close to DEFAULT_TIMEOUT_MS and the
      // server logs show a retry in progress, the timeout needs to go
      // up further.
      const elapsedMs = Math.round(performance.now() - callStartedAt);
      // eslint-disable-next-line no-console
      console.warn('[gemini-client] timeout', {
        elapsedMs,
        budgetMs: DEFAULT_TIMEOUT_MS,
      });
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

// SPECK overnight Track 2 §debug-scoring: fire-and-forget capture into the
// debug attempt store. Pure best-effort — every failure mode (storage
// quota, IDB blocked, base64 fault) is logged and swallowed. The
// user-facing scoring path never observes a failure here.
//
// Gated by the `groov_debug_capture` localStorage flag. When the flag is
// off this function returns immediately without touching the blob.
async function captureIfEnabled(input: {
  args: ScoreWithGeminiArgs;
  attemptToSend: Blob;
  attemptMimeTypeToSend: string;
  latencyMs: number;
  danceId: string | undefined;
  chunkIndex: number | undefined;
  trace: {
    requestPayload: unknown;
    responseRaw: unknown;
    motionOnsetRefSec: number | null;
    motionOnsetAttemptSec: number | null;
    mirror: boolean;
    durationSource: SavedAttempt['durationSource'];
    authoritativeDurationSec: number;
  };
}): Promise<void> {
  if (!isCaptureEnabled()) return;
  try {
    const base64 = await blobToBase64Safe(input.attemptToSend);
    const res = await saveAttempt({
      danceId: input.danceId ?? '<unknown>',
      chunkIndex: input.chunkIndex ?? -1,
      referenceUrl: input.args.referenceVideoUrl,
      attemptBlobBase64: base64,
      attemptMimeType: input.attemptMimeTypeToSend || 'video/webm',
      chunkStartMs: input.args.chunkStartMs,
      chunkEndMs: input.args.chunkEndMs,
      motionOnsetRefSec: input.trace.motionOnsetRefSec,
      motionOnsetAttemptSec: input.trace.motionOnsetAttemptSec,
      mirror: input.trace.mirror,
      legsVisible: input.args.legsVisible,
      requestPayload: input.trace.requestPayload,
      responseRaw: input.trace.responseRaw,
      // The deterministic-layer transformation happens upstream in the
      // page (buildFinalScoreView). client.ts doesn't see it; debug page
      // can re-render the transformation against responseRaw + the
      // MediaPipe inputs the user supplies via Re-score.
      responseDeterministic: null,
      latencyMs: input.latencyMs,
      durationSource: input.trace.durationSource ?? null,
      authoritativeDurationSec: input.trace.authoritativeDurationSec,
    });
    // eslint-disable-next-line no-console
    if (res.ok) console.log('[debug-attempt] saved', { id: res.id, backend: res.backend });
    // eslint-disable-next-line no-console
    else console.warn('[debug-attempt] save failed', { reason: res.reason });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[debug-attempt] save failed', {
      reason: err instanceof Error ? err.message : 'unknown',
    });
  }
}
