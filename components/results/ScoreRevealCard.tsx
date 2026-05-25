'use client';

// Card 1 of the results carousel — the celebratory reveal.
//
//   - Big number counts up from 0 to the final score over ~1.4s.
//   - Tier label + one-line vibe blurb.
//   - Delta vs the previous attempt (when one exists).
//   - Confetti burst on 80+ scores so high-end attempts feel earned.
//
// Pure presentation; no fetch, no graph. The parent passes the
// summary string (Gemini's one-liner or the recommender's graph-
// aware headline).

import { useEffect, useState } from 'react';
import { tierLabelFor } from './tier';

interface Props {
  overall: number;
  summary: string;
  // Optional — when present, render +N / -N below the score.
  previousScore?: number | null;
}

const COUNT_DURATION_MS = 1400;

export default function ScoreRevealCard({ overall, summary, previousScore }: Props) {
  const target = Math.max(0, Math.min(100, Math.round(overall)));
  const [displayed, setDisplayed] = useState(0);

  useEffect(() => {
    setDisplayed(0);
    const start = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / COUNT_DURATION_MS);
      // Ease-out cubic so the number arrives gently.
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayed(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const tier = tierLabelFor(target);
  const tierColor = tierColorFor(target);
  const delta =
    typeof previousScore === 'number' && Number.isFinite(previousScore)
      ? target - Math.round(previousScore)
      : null;
  const showConfetti = target >= 80;

  return (
    <section className="relative flex h-full flex-col items-center justify-center text-center">
      {showConfetti && <Confetti />}

      <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-ink-muted">
        final score
      </div>
      <div
        className={`mt-4 font-extrabold leading-none tabular-nums ${tierColor}`}
        style={{ fontSize: 'clamp(120px, 38vw, 200px)' }}
        aria-label={`Final score ${target} out of 100`}
      >
        {displayed}
      </div>
      <div className="mt-3 whitespace-nowrap text-xl font-bold uppercase tracking-[0.16em] text-ink">
        {tier}
      </div>
      {delta !== null && (
        <div
          className={`mt-3 text-sm font-semibold ${
            delta > 0 ? 'text-accent-green' : delta < 0 ? 'text-coral-deep' : 'text-ink-muted'
          }`}
        >
          {delta > 0 ? `+${delta}` : delta} vs last attempt
        </div>
      )}
      <p className="mt-6 max-w-sm text-sm leading-snug text-ink">{summary}</p>
    </section>
  );
}

function tierColorFor(score: number): string {
  if (score >= 90) return 'text-accent-green';
  if (score >= 75) return 'text-ink';
  if (score >= 60) return 'text-ink';
  if (score >= 40) return 'text-accent-amber';
  return 'text-coral-deep';
}

// Cheap CSS confetti — 18 absolutely-positioned squares each given a
// random start offset, color, and 1.6s fall+spin animation. No
// dependency. The keyframes live in app/globals.css under
// .confetti-piece (added in the same commit).
function Confetti() {
  const pieces = Array.from({ length: 18 });
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {pieces.map((_, i) => {
        const left = (i * 53) % 100;
        const delay = (i % 6) * 0.08;
        const duration = 1.4 + ((i * 7) % 10) * 0.06;
        const colors = ['#FF6B6B', '#FFC857', '#5EE1A3', '#7BB5FF', '#F4ABCC'];
        const color = colors[i % colors.length];
        const rotate = (i * 47) % 360;
        return (
          <span
            key={i}
            className="confetti-piece"
            style={{
              left: `${left}%`,
              backgroundColor: color,
              animationDelay: `${delay}s`,
              animationDuration: `${duration}s`,
              transform: `rotate(${rotate}deg)`,
            }}
          />
        );
      })}
    </div>
  );
}
