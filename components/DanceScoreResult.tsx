'use client';

// Renders a DanceScore returned from /api/score. Pure presentation —
// no scoring logic. Shows boosted scores (the function already applies the
// +10/cap-100 boost server-side).

import { useState } from 'react';
import type { DanceScore } from '@/lib/scoring/gemini/score-attempt';

interface Props {
  score: DanceScore;
  onRetry: () => void;
  onExit: () => void;
}

export default function DanceScoreResult({ score, onRetry, onExit }: Props) {
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
        <section className="rounded-3xl bg-cream-card p-6 shadow-soft">
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
