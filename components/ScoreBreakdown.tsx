'use client';

import { scoreBarColor, scoreColor } from '@/lib/scoring/types';

export interface SkillScoreRow {
  skill_id: string;
  skill_name: string;
  score: number; // 0..100
}

interface ScoreBreakdownProps {
  rows: SkillScoreRow[];
}

export default function ScoreBreakdown({ rows }: ScoreBreakdownProps) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const score = Math.round(row.score);
        const bar = scoreBarColor(score);
        const { color } = scoreColor(score);
        return (
          <div key={row.skill_id} className="rounded-2xl bg-bg-card p-3.5 ring-1 ring-white/5">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-semibold capitalize">{row.skill_name}</span>
              <span className={`text-base font-bold tabular-nums ${color}`}>{score}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className={`h-full rounded-full ${bar}`}
                style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
