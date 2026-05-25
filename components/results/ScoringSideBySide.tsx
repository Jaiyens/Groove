'use client';

// Synced side-by-side that plays while the test result is uploading
// + scoring. Both videos paused on mount; once both have loaded
// enough data we kick off play() on the same frame so they stay
// aligned. The reference plays with audio so the user hears the song
// while they wait, the attempt is muted (we recorded video-only
// anyway). When the reference ends we loop both from 0.

import { useEffect, useRef, useState } from 'react';

interface Props {
  attemptVideoUrl: string;
  referenceVideoUrl: string;
}

export default function ScoringSideBySide({
  attemptVideoUrl,
  referenceVideoUrl,
}: Props) {
  const attemptRef = useRef<HTMLVideoElement | null>(null);
  const referenceRef = useRef<HTMLVideoElement | null>(null);
  const [needsUnmuteTap, setNeedsUnmuteTap] = useState(false);

  useEffect(() => {
    const a = attemptRef.current;
    const r = referenceRef.current;
    if (!a || !r) return;

    a.muted = true;
    r.muted = false;
    r.volume = 1;

    let cancelled = false;
    let bothReady = false;

    const tryStart = () => {
      if (cancelled || bothReady) return;
      if (a.readyState < 2 || r.readyState < 2) return;
      bothReady = true;
      try { a.currentTime = 0; } catch { /* metadata still settling */ }
      try { r.currentTime = 0; } catch { /* metadata still settling */ }
      // Sequence the plays in the same microtask so they share a
      // start frame.
      void a.play().catch(() => {});
      void r.play().catch((err: unknown) => {
        const name = (err as { name?: string } | null)?.name;
        if (name === 'NotAllowedError') {
          // iOS blocked autoplay-with-sound. Fall back to muted +
          // surface the "tap for sound" affordance.
          r.muted = true;
          setNeedsUnmuteTap(true);
          void r.play().catch(() => {});
        }
      });
    };

    const handleRefEnd = () => {
      // Re-sync: reference is the source of truth for the loop length
      // (it's the dance's actual duration; the attempt may be a hair
      // longer if MediaRecorder kept rolling for a beat).
      try { a.currentTime = 0; } catch { /* ignore */ }
      try { r.currentTime = 0; } catch { /* ignore */ }
      void a.play().catch(() => {});
      void r.play().catch(() => {});
    };

    a.addEventListener('canplay', tryStart);
    r.addEventListener('canplay', tryStart);
    r.addEventListener('ended', handleRefEnd);
    // If both are already buffered, kick immediately.
    tryStart();

    return () => {
      cancelled = true;
      a.removeEventListener('canplay', tryStart);
      r.removeEventListener('canplay', tryStart);
      r.removeEventListener('ended', handleRefEnd);
      a.pause();
      r.pause();
    };
  }, [attemptVideoUrl, referenceVideoUrl]);

  const handleUnmuteTap = () => {
    const r = referenceRef.current;
    if (!r) return;
    r.muted = false;
    setNeedsUnmuteTap(false);
    void r.play().catch(() => {});
  };

  return (
    <div className="relative flex w-full flex-1 items-center justify-center px-2">
      <div className="flex h-full w-full max-h-[70vh] gap-px bg-black">
        {/* YOU panel — 9:16 portrait frame, attempt webcam cropped. */}
        <div className="relative flex h-full w-1/2 items-center justify-center overflow-hidden bg-black">
          <div
            className="relative w-full max-h-full overflow-hidden bg-zinc-950"
            style={{ aspectRatio: '9 / 16' }}
          >
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={attemptRef}
              src={attemptVideoUrl}
              playsInline
              muted
              preload="auto"
              className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-coral ring-1 ring-white/10"
            >
              you
            </span>
          </div>
        </div>
        {/* REF panel — same 9:16 frame, plays the dance's audio so
            the user hears the song while they wait. */}
        <div className="relative flex h-full w-1/2 items-center justify-center overflow-hidden bg-black">
          <div
            className="relative w-full max-h-full overflow-hidden bg-black"
            style={{ aspectRatio: '9 / 16' }}
          >
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={referenceRef}
              src={referenceVideoUrl}
              playsInline
              preload="auto"
              className="absolute inset-0 h-full w-full object-cover"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-white ring-1 ring-white/10"
            >
              ref
            </span>
            {needsUnmuteTap && (
              <button
                type="button"
                onClick={handleUnmuteTap}
                aria-label="tap for sound"
                className="absolute right-2 top-2 flex h-10 items-center gap-1.5 rounded-full bg-coral px-3 text-xs font-semibold text-white shadow-lg active:scale-95"
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 10v4h4l5 5V5L7 10H3z" />
                </svg>
                sound
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
