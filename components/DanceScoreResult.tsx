'use client';

// Renders a DanceScore returned from /api/score. Pure presentation —
// no scoring logic. Shows boosted scores (the function already applies the
// +10/cap-100 boost server-side).

import { useEffect, useRef, useState } from 'react';
import type { DanceScore } from '@/lib/scoring/gemini/score-attempt';

interface Props {
  score: DanceScore;
  onRetry: () => void;
  onExit: () => void;
  // Optional — when present, the result screen shows a side-by-side
  // replay of the student's attempt next to the reference. Lets the
  // user actually SEE what the score is talking about.
  attemptVideoUrl?: string | null;
  referenceVideoUrl?: string | null;
}

export default function DanceScoreResult({
  score,
  onRetry,
  onExit,
  attemptVideoUrl,
  referenceVideoUrl,
}: Props) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const overall = score.scores.overall;
  const tier = tierFor(overall);

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-cream text-ink">
      <header className="safe-top flex items-center justify-between px-5 pt-5 pb-3">
        <button
          type="button"
          onClick={onExit}
          className="text-xs font-medium uppercase tracking-[0.18em] text-ink-muted hover:text-ink"
        >
          ← back
        </button>
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-ink-muted">
          final score
        </div>
        <div className="w-10" aria-hidden />
      </header>

      <div className="flex-1 px-5 pb-8">
        {attemptVideoUrl && referenceVideoUrl && (
          <SideBySideReplay
            attemptVideoUrl={attemptVideoUrl}
            referenceVideoUrl={referenceVideoUrl}
          />
        )}

        <section className="mt-5 rounded-3xl bg-cream-card p-6 shadow-soft">
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            {tier.label}
          </div>
          <div className={`mt-1 text-7xl font-extrabold leading-none tabular-nums ${tier.color}`}>
            {overall}
          </div>
          <p className="mt-3 text-sm leading-snug text-ink-muted">{score.summary}</p>
        </section>

        <section className="mt-5 rounded-3xl bg-cream-card p-5 shadow-soft">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-[0.18em] text-ink-muted">
            breakdown
          </h2>
          <div className="space-y-3">
            <Bar label="timing" value={score.scores.timing} />
            <Bar label="shape" value={score.scores.shape} />
            <Bar label="energy" value={score.scores.energy} />
            <Bar label="flow" value={score.scores.flow} />
          </div>
        </section>

        <section className="mt-5 rounded-3xl bg-cream-card p-5 shadow-soft">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-ink-muted">
            what worked
          </h2>
          <div className="flex items-start gap-3">
            <Pill>{score.did_well.timestamp}</Pill>
            <p className="flex-1 text-sm leading-snug">{score.did_well.note}</p>
          </div>
        </section>

        <section className="mt-5 rounded-3xl bg-cream-card p-5 shadow-soft">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-ink-muted">
            top moments to fix
          </h2>
          <ol className="space-y-4">
            {score.fixes.map((f, i) => (
              <li key={i} className="flex items-start gap-3">
                <Pill>{f.timestamp}</Pill>
                <div className="flex-1">
                  <p className="text-sm font-medium leading-snug">{f.what_happened}</p>
                  <p className="mt-1 text-xs leading-snug text-ink-muted">{f.fix}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <button
          type="button"
          onClick={() => setReasoningOpen((v) => !v)}
          className="mt-5 text-xs font-medium uppercase tracking-[0.18em] text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          {reasoningOpen ? 'hide' : 'show'} ai reasoning
        </button>
        {reasoningOpen && (
          <pre className="mt-3 whitespace-pre-wrap rounded-2xl bg-cream-deep p-4 text-xs leading-relaxed text-ink-muted">
            {score.reasoning}
          </pre>
        )}

        <div className="mt-7 flex flex-col gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full bg-ink py-3 text-sm font-bold uppercase tracking-[0.18em] text-cream-card active:scale-[0.99]"
          >
            try again
          </button>
          <button
            type="button"
            onClick={onExit}
            className="rounded-full bg-cream-card py-3 text-sm font-bold uppercase tracking-[0.18em] text-ink ring-1 ring-cream-deep active:scale-[0.99]"
          >
            back to lesson
          </button>
        </div>
      </div>
    </div>
  );
}

// Synchronized side-by-side replay of the student's attempt next to the
// reference choreography. Matches the test screen's earlier debug-mode
// behavior: both videos play in lockstep, the user can scrub or pause to
// study a moment, audio comes from the reference track so the rhythm
// reads. Camera attempt is mirrored to match the duet view.
function SideBySideReplay({
  attemptVideoUrl,
  referenceVideoUrl,
}: {
  attemptVideoUrl: string;
  referenceVideoUrl: string;
}) {
  const attemptRef = useRef<HTMLVideoElement | null>(null);
  const referenceRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);

  const togglePlay = () => {
    const a = attemptRef.current;
    const r = referenceRef.current;
    if (!a || !r) return;
    if (playing) {
      a.pause();
      r.pause();
    } else {
      // Re-sync from zero on every replay so the comparison stays honest.
      a.currentTime = 0;
      r.currentTime = 0;
      a.muted = true; // attempt has no audio anyway, but be explicit
      r.muted = muted;
      void a.play().catch(() => {});
      void r.play().catch(() => {});
    }
    setPlaying((p) => !p);
  };

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      const r = referenceRef.current;
      if (r) r.muted = next;
      return next;
    });
  };

  // Pause both whenever either one ends so the controls stay in sync.
  useEffect(() => {
    const a = attemptRef.current;
    const r = referenceRef.current;
    if (!a || !r) return;
    const handleEnd = () => {
      a.pause();
      r.pause();
      setPlaying(false);
    };
    a.addEventListener('ended', handleEnd);
    r.addEventListener('ended', handleEnd);
    return () => {
      a.removeEventListener('ended', handleEnd);
      r.removeEventListener('ended', handleEnd);
    };
  }, []);

  return (
    <section className="overflow-hidden rounded-3xl bg-black shadow-soft">
      {/* Matches the live full-dance duet layout: two natural 9:16
          portrait panels side by side, centered, with black space
          wrapping the pair. Aspect 9:8 = two 9:16 portraits glued
          together horizontally. */}
      <div className="flex aspect-[9/8] w-full items-center justify-center bg-black">
        <div className="relative h-full w-1/2 overflow-hidden bg-zinc-950">
          {/* Student attempt — mirrored so the body orientation matches
              what they saw in the live duet view. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={attemptRef}
            src={attemptVideoUrl}
            playsInline
            muted
            preload="metadata"
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
            preload="metadata"
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
      <div className="flex items-center justify-between gap-2 bg-zinc-950 px-3 py-2 text-white">
        <button
          type="button"
          onClick={togglePlay}
          className="flex h-9 items-center gap-2 rounded-full bg-white px-4 text-xs font-bold uppercase tracking-widest text-black active:scale-95"
          aria-label={playing ? 'pause replay' : 'play replay'}
        >
          {playing ? (
            <>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
              pause
            </>
          ) : (
            <>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
              replay
            </>
          )}
        </button>
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? 'unmute reference' : 'mute reference'}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-white/15 active:scale-95"
        >
          {muted ? (
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 5L6 9H3v6h3l5 4V5z" />
              <line x1="22" y1="9" x2="16" y2="15" />
              <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
          ) : (
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 5L6 9H3v6h3l5 4V5z" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
          )}
        </button>
      </div>
    </section>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</span>
        <span className="font-bold tabular-nums text-ink">{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-cream-deep">
        <div
          className="h-full bg-ink transition-[width] duration-500"
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-ink px-2.5 py-1 text-[10px] font-bold tabular-nums text-cream-card">
      {children}
    </span>
  );
}

function tierFor(overall: number): { label: string; color: string } {
  if (overall >= 90) return { label: 'groovy', color: 'text-accent-green' };
  if (overall >= 75) return { label: 'solid', color: 'text-ink' };
  if (overall >= 60) return { label: 'almost', color: 'text-ink' };
  if (overall >= 40) return { label: 'warming up', color: 'text-accent-amber' };
  return { label: 'just started', color: 'text-coral-deep' };
}
