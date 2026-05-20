'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ScoreBreakdown, { type SkillScoreRow } from '@/components/ScoreBreakdown';
import { getDance } from '@/lib/dances/fixtures';
import type { Dance } from '@/lib/dances/types';
import { useGraph } from '@/lib/graph/context';
import { recommendNextDrill } from '@/lib/graph/recommender';
import { getMasteryStore } from '@/lib/mastery/store';
import { scoreColor } from '@/lib/scoring/types';
import type { AttemptRecord } from '@/lib/mastery/types';

interface PageProps {
  params: { sessionId: string };
}

export default function ResultsPage({ params }: PageProps) {
  const router = useRouter();
  const { graph, mastery } = useGraph();
  const [attempt, setAttempt] = useState<AttemptRecord | null>(null);
  const [previousScore, setPreviousScore] = useState<number | null>(null);
  const [attemptNumber, setAttemptNumber] = useState(1);

  useEffect(() => {
    const store = getMasteryStore();
    const a = store.getAttemptById(params.sessionId);
    if (!a) {
      router.replace('/');
      return;
    }
    setAttempt(a);
    const danceAttempts = store.getAttempts(a.dance_id);
    setAttemptNumber(danceAttempts.length);
    const prior = danceAttempts.filter((x) => x.timestamp_ms < a.timestamp_ms);
    const last = prior[prior.length - 1];
    setPreviousScore(last?.overall_score ?? null);
  }, [params.sessionId, router]);

  const dance: Dance | undefined =
    attempt && graph ? getDance(attempt.dance_id, graph) : undefined;

  const recommendation = useMemo(() => {
    if (!dance || !graph) return null;
    return recommendNextDrill({ dance, graph, mastery }) ?? null;
  }, [dance, graph, mastery]);

  const skillRows: SkillScoreRow[] = useMemo(() => {
    if (!attempt || !graph) return [];
    return Object.entries(attempt.per_skill_scores).map(([skill_id, score]) => ({
      skill_id,
      skill_name: graph.nodes.find((n) => n.id === skill_id)?.name ?? skill_id,
      score,
    }));
  }, [attempt, graph]);

  if (!attempt || !dance) {
    return (
      <main className="flex h-full items-center justify-center text-text-muted">
        Loading…
      </main>
    );
  }

  const score = Math.round(attempt.overall_score);
  const { color } = scoreColor(score);
  const delta = previousScore !== null ? score - Math.round(previousScore) : null;

  return (
    <main className="flex h-full w-full flex-col bg-black">
      <div className="flex-1 overflow-y-auto no-scrollbar safe-top px-5 pt-5 pb-6">
        <header className="mb-4">
          <Link href="/" className="text-xs uppercase tracking-widest text-text-muted">
            ← Home
          </Link>
          <div className="mt-3 text-xs uppercase tracking-widest text-text-muted">Run complete</div>
          <h1 className="text-2xl font-bold leading-tight">{dance.name}</h1>
          <div className="text-sm text-text-muted">
            {dance.artist} · attempt #{attemptNumber}
          </div>
        </header>

        <section className="flex items-end gap-4 mb-6">
          <div className={`text-[88px] leading-none font-extrabold tabular-nums ${color}`}>
            {score}
          </div>
          <div className="pb-2">
            <div className="text-xs uppercase tracking-widest text-text-muted">out of 100</div>
            {delta !== null && (
              <div
                className={`mt-1 text-sm font-bold tabular-nums ${
                  delta >= 0 ? 'text-accent-green' : 'text-accent-red'
                }`}
              >
                {delta >= 0 ? '+' : ''}
                {delta} vs last
              </div>
            )}
          </div>
        </section>

        <section className="mb-6">
          <h2 className="mb-3 text-base font-bold">Move breakdown</h2>
          <ScoreBreakdown rows={skillRows} />
        </section>

        {recommendation && (
          <section className="mb-6">
            <h2 className="mb-2 text-base font-bold">Next up</h2>
            <div className="rounded-2xl bg-gradient-to-br from-accent/25 to-accent-cyan/15 p-4 ring-1 ring-white/10">
              <div className="text-[10px] uppercase tracking-widest text-text-muted">
                Recommended drill
              </div>
              <div className="text-lg font-bold mt-0.5">{recommendation.skill.name}</div>
              <div className="text-sm text-text-muted mt-1 line-clamp-2">
                {recommendation.skill.drill_description}
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-text-muted">
                <span>{recommendation.skill.drill_duration_seconds}s</span>
                <span>·</span>
                <span>mastery {Math.round(recommendation.mastery * 100)}%</span>
              </div>
            </div>
          </section>
        )}
      </div>

      <div className="safe-bottom px-5 pb-5 pt-2 bg-black">
        {recommendation ? (
          <Link
            href={`/drill/${recommendation.skill.id}?from=${attempt.attempt_id}`}
            className="block w-full rounded-full bg-white py-4 text-center text-base font-bold text-black active:scale-[0.98] transition-transform"
          >
            Drill it
          </Link>
        ) : (
          <Link
            href="/"
            className="block w-full rounded-full bg-bg-card py-4 text-center text-base font-bold text-white ring-1 ring-white/10"
          >
            Back home
          </Link>
        )}
        <Link
          href={`/dance/${dance.id}`}
          className="mt-2 block w-full text-center text-sm text-text-muted py-2"
        >
          Back to lesson
        </Link>
      </div>
    </main>
  );
}
