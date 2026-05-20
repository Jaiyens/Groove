'use client';

import { scoreColor } from '@/lib/scoring/types';

interface LiveScoreProps {
  score: number; // 0..100
  delta?: number | null; // vs last attempt
  label?: string;
}

export default function LiveScore({ score, delta, label = 'sync' }: LiveScoreProps) {
  const display = Math.max(0, Math.min(100, Math.round(score)));
  const { color } = scoreColor(display);

  return (
    <div className="flex items-baseline gap-3">
      <div className="flex flex-col">
        <span className="text-[11px] uppercase tracking-widest text-text-muted">
          {label}
        </span>
        <span
          className={`text-[64px] leading-none font-extrabold tabular-nums ${color}`}
          aria-live="polite"
        >
          {display}
        </span>
      </div>
      {delta !== undefined && delta !== null && (
        <span
          className={`text-sm font-bold tabular-nums ${
            delta >= 0 ? 'text-accent-green' : 'text-accent-red'
          }`}
        >
          {delta >= 0 ? '+' : ''}
          {Math.round(delta)}
        </span>
      )}
    </div>
  );
}
