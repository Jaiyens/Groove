'use client';

// Per-skill score list shown on the results screen. Per SPECK §Phase 2 the
// only place hot pink is allowed in this list is the TOP score (the highest
// single skill score). Everything else uses near-black text + cream surface.

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
  // Top score gets hot pink. If multiple skills share the max, only the
  // first wins so we don't repeat the accent.
  const maxScore = rows.reduce((m, r) => Math.max(m, r.score), -Infinity);
  let topAccented = false;
  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const score = Math.round(row.score);
        const isTop = !topAccented && row.score === maxScore;
        if (isTop) topAccented = true;
        const scoreColor = isTop ? 'text-coral' : 'text-ink';
        const barColor = isTop ? 'bg-coral' : 'bg-ink';
        return (
          <div
            key={row.skill_id}
            className="rounded-2xl bg-cream-card p-3.5 ring-1 ring-cream-deep"
          >
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-medium capitalize text-ink">
                {row.skill_name}
              </span>
              <span className={`text-base font-medium tabular-nums ${scoreColor}`}>
                {score}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-cream-deep">
              <div
                className={`h-full rounded-full ${barColor}`}
                style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
