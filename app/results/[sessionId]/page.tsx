'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ScoreBreakdown, { type SkillScoreRow } from '@/components/ScoreBreakdown';
import TikTokEmbed from '@/components/lesson/TikTokEmbed';
import { useDance } from '@/lib/dances/useDance';
import { useGraph } from '@/lib/graph/context';
import { recommendNextDrill } from '@/lib/graph/recommender';
import { getMasteryStore } from '@/lib/mastery/store';
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

  const { dance, record } = useDance(attempt?.dance_id ?? '');

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

  if (!attempt || !dance || !record) {
    return (
      <main className="theme-cream flex h-full items-center justify-center bg-cream text-ink-muted">
        Loading…
      </main>
    );
  }

  const score = Math.round(attempt.overall_score);
  const tier =
    score >= 80
      ? { ring: 'ring-coral', text: 'text-coral' }
      : score >= 60
        ? { ring: 'ring-slate', text: 'text-slate' }
        : { ring: 'ring-ink-dim', text: 'text-ink-muted' };
  const delta = previousScore !== null ? score - Math.round(previousScore) : null;

  return (
    <main className="theme-cream flex h-full w-full flex-col bg-cream">
      <header className="safe-top flex items-center gap-3 px-5 pt-5 pb-2">
        <Link
          href={`/dance/${dance.id}`}
          aria-label="Back to lesson"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-cream-card text-ink shadow-soft"
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        <div className="flex-1 text-center text-xs font-semibold uppercase tracking-[0.18em] text-coral">
          full attempt
        </div>
        <div className="w-10" aria-hidden />
      </header>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8">
        <header className="mt-1 mb-5">
          <div className="text-xs uppercase tracking-[0.18em] text-ink-muted">
            attempt #{attemptNumber}
          </div>
          <h1 className="mt-1 font-serif text-3xl leading-tight text-ink">
            {dance.name}
          </h1>
          {dance.artist && (
            <p className="text-sm text-ink-muted">
              @{dance.artist.replace(/^@/, '')}
            </p>
          )}
        </header>

        <section className="rounded-[28px] bg-cream-card p-6 shadow-soft">
          <div className="flex items-end gap-4">
            <div className={`font-serif text-[88px] leading-none ${tier.text}`}>
              {score}
            </div>
            <div className="pb-2 text-xs uppercase tracking-[0.2em] text-ink-muted">
              out of 100
            </div>
          </div>
          {delta !== null && (
            <div
              className={`mt-1 text-sm font-semibold ${
                delta >= 0 ? 'text-coral' : 'text-slate'
              }`}
            >
              {delta >= 0 ? '+' : ''}
              {delta} vs last
            </div>
          )}
          <div
            className={`mt-4 inline-flex rounded-full px-3 py-1 text-xs font-semibold tracking-wide ring-1 ${tier.ring} ${tier.text}`}
          >
            {score >= 80 ? 'great work' : score >= 60 ? 'getting there' : 'keep practicing'}
          </div>
        </section>

        <section className="mt-7">
          <h2 className="mb-3 font-serif text-xl text-ink">move breakdown</h2>
          <div className="rounded-2xl bg-cream-card p-4 shadow-soft">
            <ScoreBreakdown rows={skillRows} />
          </div>
        </section>

        {recommendation && (
          <section className="mt-7">
            <h2 className="mb-3 font-serif text-xl text-ink">next up</h2>
            <Link
              href={`/drill/${recommendation.skill.id}?from=${attempt.attempt_id}`}
              className="block rounded-2xl bg-cream-card p-5 shadow-soft active:scale-[0.99] transition-transform"
            >
              <div className="text-[10px] uppercase tracking-[0.18em] text-coral">
                recommended drill
              </div>
              <div className="mt-1 font-serif text-xl text-ink">
                {recommendation.skill.name}
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-ink-muted">
                {recommendation.skill.drill_description}
              </p>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-muted">
                <span>{recommendation.skill.drill_duration_seconds}s</span>
                <span aria-hidden>·</span>
                <span>mastery {Math.round(recommendation.mastery * 100)}%</span>
              </div>
            </Link>
          </section>
        )}

        {record.tiktok_url && (
          <section className="mt-7">
            <h2 className="mb-3 font-serif text-xl text-ink">the original</h2>
            <TikTokEmbed tiktokUrl={record.tiktok_url} />
          </section>
        )}

        <div className="mt-8 flex flex-col gap-2">
          {recommendation ? (
            <Link
              href={`/drill/${recommendation.skill.id}?from=${attempt.attempt_id}`}
              className="block rounded-full bg-coral py-4 text-center text-base font-semibold text-white shadow-lift"
            >
              drill it
            </Link>
          ) : (
            <Link
              href="/"
              className="block rounded-full bg-coral py-4 text-center text-base font-semibold text-white shadow-lift"
            >
              back to library
            </Link>
          )}
          <Link
            href={`/dance/${dance.id}`}
            className="block py-3 text-center text-sm text-ink-muted"
          >
            back to lesson
          </Link>
        </div>
      </div>
    </main>
  );
}
