'use client';

// Press-start + countdown gate shown before Mode A and Mode B begin
// (SPECK round-4 §Fix 2). The video / audio / scoring loop must not run
// until the user taps "start" and the audible 3-2-1-GO finishes.
//
// Lifecycle:
//   idle      → "start" button visible, nothing else happening
//   counting  → 3 → 2 → 1 with one tick per second (880 Hz)
//   go        → emphasis tick (660 Hz) + onGo() fires + "GO" flash
//   done      → overlay unmounts
//
// onGo fires exactly once, the instant the countdown lands on zero —
// the parent uses it to start the reference video / scoring clock so
// the user's first move is in sync with the audio.

import { useEffect, useRef, useState } from 'react';
import { playTick } from '@/lib/audio/tick';

interface StartOverlayProps {
  chunkNumber: number; // 1-indexed
  totalChunks: number;
  chunkLabel: string;
  subtitle: string;
  ctaLabel?: string;
  // Fires immediately when the user taps "start" — use it to request
  // camera permission, resume audio, or otherwise consume the user
  // gesture (iOS autoplay-with-sound and getUserMedia both require it).
  onStart?: () => void;
  // Fires once when the countdown lands on zero. Parent starts the
  // video/scoring clock here so the first move is in sync with audio.
  onGo: () => void;
}

type Phase = 'idle' | 'counting' | 'go' | 'done';

export default function StartOverlay({
  chunkNumber,
  totalChunks,
  chunkLabel,
  subtitle,
  ctaLabel = 'start',
  onStart,
  onGo,
}: StartOverlayProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(3);
  const goFiredRef = useRef(false);

  useEffect(() => {
    if (phase !== 'counting') return;
    if (count <= 0) {
      playTick({ emphasis: true });
      setPhase('go');
      if (!goFiredRef.current) {
        goFiredRef.current = true;
        onGo();
      }
      const dismiss = window.setTimeout(() => setPhase('done'), 600);
      return () => window.clearTimeout(dismiss);
    }
    playTick();
    const t = window.setTimeout(() => setCount((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [phase, count, onGo]);

  if (phase === 'done') return null;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/85 px-8 text-center backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/60">
        section {chunkNumber} of {totalChunks}
      </div>
      <div className="mt-2 max-w-xs text-xl font-semibold leading-tight text-white">
        {chunkLabel}
      </div>
      <div className="mt-2 text-sm text-white/70">{subtitle}</div>

      {phase === 'idle' && (
        <button
          type="button"
          onClick={() => {
            onStart?.();
            setPhase('counting');
          }}
          className="mt-10 rounded-full bg-coral px-12 py-4 text-base font-bold text-white shadow-lg shadow-coral/30 active:scale-95"
        >
          {ctaLabel}
        </button>
      )}

      {phase === 'counting' && (
        <div className="mt-8 text-[160px] font-medium leading-none tabular-nums text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.6)]">
          {count}
        </div>
      )}

      {phase === 'go' && (
        <div className="mt-8 text-[160px] font-medium leading-none tabular-nums text-coral drop-shadow-[0_4px_24px_rgba(0,0,0,0.6)]">
          GO
        </div>
      )}
    </div>
  );
}
