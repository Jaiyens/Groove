'use client';

// Cards 2 + 3 of the results carousel — "what you nailed" and
// "biggest miss". Both render identically: a looped 3-second mini
// side-by-side at the moment's timestamp, plus the explanation copy.
//
// Loop mechanics: both <video> elements are paused on mount, scrubbed
// to the moment's startTime, then auto-played + looped via a
// timeupdate listener that snaps back to startTime when either video
// crosses endTime. Both videos are muted (audio would clash + iOS
// can't autoplay sound without a gesture inside the carousel).

import { useEffect, useRef } from 'react';

const LOOP_DURATION_SEC = 3;

interface Props {
  // 'nailed' renders a green accent and "what you nailed" copy;
  // 'miss' renders a coral accent and "biggest miss" copy.
  tone: 'nailed' | 'miss';
  // The Gemini fix/did-well moment.
  timestamp: string; // "MM:SS"
  startSec: number; // parseMmSs(timestamp)
  // Top headline of the card (e.g. score.did_well.note or
  // score.fixes[0].what_happened).
  headline: string;
  // Optional secondary line shown under the headline. For "biggest
  // miss" this is the suggested fix.
  body?: string;
  attemptVideoUrl: string | null;
  referenceVideoUrl: string | null;
}

export default function MomentReplayCard({
  tone,
  timestamp,
  startSec,
  headline,
  body,
  attemptVideoUrl,
  referenceVideoUrl,
}: Props) {
  const attemptRef = useRef<HTMLVideoElement | null>(null);
  const referenceRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const a = attemptRef.current;
    const r = referenceRef.current;
    if (!a || !r) return;

    // If the timestamp is past the video end (rare, but happens when
    // Gemini estimates a timestamp slightly off), clamp to a 3-second
    // window ending at the video's actual end.
    const videoDuration = Number.isFinite(a.duration) ? a.duration : 0;
    const safeStart =
      videoDuration > 0 && startSec > Math.max(0, videoDuration - LOOP_DURATION_SEC)
        ? Math.max(0, videoDuration - LOOP_DURATION_SEC)
        : Math.max(0, startSec);
    const start = safeStart;
    const end = start + LOOP_DURATION_SEC;

    const seekPair = () => {
      try { a.currentTime = start; } catch { /* metadata not ready */ }
      try { r.currentTime = start; } catch { /* metadata not ready */ }
    };
    const playPair = () => {
      void a.play().catch(() => {});
      void r.play().catch(() => {});
    };
    const handleTime = (el: HTMLVideoElement) => () => {
      if (el.currentTime >= end || el.currentTime < start - 0.05) {
        seekPair();
      }
    };
    const aTick = handleTime(a);
    const rTick = handleTime(r);

    const handleMeta = () => {
      seekPair();
      playPair();
    };

    a.muted = true;
    r.muted = true;
    a.addEventListener('timeupdate', aTick);
    r.addEventListener('timeupdate', rTick);
    a.addEventListener('loadedmetadata', handleMeta);
    r.addEventListener('loadedmetadata', handleMeta);

    // Kick a play if metadata is already loaded by the time we attach.
    if (a.readyState >= 1 && r.readyState >= 1) handleMeta();

    return () => {
      a.removeEventListener('timeupdate', aTick);
      r.removeEventListener('timeupdate', rTick);
      a.removeEventListener('loadedmetadata', handleMeta);
      r.removeEventListener('loadedmetadata', handleMeta);
      a.pause();
      r.pause();
    };
  }, [startSec, attemptVideoUrl, referenceVideoUrl]);

  const tonePill =
    tone === 'nailed'
      ? 'bg-accent-green/15 text-accent-green'
      : 'bg-coral/15 text-coral-deep';
  const toneTitle = tone === 'nailed' ? 'you nailed it' : 'biggest miss';

  return (
    <section className="flex h-full flex-col">
      <div
        className={`inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${tonePill}`}
      >
        <span aria-hidden>{tone === 'nailed' ? '✓' : '!'}</span>
        {toneTitle}
        <span className="font-mono tabular-nums opacity-80">· {timestamp}</span>
      </div>

      <div className="mt-3 overflow-hidden rounded-3xl bg-black shadow-soft">
        {attemptVideoUrl && referenceVideoUrl ? (
          <div className="flex aspect-[9/8] w-full bg-black">
            <div className="relative h-full w-1/2 overflow-hidden bg-zinc-950">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={attemptRef}
                src={attemptVideoUrl}
                playsInline
                muted
                preload="auto"
                className="absolute inset-0 h-full w-full object-contain [transform:scaleX(-1)]"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[9px] font-medium uppercase tracking-widest text-coral ring-1 ring-white/10"
              >
                you
              </span>
            </div>
            <div className="relative h-full w-1/2 overflow-hidden bg-black">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={referenceRef}
                src={referenceVideoUrl}
                playsInline
                muted
                preload="auto"
                className="absolute inset-0 h-full w-full object-contain"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[9px] font-medium uppercase tracking-widest text-white ring-1 ring-white/10"
              >
                ref
              </span>
            </div>
          </div>
        ) : (
          <div className="flex aspect-[9/8] w-full items-center justify-center bg-zinc-950 text-xs text-white/55">
            replay unavailable
          </div>
        )}
        <div className="bg-zinc-950 px-3 py-1.5 text-center text-[10px] uppercase tracking-[0.18em] text-white/65">
          looping {LOOP_DURATION_SEC}s at {timestamp}
        </div>
      </div>

      <div className="mt-5 px-1">
        <h2 className="text-xl font-semibold leading-tight text-ink">{headline}</h2>
        {body && (
          <p className="mt-3 text-sm leading-snug text-ink-muted">{body}</p>
        )}
      </div>
    </section>
  );
}
