'use client';

// Dual-skeleton overlay for Mode B.
//
// Renders TWO skeletons in the same canonical body frame:
//   - the reference dancer, mirror-flipped so a follow-along user can see
//     the move in their own perspective (their right hand on the screen
//     right, matching their selfie view).
//   - the user, live from the camera pose extractor.
//
// Both are normalized to a shared hip-midpoint origin with shoulder-to-hip
// distance = 1.0, so they line up regardless of where the user stands or
// what camera was used to film the reference. When the user is dancing
// the move correctly, the two skeletons should overlap closely.
//
// Visual layering: rendered ABOVE the camera <video> but BELOW the score
// pill (caller controls z-index). Defaults to translucent so the user can
// still see the camera image behind it.

import { useEffect, useRef } from 'react';
import { mirrorLandmarksHorizontal, normalizeToBody } from '@/lib/pose/normalize';
import { SKELETON_EDGES, type PoseLandmark } from '@/lib/pose/types';

interface DualSkeletonOverlayProps {
  userLandmarks: PoseLandmark[] | null;
  referenceLandmarks: PoseLandmark[] | null;
  // If true (default), the reference skeleton is horizontally flipped so
  // the user — who is mirroring the dancer — sees a partner in their own
  // perspective. Off for unit tests / debug.
  mirrorReference?: boolean;
  // Anchor for hip midpoint in normalized canvas coords (0..1). Default
  // (0.5, 0.62) puts the figure roughly center, vertically biased low so
  // the head doesn't clip into the top status pill.
  anchorX?: number;
  anchorY?: number;
  // Body scale relative to the smaller of canvas dimensions: fraction of
  // canvas-min that the shoulder-to-hip unit maps to. Default 0.18 →
  // entire torso+head is ~0.4 of the screen height.
  scale?: number;
  // Min visibility to draw a joint. Lower = more flicker, higher = drops
  // partial detections.
  minVisibility?: number;
  // Pure ARIA hidden — this is decorative.
  className?: string;
}

const REF_COLOR = '#ffffff';
const REF_JOINT_COLOR = '#ffffff';
const USER_COLOR = '#ff7a59'; // brand coral
const USER_JOINT_COLOR = '#ff7a59';

export default function DualSkeletonOverlay({
  userLandmarks,
  referenceLandmarks,
  mirrorReference = true,
  anchorX = 0.5,
  anchorY = 0.62,
  scale = 0.18,
  minVisibility = 0.3,
  className,
}: DualSkeletonOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const userRef = useRef<PoseLandmark[] | null>(null);
  const refRef = useRef<PoseLandmark[] | null>(null);

  // Stash latest landmarks so the rAF loop doesn't need them in deps.
  userRef.current = userLandmarks;
  refRef.current = referenceLandmarks;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const rect = c.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const targetW = Math.max(1, Math.round(w * dpr));
      const targetH = Math.max(1, Math.round(h * dpr));
      if (c.width !== targetW || c.height !== targetH) {
        c.width = targetW;
        c.height = targetH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      if (w === 0 || h === 0) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const minDim = Math.min(w, h);
      const pixelScale = scale * minDim;
      const ax = anchorX * w;
      const ay = anchorY * h;

      const refLm = refRef.current;
      if (refLm) {
        const src = mirrorReference ? mirrorLandmarksHorizontal(refLm) : refLm;
        const norm = normalizeToBody(src);
        if (norm.ok) {
          drawSkeleton(ctx, norm.landmarks, ax, ay, pixelScale, {
            edgeColor: REF_COLOR,
            jointColor: REF_JOINT_COLOR,
            edgeAlpha: 0.85,
            edgeWidth: 5,
            jointRadius: 4.5,
            minVisibility,
          });
        }
      }

      const userLm = userRef.current;
      if (userLm) {
        const norm = normalizeToBody(userLm);
        if (norm.ok) {
          drawSkeleton(ctx, norm.landmarks, ax, ay, pixelScale, {
            edgeColor: USER_COLOR,
            jointColor: USER_JOINT_COLOR,
            edgeAlpha: 0.9,
            edgeWidth: 4,
            jointRadius: 4,
            minVisibility,
          });
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [anchorX, anchorY, scale, minVisibility, mirrorReference]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className ?? 'pointer-events-none absolute inset-0 h-full w-full'}
    />
  );
}

interface DrawOptions {
  edgeColor: string;
  jointColor: string;
  edgeAlpha: number;
  edgeWidth: number;
  jointRadius: number;
  minVisibility: number;
}

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: PoseLandmark[],
  ax: number,
  ay: number,
  pixelScale: number,
  opts: DrawOptions,
) {
  // landmarks are in body-canonical coords: hip midpoint at origin,
  // shoulder-to-hip = 1.0, +Y down (since MediaPipe normalized landmarks
  // increase y downward in image space). We map (bx, by) → (ax + bx*S,
  // ay + by*S).
  const project = (lm: PoseLandmark) => ({
    x: ax + lm.x * pixelScale,
    y: ay + lm.y * pixelScale,
  });

  ctx.save();
  ctx.globalAlpha = opts.edgeAlpha;
  ctx.lineWidth = opts.edgeWidth;
  ctx.lineCap = 'round';
  ctx.strokeStyle = opts.edgeColor;
  ctx.shadowBlur = 6;
  ctx.shadowColor = opts.edgeColor;

  for (const [i, j] of SKELETON_EDGES) {
    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) continue;
    if (
      (a.visibility ?? 0) < opts.minVisibility ||
      (b.visibility ?? 0) < opts.minVisibility
    )
      continue;
    const pa = project(a);
    const pb = project(b);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = opts.jointColor;
  for (const lm of landmarks) {
    if ((lm.visibility ?? 0) < opts.minVisibility) continue;
    const p = project(lm);
    ctx.beginPath();
    ctx.arc(p.x, p.y, opts.jointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
