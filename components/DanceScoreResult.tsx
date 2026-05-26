'use client';

// Final-test results — rendered as a 5-card carousel instead of a
// single long scroll. Each card has ONE focus: the score, the
// highlight, the miss, the drill recommendation, the next action.
//
// The carousel itself handles swipe / button nav / progress dots.
// This component is the data wiring layer: it pulls the dance from
// the parent, the graph + projection + recommendation from
// useRecordDanceAttempt (which also persists the attempt to mastery
// once per mount), and feeds each card the props it needs.

import { useMemo } from 'react';
import type { Dance } from '@/lib/dances/types';
import { useRecordDanceAttempt } from '@/lib/mastery/useRecordDanceAttempt';
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
  const outcome = useRecordDanceAttempt(dance, score);
  const { recommendation, previousScore, tierCrossing } = outcome;
  const weakest = recommendation.weakestSkill;

  const cards = useMemo<CarouselCard[]>(() => {
    const list: CarouselCard[] = [];
    list.push({
      key: 'reveal',
      content: (
        <ScoreRevealCard
          overall={score.scores.overall}
          summary={recommendation.headline || score.summary}
          previousScore={previousScore}
          skillRows={recommendation.skillRows}
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
        content: <DrillRecommendationCard dance={dance} weakest={weakest} />,
      });
    }

    if (dance) {
      list.push({
        key: 'next',
        content: (
          <WhatsNextCard
            danceId={dance.id}
            danceName={dance.name}
            weakestSkill={weakest?.skill ?? null}
            tierCrossing={tierCrossing}
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
    weakest,
    recommendation,
    tierCrossing,
    onRetry,
    onExit,
  ]);

  return <ResultsCarousel cards={cards} onExit={onExit} />;
}
