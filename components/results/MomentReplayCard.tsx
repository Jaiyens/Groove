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
//
// Diagnostics: when a video element errors or stalls, we surface the
// reason in the corner of the panel and console.warn it. Silent black
// panels in this card hide CORS / CDN / format failures — making
// regressions invisible until a user reports it.

import { useEffect, useRef, useState } from 'react';

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
  // Per-panel diagnostic. Populated on error/stall; cleared on
  // first successful play. Surfaced as a small chip so a black panel
  // never lies about its state.
  const [attemptErr, setAttemptErr] = useState<string | null>(null);
  const [referenceErr, setReferenceErr] = useState<string | null>(null);
  const [attemptReady, setAttemptReady] = useState(false);
  const [referenceReady, setReferenceReady] = useState(false);

  useEffect(() => {
    const a = attemptRef.current;
    const r = referenceRef.current;
    if (!a || !r) return;

    const describeError = (el: HTMLVideoElement, name: string): string => {
      const err = el.error;
      if (!err) return `${name}: unknown error`;
      const codes: Record<number, string> = {
        1: 'aborted',
        2: 'network',
        3: 'decode',
        4: 'src-not-supported',
      };
      const code = codes[err.code] ?? `code ${err.code}`;
      return `${name} ${code}${err.message ? ` (${err.message})` : ''}`;
    };
    const onAttemptError = () => {
      const msg = describeError(a, 'attempt');
      console.warn('[MomentReplayCard]', msg, { url: attemptVideoUrl });
      setAttemptErr(msg);
    };
    const onReferenceError = () => {
      const msg = describeError(r, 'reference');
      console.warn('[MomentReplayCard]', msg, { url: referenceVideoUrl });
      setReferenceErr(msg);
    };
    const onAttemptPlay = () => setAttemptReady(true);
    const onReferencePlay = () => setReferenceReady(true);

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
    a.addEventListener('error', onAttemptError);
    r.addEventListener('error', onReferenceError);
    a.addEventListener('playing', onAttemptPlay);
    r.addEventListener('playing', onReferencePlay);

    // Kick a play if metadata is already loaded by the time we attach.
    if (a.readyState >= 1 && r.readyState >= 1) handleMeta();

    // Fallback: if loadedmetadata never fires (slow CDN / stalled
    // network / silent decode failure), force a play attempt at 2s.
    // play() is safe to call before metadata — the browser will queue
    // the play until data arrives. Without this fallback the panel
    // stays black indefinitely if the metadata event is lost.
    const kickTimer = window.setTimeout(() => {
      playPair();
    }, 2000);

    return () => {
      window.clearTimeout(kickTimer);
      a.removeEventListener('timeupdate', aTick);
      r.removeEventListener('timeupdate', rTick);
      a.removeEventListener('loadedmetadata', handleMeta);
      r.removeEventListener('loadedmetadata', handleMeta);
      a.removeEventListener('error', onAttemptError);
      r.removeEventListener('error', onReferenceError);
      a.removeEventListener('playing', onAttemptPlay);
      r.removeEventListener('playing', onReferencePlay);
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
          // Combined 9:8 wrapper = two 9:16 portrait frames side by
          // side. Each frame uses object-cover so the webcam attempt
          // gets a portrait crop and the reference fills naturally.
          <div className="flex aspect-[9/8] w-full bg-black">
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
                  className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[9px] font-medium uppercase tracking-widest text-coral ring-1 ring-white/10"
                >
                  you
                </span>
                <PanelStatus error={attemptErr} ready={attemptReady} />
              </div>
            </div>
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
                  muted
                  preload="auto"
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[9px] font-medium uppercase tracking-widest text-white ring-1 ring-white/10"
                >
                  ref
                </span>
                <PanelStatus error={referenceErr} ready={referenceReady} />
              </div>
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

// Small chip in the bottom-right of each panel. Renders only when
// something noteworthy happened — an error, or the slow path where the
// video hasn't started yet. Avoids a silent black panel masking a real
// failure (CORS, decode error, src-not-supported, etc).
function PanelStatus({ error, ready }: { error: string | null; ready: boolean }) {
  if (error) {
    return (
      <span
        className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-md bg-coral/85 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white"
        title={error}
      >
        {error}
      </span>
    );
  }
  if (!ready) {
    return (
      <span
        className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white/75"
      >
        loading…
      </span>
    );
  }
  return null;
}
