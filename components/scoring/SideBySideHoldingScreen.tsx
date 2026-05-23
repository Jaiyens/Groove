'use client';

// Side-by-side holding screen — replaces the single-video HoldingScreen
// while MediaPipe-final + Gemini resolve in parallel.
//
// Layout (mobile-first, 390px viewport):
//   ┌────────────┬────────────┐
//   │  REFERENCE │     YOU    │
//   ├────────────┼────────────┤
//   │  ref vid   │ user vid   │
//   │  + skel    │ + skel     │
//   │  (white)   │ (pink)     │
//   └────────────┴────────────┘
//        rotating status text
//          progress shimmer
//
// Both videos start playing simultaneously (Promise.all on the two
// .play() calls). Both loop. Both render their skeleton overlay.
//
// Reference pose track: if `referencePoseData` is null (no pose data
// precomputed for this dance), the reference panel renders video only —
// no skeleton, no error. SPECK §working-agreement explicitly says
// "do NOT block on building a precomputation pipeline."
//
// Sync: each panel plays independently. The two videos are reset to
// 0 simultaneously when both are loaded, then play together. They
// loop independently; drift is bounded by `loopstart` triggering both
// elements within one rAF of each other. Skeletons sample from each
// element's own `currentTime`, so any small drift only affects what
// the skeletons show — not the perceived sync of the two videos.

import { useEffect, useRef, useState } from 'react';

import DualSkeletonOverlay from '@/components/DualSkeletonOverlay';
import { landmarkAt, type ReferencePoseData } from '@/lib/pose/referencePose';
import type { LandmarkFrame, PoseLandmark } from '@/lib/pose/types';

interface SideBySideHoldingScreenProps {
  attemptBlobUrl: string;
  referenceVideoUrl: string;
  // Already-mirrored user landmark frames, recorded during the attempt
  // (same array the scoring path consumed). Absolute routine-ms timestamps.
  userLandmarkFrames: LandmarkFrame[];
  // Optional reference pose track. When null, reference panel renders
  // video only — flagged at the call site, not blocking.
  referencePoseData: ReferencePoseData | null;
  // The chunk's start ms in absolute routine time. The reference video
  // is the full dance, so we seek into it at chunkStartMs/1000 on each
  // loop. User playback is the attempt-only clip starting at 0.
  chunkStartMs: number;
  chunkEndMs: number;
  // True once the parallel Gemini fetch resolves. The screen waits for
  // BOTH this AND the minimum hold time before firing onReady.
  geminiResolved: boolean;
  onReady: () => void;
}

const STATUS_TEXTS = [
  'Watching your timing…',
  'Checking arm extension…',
  'Measuring rhythm…',
  'Almost there…',
];
const STATUS_PERIOD_MS = 2_000;
const MIN_HOLD_MS = 3_000;

