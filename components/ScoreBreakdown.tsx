'use client';

// Per-skill score list shown on the results screen. Pink is reserved for
// brand, navigation, and progress accents; score hierarchy stays neutral.

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
        const scoreColor = 'text-ink';
        const barColor = 'bg-ink';
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
