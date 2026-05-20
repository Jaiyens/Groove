'use client';

import { useEffect, useRef, useState } from 'react';
import {
  computeCoverGeometry,
  projectNormalized,
  type ObjectCoverGeometry,
} from '@/lib/pose/projection';
import { SKELETON_EDGES, type PoseLandmark } from '@/lib/pose/types';

interface SkeletonOverlayProps {
  landmarks: PoseLandmark[] | null;
  // The <video> element these landmarks were detected from. The canvas reads
  // the video's intrinsic (videoWidth/Height) and displayed (clientW/H) size
  // to project landmark normalized coords correctly through object-fit: cover.
  videoRef: React.RefObject<HTMLVideoElement | null>;
  // When true (selfie cam), CSS-mirrors the canvas so it matches a
  // CSS-mirrored video. Landmarks are drawn in their native un-mirrored
  // coordinate frame regardless — the mirroring is purely visual.
  mirror?: boolean;
  // Hides the overlay when the most recent detection was too long ago (ms).
  // Default 1000ms — if the pose tracker drops out, the skeleton fades out
  // instead of freezing mid-air.
  staleAfterMs?: number;
  edgeColor?: string;
  jointColor?: string;
  minVisibility?: number;
}

// Returns the most recent geometry of the <video> element. Re-measures when
// the element resizes, when the video's intrinsic size changes (loadedmetadata),
// or when the window is resized.
function useVideoGeometry(
  videoRef: React.RefObject<HTMLVideoElement | null>,
): ObjectCoverGeometry {
  const [geom, setGeom] = useState<ObjectCoverGeometry>(() =>
    computeCoverGeometry(0, 0, 0, 0),
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const measure = () => {
      const rect = v.getBoundingClientRect();
      setGeom(
        computeCoverGeometry(
          v.videoWidth,
          v.videoHeight,
          rect.width,
          rect.height,
        ),
      );
    };

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(v);

    v.addEventListener('loadedmetadata', measure);
    v.addEventListener('resize', measure);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);

    return () => {
      ro.disconnect();
      v.removeEventListener('loadedmetadata', measure);
      v.removeEventListener('resize', measure);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [videoRef]);

  return geom;
}

export default function SkeletonOverlay({
  landmarks,
  videoRef,
  mirror = true,
  staleAfterMs = 1000,
  edgeColor = '#25f4ee',
  jointColor = '#fe2c55',
  minVisibility = 0.3,
}: SkeletonOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geom = useVideoGeometry(videoRef);
  const lastDrawAtRef = useRef<number>(0);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const { containerWidth: w, containerHeight: h } = geom;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    // Resize backing store only when needed — avoids state-loss flicker every frame.
    const targetW = Math.max(1, Math.round(w * dpr));
    const targetH = Math.max(1, Math.round(h * dpr));
    if (c.width !== targetW || c.height !== targetH) {
      c.width = targetW;
      c.height = targetH;
    }
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!landmarks || landmarks.length === 0) return;
    if (w === 0 || h === 0) return;

    lastDrawAtRef.current = performance.now();

    const project = (lm: PoseLandmark) =>
      projectNormalized({ x: lm.x, y: lm.y }, geom);

    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = edgeColor;
    ctx.shadowBlur = 8;
    ctx.shadowColor = edgeColor;
    for (const [i, j] of SKELETON_EDGES) {
      const a = landmarks[i];
      const b = landmarks[j];
      if (!a || !b) continue;
      if ((a.visibility ?? 0) < minVisibility || (b.visibility ?? 0) < minVisibility) {
        continue;
      }
      const pa = project(a);
      const pb = project(b);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = jointColor;
    for (const lm of landmarks) {
      if ((lm.visibility ?? 0) < minVisibility) continue;
      const p = project(lm);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [landmarks, geom, edgeColor, jointColor, minVisibility]);

  // Clear when pose tracking goes stale (no new landmarks for N ms).
  useEffect(() => {
    if (!staleAfterMs) return;
    const id = window.setInterval(() => {
      if (performance.now() - lastDrawAtRef.current > staleAfterMs) {
        const c = canvasRef.current;
        const ctx = c?.getContext('2d');
        if (ctx && c) ctx.clearRect(0, 0, c.width, c.height);
      }
    }, Math.max(200, Math.floor(staleAfterMs / 2)));
    return () => window.clearInterval(id);
  }, [staleAfterMs]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
      aria-hidden
    />
  );
}
