'use client';

import { useEffect, useRef } from 'react';
import { SKELETON_EDGES, type PoseLandmark } from '@/lib/pose/types';

interface SkeletonOverlayProps {
  landmarks: PoseLandmark[] | null;
  // The aspect of the video the overlay sits on, e.g. width/height of <video>.
  width: number;
  height: number;
  // 'mirror' flips the x coordinate, useful when the camera is a selfie-view.
  mirror?: boolean;
  edgeColor?: string;
  jointColor?: string;
}

export default function SkeletonOverlay({
  landmarks,
  width,
  height,
  mirror = true,
  edgeColor = '#25f4ee',
  jointColor = '#fe2c55',
}: SkeletonOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    c.width = width * dpr;
    c.height = height * dpr;
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!landmarks || landmarks.length === 0) return;

    const x = (lm: PoseLandmark) => (mirror ? (1 - lm.x) * width : lm.x * width);
    const y = (lm: PoseLandmark) => lm.y * height;

    // Edges first, then joints on top.
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = edgeColor;
    ctx.shadowBlur = 8;
    ctx.shadowColor = edgeColor;
    for (const [i, j] of SKELETON_EDGES) {
      const a = landmarks[i];
      const b = landmarks[j];
      if (!a || !b) continue;
      if ((a.visibility ?? 0) < 0.3 || (b.visibility ?? 0) < 0.3) continue;
      ctx.beginPath();
      ctx.moveTo(x(a), y(a));
      ctx.lineTo(x(b), y(b));
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = jointColor;
    for (const lm of landmarks) {
      if ((lm.visibility ?? 0) < 0.3) continue;
      ctx.beginPath();
      ctx.arc(x(lm), y(lm), 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [landmarks, width, height, mirror, edgeColor, jointColor]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    />
  );
}
