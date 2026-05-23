// Side-by-side composite video composer.
//
// SPECK overnight Group 4 §composite: today the Gemini scoring path sends
// two separate videos (REFERENCE, ATTEMPT) and asks the model to mentally
// align them in time. The composite approach renders a single video with
// REFERENCE drawn on the LEFT half and ATTEMPT on the RIGHT half, audio-
// synced to the reference. Gemini does direct visual comparison instead
// of temporal inference. Halves the API payload, removes a whole class
// of alignment failure modes.
//
// This module is the renderer. It opens both videos as hidden <video>
// elements, seeks each to its detected motion-onset moment, plays them
// in lock-step into a 1280×720 canvas with an audio track from the
// reference, and captures the result via MediaRecorder. The output is a
// vp9 webm blob ready to send to /api/score-gemini-composite.
//
// Failure semantics: NEVER throw to the caller. Every failure path
// returns a {kind: 'failure', reason} discriminated union with a short
// stable tag the caller can log. Callers degrade to two-video silently.
// The whole composer is wrapped in a 10s internal timeout so a hung
// canvas-encode can't block the score pipeline.
//
// Logging: every entry/exit point emits a [composite] log line so a
// browser-side trace shows the same shape as the existing
// [gemini-client] motion-onset trimAttempt: family.

export type CompositeSuccess = {
  kind: 'success';
  blob: Blob;
  mimeType: string;
  durationSec: number;
};

export type CompositeFailureReason =
  | 'dom-unavailable'
  | 'mediarecorder-unavailable'
  | 'canvas-unavailable'
  | 'invalid-args'
  | 'reference-load-failed'
  | 'attempt-load-failed'
  | 'reference-duration-invalid'
  | 'attempt-duration-invalid'
  | 'seek-failed'
  | 'captureStream-unavailable'
  | 'no-audio-track'
  | 'recorder-failed'
  | 'empty-output'
  | 'timeout'
  | 'threw';

export type CompositeFailure = {
  kind: 'failure';
  reason: CompositeFailureReason;
  detail?: string;
};

export type CompositeResult = CompositeSuccess | CompositeFailure;

export interface RenderCompositeArgs {
  referenceUrl: string;
  attemptBlob: Blob;
  // True when the reference half should be horizontally flipped to match
  // the front-camera-mirrored attempt. Set by the caller from the shared
  // mirror preference (lib/preferences/mirror.ts), surfaced into the
  // Gemini prompt as `mirror: <value>` so the model knows whether
  // left/right correspond directly across halves.
  mirror: boolean;
  // Absolute seconds in the source videos where motion onset was
  // detected. We seek to these before play-and-record so the composite
  // starts at first-dance-movement on both sides.
  motionOnsetRefSec: number;
  motionOnsetAttemptSec: number;
  // How many seconds to record into the composite. Caller passes
  // `min(7, attemptDurationSec)` per spec.
  chunkDurationSec: number;
}

// Canvas dimensions. 1280×720 keeps each half at 640×720, a 9:16-ish
// portrait window per side that comfortably fits typical phone-record
// aspect ratios with letterboxing.
const CANVAS_W = 1280;
const CANVAS_H = 720;
const HALF_W = CANVAS_W / 2;

// Total wall-clock budget for the entire renderSideBySideVideo call.
// Recording the chunk takes ~chunkDurationSec, plus seek/play setup +
// stop drain. 10s ceiling protects the rest of the pipeline if the
// browser hangs mid-encode.
const INTERNAL_TIMEOUT_MS = 10_000;

// Bound the chunk duration we'll respect from the caller. Anything
// past 8s is past the spec's `min(7, attemptDurationSec)` ceiling and
// indicates a buggy caller — we'd rather fail fast than chew the
// timeout encoding 30s.
const MAX_CHUNK_DURATION_SEC = 8;

