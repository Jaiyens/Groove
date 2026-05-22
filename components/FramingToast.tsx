'use client';

// Floating "step back so we can see your upper body" toast for Mode B
// (spec.md round-5 §Fix 4). Triggered when the upper-body landmark set
// (head, shoulders, elbows, wrists, hips, knees — see
// REQUIRED_LANDMARKS) has confidence < 0.5 for >1.5s. Dismissed when
// upper-body confidence recovers above 0.7. We intentionally do NOT
// gate on ankles/feet — most dances we score are upper-body and the
// old toast spuriously fired any time the user's feet were off-screen.
//
// Tapping the toast overlays a translucent body-silhouette guide for 2s
// so the user has a visual target for where to stand.

import { useEffect, useState } from 'react';
import { REQUIRED_LANDMARKS } from '@/lib/pose/framingCheck';
import type { PoseLandmark } from '@/lib/pose/types';

interface FramingToastProps {
  // Latest detected landmarks (or null when MediaPipe returned nothing).
  // The toast computes its own "upper-body confidence" — the mean
  // visibility of the REQUIRED_LANDMARKS subset — and triggers off
  // that, so ankles dropping off-screen no longer false-triggers.
  landmarks: PoseLandmark[] | null;
  className?: string;
}

const LOW_THRESHOLD = 0.5;
const HIGH_THRESHOLD = 0.7;
const LOW_HOLD_MS = 1500;
const SILHOUETTE_DISPLAY_MS = 2000;

// Mean visibility of the upper-body landmark subset (head, shoulders,
// elbows, wrists, hips, knees). 0 when no detection.
function upperBodyConfidence(landmarks: PoseLandmark[] | null): number {
  if (!landmarks) return 0;
  let sum = 0;
  let n = 0;
  for (const idx of REQUIRED_LANDMARKS) {
    const lm = landmarks[idx];
    if (!lm) continue;
    sum += lm.visibility ?? 0;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

export default function FramingToast({
  landmarks,
  className = '',
}: FramingToastProps) {
  const [visible, setVisible] = useState(false);
  const [showSilhouette, setShowSilhouette] = useState(false);

  useEffect(() => {
    let lowSinceMs: number | null = null;
    let raf = 0;
    const tick = () => {
      const c = upperBodyConfidence(landmarks);
      const now = performance.now();
      if (c < LOW_THRESHOLD) {
        if (lowSinceMs === null) lowSinceMs = now;
        if (!visible && now - lowSinceMs >= LOW_HOLD_MS) {
          setVisible(true);
        }
      } else {
        lowSinceMs = null;
        if (visible && c > HIGH_THRESHOLD) {
          setVisible(false);
          setShowSilhouette(false);
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [landmarks, visible]);

  useEffect(() => {
    if (!showSilhouette) return;
    const t = window.setTimeout(
      () => setShowSilhouette(false),
      SILHOUETTE_DISPLAY_MS,
    );
    return () => window.clearTimeout(t);
  }, [showSilhouette]);

  if (!visible) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setShowSilhouette(true)}
        className={`pointer-events-auto absolute bottom-4 left-3 z-30 flex w-fit max-w-[260px] items-center gap-2 rounded-full bg-black/85 px-3.5 py-2 text-left text-xs font-medium text-white ring-1 ring-white/20 backdrop-blur-sm active:scale-95 ${className}`}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
        step back so we can see your upper body
      </button>
      {showSilhouette && <SilhouetteGuide />}
    </>
  );
}

// Translucent body outline centred in the camera view. Used by the
// mid-session Mode B "step back" toast — Mode B scoring needs full
// body so this guide draws head to feet.
export function SilhouetteGuide({
  active = false,
}: {
  // When true, the outline becomes fully opaque. Default is translucent.
  active?: boolean;
}) {
  const color = active ? '#FFFFFF' : 'rgba(255,255,255,0.55)';
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-20 m-auto h-3/4 w-auto"
      viewBox="0 0 100 200"
      fill="none"
      stroke={color}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* Head */}
      <circle cx="50" cy="22" r="11" />
      {/* Neck + shoulders */}
      <path d="M50 33 v8" />
      <path d="M30 50 Q50 41 70 50" />
      {/* Torso */}
      <path d="M30 50 L34 110" />
      <path d="M70 50 L66 110" />
      {/* Hips */}
      <path d="M34 110 L38 120" />
      <path d="M66 110 L62 120" />
      <path d="M38 120 L62 120" />
      {/* Arms */}
      <path d="M30 50 L20 95" />
      <path d="M20 95 L25 130" />
      <path d="M70 50 L80 95" />
      <path d="M80 95 L75 130" />
      {/* Legs */}
      <path d="M38 120 L34 175" />
      <path d="M34 175 L36 195" />
      <path d="M62 120 L66 175" />
      <path d="M66 175 L64 195" />
    </svg>
  );
}

