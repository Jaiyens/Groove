'use client';

// Holding screen — sits between attempt-end and results.
//
// Responsibilities:
//   - Play back the user's recorded attempt (Blob → object URL).
//   - Overlay the dual-skeleton (reference white, user coral) on top of
//     the replay, sampled at the playback head.
//   - Status text rotates every 2s through the four "Watching / Checking
//     / Measuring / Almost there…" phrases.
//   - Sit for MIN_HOLD_MS even if Gemini is already done — gives the user
//     a beat of "you finished" before slamming them with a score.
//   - Once both minTimeElapsed && geminiResolved, fire onReady.
//
// Reuses components/DualSkeletonOverlay — does not rebuild.

import { useEffect, useRef, useState } from 'react';

import DualSkeletonOverlay from '@/components/DualSkeletonOverlay';
import { landmarkAt, type ReferencePoseData } from '@/lib/pose/referencePose';
import type { LandmarkFrame, PoseLandmark } from '@/lib/pose/types';

interface HoldingScreenProps {
  attemptBlobUrl: string;
  // Already-mirrored user landmark frames, recorded during the attempt
  // (same array the scoring path consumed). Absolute routine-ms timestamps.
  userLandmarkFrames: LandmarkFrame[];
  // Optional reference pose data — when present, the user's playback gets
  // the reference skeleton ghost-overlayed too. Falls back to user-only
  // when null (legacy fixtures).
  referencePoseData: ReferencePoseData | null;
  // The chunk's start ms in absolute routine time, so we can map video
  // playback time (0..duration) into the absolute timestamp space that
  // userLandmarkFrames / referencePoseData live in.
  chunkStartMs: number;
  // Set to true by the parent once the parallel Gemini fetch resolves
  // (success or failure). The holding screen stops once this AND the
  // minimum hold time have both happened.
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

export default function HoldingScreen({
  attemptBlobUrl,
  userLandmarkFrames,
  referencePoseData,
  chunkStartMs,
  geminiResolved,
  onReady,
}: HoldingScreenProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [statusIndex, setStatusIndex] = useState(0);
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  const [userLandmarks, setUserLandmarks] = useState<PoseLandmark[] | null>(null);
  const [refLandmarks, setRefLandmarks] = useState<PoseLandmark[] | null>(null);

  // Rotate status text.
  useEffect(() => {
    const id = setInterval(() => {
      setStatusIndex((i) => (i + 1) % STATUS_TEXTS.length);
    }, STATUS_PERIOD_MS);
    return () => clearInterval(id);
  }, []);

  // Min-hold timer.
  useEffect(() => {
    const id = setTimeout(() => setMinTimeElapsed(true), MIN_HOLD_MS);
    return () => clearTimeout(id);
  }, []);

  // Fire onReady when both conditions are met. onReady captured stably.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    if (minTimeElapsed && geminiResolved) onReadyRef.current();
  }, [minTimeElapsed, geminiResolved]);

  // Loop playback so the user always has motion under the status text,
  // even if the attempt is shorter than the time-to-resolve.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.loop = true;
    v.muted = true;
    v.playsInline = true;
    void v.play().catch(() => {
      // autoplay might fail without user gesture; not fatal here because
      // the user just tapped through StartOverlay seconds ago.
    });
  }, [attemptBlobUrl]);

  // Per-frame: map video.currentTime → landmark sample for both tracks.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const tick = () => {
      const absMs = chunkStartMs + v.currentTime * 1000;
      setUserLandmarks(sampleUserAt(userLandmarkFrames, absMs));
      setRefLandmarks(referencePoseData ? landmarkAt(referencePoseData, absMs) : null);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [chunkStartMs, userLandmarkFrames, referencePoseData]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 px-6 pb-8 pt-6">
      {/* Replay container — 16:9 box, max-width 360px so it fits a 390px
          viewport with breathing room and the status row below is visible. */}
      <div className="relative w-full max-w-[360px] overflow-hidden rounded-2xl bg-black ring-1 ring-white/10">
        <div className="relative aspect-[3/4] w-full">
          <video
            ref={videoRef}
            src={attemptBlobUrl}
            autoPlay
            muted
            playsInline
            loop
            className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
            aria-label="your attempt replay"
          />
          <div className="pointer-events-none absolute inset-0">
            <DualSkeletonOverlay
              userLandmarks={userLandmarks}
              referenceLandmarks={refLandmarks}
            />
          </div>
        </div>
      </div>

      <div
        className="mt-6 text-center text-sm font-medium text-white/80"
        aria-live="polite"
      >
        {STATUS_TEXTS[statusIndex]}
      </div>

      {/* Subtle progress shimmer, no percentage. */}
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
  // Binary search for the nearest frame to tMs.
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.timestampMs < tMs) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first frame >= tMs. Compare with previous to pick nearest.
  const a = frames[lo]!;
  if (lo === 0) return a.landmarks;
  const b = frames[lo - 1]!;
  return Math.abs(a.timestampMs - tMs) <= Math.abs(b.timestampMs - tMs)
    ? a.landmarks
    : b.landmarks;
}