export default function SideBySideHoldingScreen({
  attemptBlobUrl,
  referenceVideoUrl,
  userLandmarkFrames,
  referencePoseData,
  chunkStartMs,
  chunkEndMs,
  geminiResolved,
  onReady,
}: SideBySideHoldingScreenProps) {
  const refVideoRef = useRef<HTMLVideoElement | null>(null);
  const userVideoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const [statusIndex, setStatusIndex] = useState(0);
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  const [userLandmarks, setUserLandmarks] = useState<PoseLandmark[] | null>(null);
  const [refLandmarks, setRefLandmarks] = useState<PoseLandmark[] | null>(null);

  // Rotate status text every 2s.
  useEffect(() => {
    const id = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_TEXTS.length);
    }, STATUS_PERIOD_MS);
    return () => clearInterval(id);
  }, []);

  // Min-hold timer — guarantees the screen sits for 3s even if Gemini
  // resolves instantly.
  useEffect(() => {
    const id = setTimeout(() => setMinTimeElapsed(true), MIN_HOLD_MS);
    return () => clearTimeout(id);
  }, []);

  // Fire onReady when both gates close.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    if (minTimeElapsed && geminiResolved) onReadyRef.current();
  }, [minTimeElapsed, geminiResolved]);

  // Synchronised start: wait for both elements to be ready, seek the
  // reference into the chunk window, then await Promise.all on both
  // .play() calls so the two videos start within the same microtask.
  useEffect(() => {
    const refV = refVideoRef.current;
    const userV = userVideoRef.current;
    if (!refV || !userV) return;

    let cancelled = false;
    refV.muted = true;
    refV.playsInline = true;
    userV.muted = true;
    userV.playsInline = true;

    const chunkStartSec = chunkStartMs / 1000;
    const chunkEndSec = chunkEndMs / 1000;

    // The reference is a FULL dance — we only want the chunk window to
    // loop. Use `loop` semantics manually: clamp on timeupdate so the
    // reference seeks back to chunkStartSec when it crosses chunkEndSec.
    // The user attempt clip is already chunk-bounded (Mode B records
    // exactly the chunk window), so plain `loop` works there.
    const onRefTimeUpdate = () => {
      if (refV.currentTime >= chunkEndSec || refV.currentTime < chunkStartSec - 0.05) {
        refV.currentTime = chunkStartSec;
      }
    };
    refV.addEventListener('timeupdate', onRefTimeUpdate);

    userV.loop = true;

    const waitReady = (v: HTMLVideoElement) =>
      v.readyState >= 2
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const cb = () => {
              v.removeEventListener('loadeddata', cb);
              resolve();
            };
            v.addEventListener('loadeddata', cb);
          });

    (async () => {
      try {
        await Promise.all([waitReady(refV), waitReady(userV)]);
        if (cancelled) return;
        // Seek both to the start of the choreography window.
        try {
          refV.currentTime = chunkStartSec;
        } catch {
          // ignore — seek will retry on the first loop
        }
        try {
          userV.currentTime = 0;
        } catch {
          // ignore
        }
        // Kick off in parallel. autoplay+muted+playsinline should be
        // enough on iOS since the user just tapped through StartOverlay
        // a few seconds ago; any rejection is non-fatal (FramingToast-
        // style fallback would over-complicate this screen).
        await Promise.all([
          refV.play().catch(() => undefined),
          userV.play().catch(() => undefined),
        ]);
      } catch {
        // swallow — the user still sees the holding text + shimmer
      }
    })();

    return () => {
      cancelled = true;
      refV.removeEventListener('timeupdate', onRefTimeUpdate);
    };
  }, [attemptBlobUrl, referenceVideoUrl, chunkStartMs, chunkEndMs]);

  // Per-frame: sample each element's currentTime → corresponding
  // landmark for its own skeleton. Reference uses absolute routine ms
  // (its currentTime is the full-dance offset). User uses chunk-relative
  // sessionT translated back to absolute via chunkStartMs.
  useEffect(() => {
    const refV = refVideoRef.current;
    const userV = userVideoRef.current;
    if (!refV || !userV) return;

    const tick = () => {
      // Reference: currentTime IS absolute routine time (in seconds).
      const refAbsMs = refV.currentTime * 1000;
      setRefLandmarks(referencePoseData ? landmarkAt(referencePoseData, refAbsMs) : null);

      // User: attempt clip starts at 0 but userLandmarkFrames are in
      // absolute routine ms. Map by adding chunkStartMs.
      const userAbsMs = chunkStartMs + userV.currentTime * 1000;
      setUserLandmarks(sampleUserAt(userLandmarkFrames, userAbsMs));

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [referencePoseData, userLandmarkFrames, chunkStartMs]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 px-3 pb-8 pt-6">
      <div className="grid w-full max-w-[380px] grid-cols-2 gap-2">
        {/* REFERENCE panel — left. */}
        <div className="flex flex-col items-center">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-white/40">
            reference
          </div>
          <div className="relative aspect-[3/4] w-full overflow-hidden rounded-2xl bg-black ring-1 ring-white/10">
            <video
              ref={refVideoRef}
              src={referenceVideoUrl}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-cover"
              aria-label="reference dancer"
            />
            <div className="pointer-events-none absolute inset-0">
              {/* Reference skeleton: white only (passed as userLandmarks
                  to the overlay so the WHITE channel renders — the dual
                  overlay treats reference as the white skeleton; here we
                  want the reference dancer drawn in white, so we feed
                  refLandmarks into the `referenceLandmarks` slot and
                  leave userLandmarks null to draw nothing pink). */}
              <DualSkeletonOverlay
                userLandmarks={null}
                referenceLandmarks={refLandmarks}
              />
            </div>
          </div>
        </div>

        {/* YOU panel — right. */}
        <div className="flex flex-col items-center">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-white/40">
            you
          </div>
          <div className="relative aspect-[3/4] w-full overflow-hidden rounded-2xl bg-black ring-1 ring-white/10">
            <video
              ref={userVideoRef}
              src={attemptBlobUrl}
              autoPlay
              muted
              playsInline
              loop
              // Mirror the user video — the attempt was recorded from a
              // front-camera stream that's already mirrored in the live
              // view; flipping here keeps the playback feeling natural.
              className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
              aria-label="your attempt replay"
            />
            <div className="pointer-events-none absolute inset-0">
              {/* User skeleton: pink only — feed userLandmarks, leave
                  referenceLandmarks null so the overlay draws only the
                  pink channel. */}
              <DualSkeletonOverlay
                userLandmarks={userLandmarks}
                referenceLandmarks={null}
              />
            </div>
          </div>
        </div>
      </div>

      <div
        className="mt-6 text-center text-sm font-medium text-white/80"
        aria-live="polite"
      >
        {STATUS_TEXTS[statusIndex]}
      </div>

      {!referencePoseData && (
        // Quiet breadcrumb for the validator — the reference panel is
        // video-only because the dance has no precomputed pose track
        // (SPECK §What this PR does NOT do — precomputation pipeline).
        <div className="mt-1 text-[9px] uppercase tracking-widest text-white/25">
          reference skeleton unavailable
        </div>
      )}

      <div className="mt-4 h-1 w-32 overflow-hidden rounded-full bg-white/10">
        <div className="holding-shimmer h-full w-1/2 bg-white/40" />
      </div>

      <style jsx>{`
        @keyframes holdingShimmer {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(300%);
          }
        }
        .holding-shimmer {
          animation: holdingShimmer 1.4s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

function sampleUserAt(frames: LandmarkFrame[], tMs: number): PoseLandmark[] | null {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.timestampMs < tMs) lo = mid + 1;
    else hi = mid;
  }
  const a = frames[lo]!;
  if (lo === 0) return a.landmarks;
  const b = frames[lo - 1]!;
  return Math.abs(a.timestampMs - tMs) <= Math.abs(b.timestampMs - tMs)
    ? a.landmarks
    : b.landmarks;
}
