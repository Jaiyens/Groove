'use client';

// Final-test results — rendered as a 5-card carousel instead of a
// single long scroll. Each card has ONE focus: the score, the
// highlight, the miss, the drill recommendation, the next action.
//
// The carousel itself handles swipe / button nav / progress dots.
// This component is the data wiring layer: it pulls the dance from
// the parent, the graph from useGraph(), the previous score from
// the mastery store, and feeds each card the props it needs.

import { useEffect, useMemo, useRef } from 'react';
import type { Dance } from '@/lib/dances/types';
import { useGraph } from '@/lib/graph/context';
import { recommendNextDrill } from '@/lib/graph/recommender';
import { getMasteryStore } from '@/lib/mastery/store';
import type { DanceScore } from '@/lib/scoring/gemini/score-attempt';
import DrillRecommendationCard from './results/DrillRecommendationCard';
import MomentReplayCard from './results/MomentReplayCard';
import ResultsCarousel, { type CarouselCard } from './results/ResultsCarousel';
import ScoreRevealCard from './results/ScoreRevealCard';
import { parseMmSs } from './results/timestamp';
import WhatsNextCard from './results/WhatsNextCard';

interface Props {
  score: DanceScore;
  onRetry: () => void;
  onExit: () => void;
  attemptVideoUrl?: string | null;
  referenceVideoUrl?: string | null;
  dance?: Dance | null;
}

export default function DanceScoreResult({
  score,
  onRetry,
  onExit,
  attemptVideoUrl,
  referenceVideoUrl,
  dance,
}: Props) {
  const { graph, mastery, bumpMastery } = useGraph();

  // Look up the previous attempt's score (so card 1 can show "+12
  // vs last attempt"). Run once on mount — the new attempt gets
  // persisted below, so reading after persist would always pull the
  // attempt we just saved.
  const previousScoreRef = useRef<number | null>(null);
  if (previousScoreRef.current === null && dance) {
    try {
      const prev = getMasteryStore().getLatestAttempt(dance.id);
      previousScoreRef.current = prev ? prev.overall_score : null;
    } catch {
      previousScoreRef.current = null;
    }
  }
  const previousScore = previousScoreRef.current;

  // Persist this attempt to the mastery store (once). The dance's
  // required_skills get the boosted overall score. The recommender
  // and "vs last attempt" delta read from the store on the next
  // mount.
  const persistedRef = useRef(false);
  useEffect(() => {
    if (!dance || persistedRef.current) return;
    persistedRef.current = true;
    try {
      const skillScores: Record<string, number> = {};
      for (const skillId of dance.required_skills) {
        skillScores[skillId] = score.scores.overall;
      }
      getMasteryStore().recordAttempt(dance.id, skillScores, score.scores.overall);
      bumpMastery();
    } catch {
      /* private browsing or storage disabled — fine */
    }
  }, [dance, score.scores.overall, bumpMastery]);

  // The weakest skill, used by the WhatsNextCard's secondary CTA.
  const weakestSkill = useMemo(() => {
    if (!dance || !graph) return null;
    const rec = recommendNextDrill({ dance, graph, mastery });
    return rec?.skill ?? null;
  }, [dance, graph, mastery]);

  const cards = useMemo<CarouselCard[]>(() => {
    const list: CarouselCard[] = [];
    list.push({
      key: 'reveal',
      content: (
        <ScoreRevealCard
          overall={score.scores.overall}
          summary={score.summary}
          previousScore={previousScore}
        />
      ),
    });

    if (score.did_well && score.did_well.note) {
      list.push({
        key: 'nailed',
        content: (
          <MomentReplayCard
            tone="nailed"
            timestamp={score.did_well.timestamp}
            startSec={parseMmSs(score.did_well.timestamp)}
            headline={score.did_well.note}
            attemptVideoUrl={attemptVideoUrl ?? null}
            referenceVideoUrl={referenceVideoUrl ?? null}
          />
        ),
      });
    }

    const topFix = score.fixes[0];
    if (topFix) {
      list.push({
        key: 'miss',
        content: (
          <MomentReplayCard
            tone="miss"
            timestamp={topFix.timestamp}
            startSec={parseMmSs(topFix.timestamp)}
            headline={topFix.what_happened}
            body={topFix.fix}
            attemptVideoUrl={attemptVideoUrl ?? null}
            referenceVideoUrl={referenceVideoUrl ?? null}
          />
        ),
      });
    }

    if (dance) {
      list.push({
        key: 'drill',
        content: <DrillRecommendationCard dance={dance} />,
      });
    }

    if (dance) {
      list.push({
        key: 'next',
        content: (
          <WhatsNextCard
            danceId={dance.id}
            danceName={dance.name}
            weakestSkill={weakestSkill}
            onRetry={onRetry}
          />
        ),
        // Final card: omit the default "continue" CTA — the card
        // itself renders its action stack.
        actions: <div className="h-0" aria-hidden />,
      });
    } else {
      list.push({
        key: 'next-bare',
        content: (
          <section className="flex h-full flex-col items-center justify-center text-center">
            <h2 className="text-xl font-semibold text-ink">
              What&apos;s next?
            </h2>
            <p className="mt-3 max-w-sm text-sm text-ink-muted">
              Run it again to push your score up, or head back to the lesson.
            </p>
          </section>
        ),
        actions: (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-full bg-ink px-5 py-4 text-sm font-bold uppercase tracking-[0.18em] text-cream-card active:scale-[0.99]"
            >
              try again
            </button>
            <button
              type="button"
              onClick={onExit}
              className="rounded-full bg-cream-card px-5 py-4 text-sm font-bold uppercase tracking-[0.18em] text-ink ring-1 ring-cream-deep active:scale-[0.99]"
            >
              back to lesson
            </button>
          </div>
        ),
      });
    }

    return list;
  }, [
    score,
    previousScore,
    attemptVideoUrl,
    referenceVideoUrl,
    dance,
    weakestSkill,
    onRetry,
    onExit,
  ]);

  return <ResultsCarousel cards={cards} onExit={onExit} />;
}