// Pre-flight argument validation. Returns null when args are OK, else a
// CompositeFailure that the caller can return directly.
function validateArgs(args: RenderCompositeArgs): CompositeFailure | null {
  if (typeof args.referenceUrl !== 'string' || args.referenceUrl.length === 0) {
    return { kind: 'failure', reason: 'invalid-args', detail: 'empty referenceUrl' };
  }
  if (!(args.attemptBlob instanceof Blob) || args.attemptBlob.size === 0) {
    return { kind: 'failure', reason: 'invalid-args', detail: 'empty attemptBlob' };
  }
  if (typeof args.mirror !== 'boolean') {
    return { kind: 'failure', reason: 'invalid-args', detail: 'mirror must be boolean' };
  }
  if (!Number.isFinite(args.motionOnsetRefSec) || args.motionOnsetRefSec < 0) {
    return { kind: 'failure', reason: 'invalid-args', detail: 'motionOnsetRefSec invalid' };
  }
  if (!Number.isFinite(args.motionOnsetAttemptSec) || args.motionOnsetAttemptSec < 0) {
    return { kind: 'failure', reason: 'invalid-args', detail: 'motionOnsetAttemptSec invalid' };
  }
  if (!Number.isFinite(args.chunkDurationSec) || args.chunkDurationSec <= 0) {
    return { kind: 'failure', reason: 'invalid-args', detail: 'chunkDurationSec ≤ 0' };
  }
  if (args.chunkDurationSec > MAX_CHUNK_DURATION_SEC) {
    return {
      kind: 'failure',
      reason: 'invalid-args',
      detail: `chunkDurationSec ${args.chunkDurationSec} > ceiling ${MAX_CHUNK_DURATION_SEC}`,
    };
  }
  return null;
}

// Pre-flight environment check. The renderer needs DOM + MediaRecorder +
// canvas. Each missing capability has its own reason tag so a field log
// can pinpoint the gap (e.g. older mobile Safari builds without
// MediaRecorder webm support).
function checkEnvironment(): CompositeFailure | null {
  if (typeof document === 'undefined') {
    return { kind: 'failure', reason: 'dom-unavailable' };
  }
  if (typeof MediaRecorder === 'undefined') {
    return { kind: 'failure', reason: 'mediarecorder-unavailable' };
  }
  // Quick canvas test — some sandboxed iframes have document but no
  // canvas-capable HTMLCanvasElement.
  try {
    const c = document.createElement('canvas');
    if (!c.getContext('2d')) {
      return { kind: 'failure', reason: 'canvas-unavailable' };
    }
  } catch {
    return { kind: 'failure', reason: 'canvas-unavailable' };
  }
  return null;
}

async function loadHiddenVideo(
  src: string,
  reasonOnFail: CompositeFailureReason,
): Promise<{ video: HTMLVideoElement; dispose: () => void } | CompositeFailure> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = false; // we want the audio track for the reference
  video.playsInline = true;
  video.preload = 'auto';
  video.style.position = 'fixed';
  video.style.left = '-10000px';
  video.style.top = '-10000px';
  video.style.width = '1px';
  video.style.height = '1px';
  document.body.appendChild(video);
  video.src = src;

  try {
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
  } catch (err) {
    if (video.parentNode) video.parentNode.removeChild(video);
    return {
      kind: 'failure',
      reason: reasonOnFail,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

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

async function seekVideoTo(video: HTMLVideoElement, sec: number): Promise<boolean> {
  try {
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
        reject(new Error('seek error'));
      };
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
    });
    return true;
  } catch {
    return false;
  }
}

// Letterbox draw — preserve the source aspect ratio inside a fixed half-
// width box at (offsetX, 0) of dimensions (HALF_W, CANVAS_H). Both inner
// faces against the centerline; outer faces against the canvas edges.
function drawLetterboxed(
  ctx: CanvasRenderingContext2D,
  source: HTMLVideoElement,
  offsetX: number,
  flipX: boolean,
): void {
  const srcW = source.videoWidth;
  const srcH = source.videoHeight;
  if (srcW === 0 || srcH === 0) return;
  const targetAspect = HALF_W / CANVAS_H;
  const srcAspect = srcW / srcH;
  let drawW = HALF_W;
  let drawH = CANVAS_H;
  if (srcAspect > targetAspect) {
    drawH = HALF_W / srcAspect;
  } else {
    drawW = CANVAS_H * srcAspect;
  }
  const dx = offsetX + (HALF_W - drawW) / 2;
  const dy = (CANVAS_H - drawH) / 2;

  if (flipX) {
    ctx.save();
    // Mirror inside the half-window: translate to the right edge of the
    // half and scaleX(-1) so the draw lands flipped within the same
    // letterbox bounds.
    ctx.translate(offsetX + HALF_W, 0);
    ctx.scale(-1, 1);
    // After the transform, the draw origin shifts: we want the flipped
    // image to sit at the same dx within the half, so subtract from
    // HALF_W to mirror the offset.
    const flippedDx = HALF_W - dx + offsetX - drawW;
    ctx.drawImage(source, flippedDx, dy, drawW, drawH);
    ctx.restore();
  } else {
    ctx.drawImage(source, dx, dy, drawW, drawH);
  }
}

