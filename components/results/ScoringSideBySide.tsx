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
    // Both start paused. Don't autoplay — we want to control the
    // exact moment each starts so they share a start frame.
    a.pause();
    r.pause();

    let cancelled = false;
    let started = false;
    let driftInterval: number | null = null;

    const start = async () => {
      if (cancelled || started) return;
      // Require `canplaythrough` (readyState >= 4) on BOTH — the
      // browser is saying "I have enough buffered to play to the end
      // without stalling." Using `canplay` (readyState 3) used to let
      // the attempt blob start before the network-fetched reference
      // had buffered, hence the visible offset the user reported.
      if (a.readyState < 4 || r.readyState < 4) return;
      started = true;
      try { a.currentTime = 0; } catch { /* ignore */ }
      try { r.currentTime = 0; } catch { /* ignore */ }
      // 200ms breath after both report ready, so any in-flight decode
      // pipeline work settles before we kick play.
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      if (cancelled) return;
      try {
        await Promise.all([
          a.play().catch(() => {}),
          r.play().catch((err: unknown) => {
            const name = (err as { name?: string } | null)?.name;
            if (name === 'NotAllowedError') {
              r.muted = true;
              setNeedsUnmuteTap(true);
              return r.play().catch(() => {});
            }
          }),
        ]);
      } catch {
        /* one of the play promises rejected — best-effort */
      }
      // Drift correction. Re-check every second; if the two videos
      // have walked more than 150ms apart, snap the leader back to
      // the lagger so they re-converge. Cheap, no audio glitch
      // because we only seek when actually off.
      driftInterval = window.setInterval(() => {
        if (cancelled) return;
        const delta = a.currentTime - r.currentTime;
        if (Math.abs(delta) > 0.15) {
          if (delta > 0) {
            try { a.currentTime = r.currentTime; } catch { /* ignore */ }
          } else {
            try { r.currentTime = a.currentTime; } catch { /* ignore */ }
          }
        }
      }, 1000);
    };

    const handleRefEnd = () => {
      try { a.currentTime = 0; } catch { /* ignore */ }
      try { r.currentTime = 0; } catch { /* ignore */ }
      void a.play().catch(() => {});
      void r.play().catch(() => {});
    };

    a.addEventListener('canplaythrough', start);
    r.addEventListener('canplaythrough', start);
    r.addEventListener('ended', handleRefEnd);
    // Kick immediately in case both are already buffered enough.
    void start();

    return () => {
      cancelled = true;
      if (driftInterval !== null) window.clearInterval(driftInterval);
      a.removeEventListener('canplaythrough', start);
      r.removeEventListener('canplaythrough', start);
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
