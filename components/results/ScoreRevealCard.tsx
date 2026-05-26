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
import { applyDisplayBoost } from '@/lib/scoring/displayBoost';
import type { SkillRow } from '@/lib/graph/teachingRecommender';
import { tierBarFor, tierLabelFor } from './tier';

interface Props {
  overall: number;
  summary: string;
  // Optional — when present, render +N / -N below the score.
  previousScore?: number | null;
  // Top-N skill rows (by weight) for a compact "what landed / what
  // needs work" strip below the overall. Empty/undefined hides the
  // strip entirely (legacy dances without a skill map).
  skillRows?: SkillRow[];
}

const COUNT_DURATION_MS = 1400;

export default function ScoreRevealCard({ overall, summary, previousScore, skillRows }: Props) {
  // Display-only boost: raw scores >65 get +10. Mastery and the
  // per-skill projection see the unboosted number; only this card and
  // the delta line use the boosted value.
  const target = Math.max(0, Math.round(applyDisplayBoost(overall)));
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
      ? target - Math.round(applyDisplayBoost(previousScore))
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

      {skillRows && skillRows.length > 0 && <SkillBreakdownStrip rows={skillRows} />}
    </section>
  );
}

// Compact three-row strip showing this attempt's projected per-skill
// scores for the top-weighted skills. Reads as "what landed / what
// needs work" — not a separate card, just an at-a-glance signal sitting
// under the overall.
function SkillBreakdownStrip({ rows }: { rows: SkillRow[] }) {
  const top = rows.slice(0, 3);
  return (
    <div className="mt-6 w-full max-w-sm space-y-2">
      {top.map((row) => {
        const pct = Math.max(0, Math.min(100, Math.round(row.score)));
        return (
          <div key={row.skill.id} className="flex items-center gap-3 text-left">
            <div className="flex-1 truncate text-xs text-ink-muted">
              {row.skill.name.toLowerCase()}
            </div>
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink/10">
              <div
                className={`h-full ${tierBarFor(pct)}`}
                style={{ width: `${pct}%` }}
                aria-hidden
              />
            </div>
            <div className="w-8 text-right text-[11px] font-semibold tabular-nums text-ink">
              {pct}
            </div>
          </div>
        );
      })}
    </div>
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