// Pull an audio track off a video element. Returns null when there's no
// audible track — used to log the no-audio case but still proceed
// silently (Gemini doesn't strictly need the audio, just the visuals).
type CapturableVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};
function extractAudioTracks(video: HTMLVideoElement): MediaStreamTrack[] {
  const capturable = video as CapturableVideo;
  const captureFn = capturable.captureStream ?? capturable.mozCaptureStream;
  if (typeof captureFn !== 'function') return [];
  try {
    const stream = captureFn.call(video);
    return stream.getAudioTracks();
  } catch {
    return [];
  }
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'video/webm';
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
    return 'video/webm;codecs=vp9,opus';
  }
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
    return 'video/webm;codecs=vp9';
  }
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
    return 'video/webm;codecs=vp8';
  }
  return 'video/webm';
}

export async function renderSideBySideVideo(
  args: RenderCompositeArgs,
): Promise<CompositeResult> {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // eslint-disable-next-line no-console
  console.log('[composite] entry', {
    referenceUrlHint: args.referenceUrl.slice(0, 64),
    attemptBlobBytes: args.attemptBlob?.size ?? 0,
    mirror: args.mirror,
    motionOnsetRefSec: args.motionOnsetRefSec,
    motionOnsetAttemptSec: args.motionOnsetAttemptSec,
    chunkDurationSec: args.chunkDurationSec,
  });

  const argFailure = validateArgs(args);
  if (argFailure) {
    // eslint-disable-next-line no-console
    console.warn('[composite] failure', argFailure);
    return argFailure;
  }
  const envFailure = checkEnvironment();
  if (envFailure) {
    // eslint-disable-next-line no-console
    console.warn('[composite] failure', envFailure);
    return envFailure;
  }

  // Overall budget guard. If anything below this point hangs past the
  // budget, we abort with a 'timeout' result rather than blocking the
  // entire scoring pipeline.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
  }, INTERNAL_TIMEOUT_MS);

  const cleanups: Array<() => void> = [];
  const runCleanups = () => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
    cleanups.length = 0;
  };

  try {
    // Open the attempt as an object URL (it's a Blob). The reference is
    // a URL already.
    const attemptObjectUrl = URL.createObjectURL(args.attemptBlob);
    cleanups.push(() => URL.revokeObjectURL(attemptObjectUrl));

    const refLoaded = await loadHiddenVideo(args.referenceUrl, 'reference-load-failed');
    if ('kind' in refLoaded && refLoaded.kind === 'failure') {
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', refLoaded);
      return refLoaded;
    }
    if (timedOut) return finalizeTimeout();
    const refVideo = (refLoaded as { video: HTMLVideoElement }).video;
    cleanups.push((refLoaded as { dispose: () => void }).dispose);

    const attemptLoaded = await loadHiddenVideo(attemptObjectUrl, 'attempt-load-failed');
    if ('kind' in attemptLoaded && attemptLoaded.kind === 'failure') {
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', attemptLoaded);
      return attemptLoaded;
    }
    if (timedOut) return finalizeTimeout();
    const attemptVideo = (attemptLoaded as { video: HTMLVideoElement }).video;
    cleanups.push((attemptLoaded as { dispose: () => void }).dispose);

    // Sanity-check durations. We don't trust attempt's video.duration
    // (Group 1 showed why), but the caller already trimmed the attempt
    // to a known motion-onset offset; if duration here is still wholly
    // bogus we bail out into the two-video fallback.
    if (
      !Number.isFinite(refVideo.duration) ||
      refVideo.duration <= 0 ||
      refVideo.duration > 600
    ) {
      const f: CompositeFailure = {
        kind: 'failure',
        reason: 'reference-duration-invalid',
        detail: `duration=${refVideo.duration}`,
      };
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', f);
      return f;
    }
    if (
      !Number.isFinite(attemptVideo.duration) ||
      attemptVideo.duration <= 0 ||
      attemptVideo.duration > 600
    ) {
      const f: CompositeFailure = {
        kind: 'failure',
        reason: 'attempt-duration-invalid',
        detail: `duration=${attemptVideo.duration}`,
      };
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', f);
      return f;
    }

    // Seek both to motion-onset starts.
    const refSeekOk = await seekVideoTo(refVideo, Math.min(args.motionOnsetRefSec, Math.max(0, refVideo.duration - 0.05)));
    if (!refSeekOk || timedOut) {
      const f: CompositeFailure = timedOut
        ? { kind: 'failure', reason: 'timeout', detail: 'during seek' }
        : { kind: 'failure', reason: 'seek-failed', detail: 'reference seek' };
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', f);
      return f;
    }
    const attemptSeekOk = await seekVideoTo(attemptVideo, Math.min(args.motionOnsetAttemptSec, Math.max(0, attemptVideo.duration - 0.05)));
    if (!attemptSeekOk || timedOut) {
      const f: CompositeFailure = timedOut
        ? { kind: 'failure', reason: 'timeout', detail: 'during attempt seek' }
        : { kind: 'failure', reason: 'seek-failed', detail: 'attempt seek' };
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', f);
      return f;
    }

    // Build the canvas + recording pipeline.
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { kind: 'failure', reason: 'canvas-unavailable', detail: 'getContext returned null' };
    }
    type CapturableCanvas = HTMLCanvasElement & {
      captureStream?: (frameRate?: number) => MediaStream;
    };
    const capturableCanvas = canvas as CapturableCanvas;
    if (typeof capturableCanvas.captureStream !== 'function') {
      return {
        kind: 'failure',
        reason: 'captureStream-unavailable',
        detail: 'canvas.captureStream undefined',
      };
    }
    const canvasStream = capturableCanvas.captureStream(30);

    // Audio: try to pull from the reference. Attempts don't have a
    // usable audio track in this app (recording is video-only). It's
    // OK to omit audio entirely — the prompt is visual-only.
    const refAudio = extractAudioTracks(refVideo);
    const outputStream = new MediaStream();
    for (const t of canvasStream.getVideoTracks()) outputStream.addTrack(t);
    for (const t of refAudio) outputStream.addTrack(t);

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(outputStream, { mimeType });
    } catch (err) {
      const f: CompositeFailure = {
        kind: 'failure',
        reason: 'recorder-failed',
        detail: err instanceof Error ? err.message : String(err),
      };
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', f);
      return f;
    }
    const recordedChunks: Blob[] = [];
    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
    };

    // Prime the canvas with the first paired frame so the recorder has
    // immediate content at t=0.
    drawCanvasBackground(ctx);
    drawLetterboxed(ctx, refVideo, 0, args.mirror);
    drawLetterboxed(ctx, attemptVideo, HALF_W, false);

    // Both videos muted to start so .play() can autoplay without a
    // user-gesture prompt. The audio track was already extracted above.
    refVideo.muted = true;
    attemptVideo.muted = true;
    recorder.start();
    const recordStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

    try {
      await Promise.all([refVideo.play(), attemptVideo.play()]);
    } catch (err) {
      try { recorder.stop(); } catch { /* ignore */ }
      const f: CompositeFailure = {
        kind: 'failure',
        reason: 'recorder-failed',
        detail: `play() rejected: ${err instanceof Error ? err.message : String(err)}`,
      };
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', f);
      return f;
    }

    const targetEnd = recordStartedAt + args.chunkDurationSec * 1000;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        try {
          drawCanvasBackground(ctx);
          drawLetterboxed(ctx, refVideo, 0, args.mirror);
          drawLetterboxed(ctx, attemptVideo, HALF_W, false);
        } catch {
          // ignore per-frame draw faults — the next frame retries
        }
        if (timedOut || now >= targetEnd) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      try { recorder.requestData(); } catch { /* older recorders */ }
      try { recorder.stop(); } catch { /* already stopping */ }
    });

    canvasStream.getTracks().forEach((t) => t.stop());

    if (timedOut) return finalizeTimeout();

    const blob = new Blob(recordedChunks, { type: mimeType });
    if (blob.size === 0) {
      const f: CompositeFailure = { kind: 'failure', reason: 'empty-output' };
      // eslint-disable-next-line no-console
      console.warn('[composite] failure', f);
      return f;
    }
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
    // eslint-disable-next-line no-console
    console.log('[composite] success', {
      blobBytes: blob.size,
      mimeType,
      durationSec: args.chunkDurationSec,
      elapsedMs: Math.round(elapsed),
    });
    return {
      kind: 'success',
      blob,
      mimeType,
      durationSec: args.chunkDurationSec,
    };
  } catch (err) {
    const f: CompositeFailure = {
      kind: 'failure',
      reason: 'threw',
      detail: err instanceof Error ? err.message : String(err),
    };
    // eslint-disable-next-line no-console
    console.warn('[composite] failure (caught)', f);
    return f;
  } finally {
    clearTimeout(timeoutHandle);
    runCleanups();
  }

  function finalizeTimeout(): CompositeFailure {
    const f: CompositeFailure = { kind: 'failure', reason: 'timeout' };
    // eslint-disable-next-line no-console
    console.warn('[composite] failure', f);
    return f;
  }
}

function drawCanvasBackground(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

// Exposed for unit tests — exercises argument + env validation paths
// without spinning up a real DOM/<video>/canvas.
export const __testing = { validateArgs, checkEnvironment };
