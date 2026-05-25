'use client';

// Card 4 of the results carousel — the teaching surface.
//
// Picks the dance's weakest skill (by gap = weight × (1 - mastery))
// via the existing recommender, then shows that skill's name +
// definition + a single drill CTA that opens
// /drill/<skillId>?from=dance:<id>. When the dance has no skill
// mapping (no required_skills on the row + no routine node match)
// we fall back to a "general practice" message so the card always
// has something useful to say.

import Link from 'next/link';
import type { Dance } from '@/lib/dances/types';
import { useGraph } from '@/lib/graph/context';
import { recommendNextDrill, type Recommendation } from '@/lib/graph/recommender';
import { useMemo } from 'react';

interface Props {
  dance: Dance;
}

export default function DrillRecommendationCard({ dance }: Props) {
  const { graph, mastery } = useGraph();

  const recommendation = useMemo<Recommendation | undefined>(() => {
    if (!graph || !dance) return undefined;
    return recommendNextDrill({ dance, graph, mastery });
  }, [graph, dance, mastery]);

  if (!recommendation) {
    return (
      <section className="flex h-full flex-col">
        <div className="inline-flex w-fit items-center gap-1.5 rounded-full bg-ink/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-ink-muted">
          drill next
        </div>
        <div className="mt-5 rounded-3xl bg-cream-card p-6 shadow-soft">
          <h2 className="text-xl font-semibold leading-tight text-ink">
            Run it back
          </h2>
          <p className="mt-3 text-sm leading-snug text-ink-muted">
            We don&apos;t have a skill-by-skill map for this dance yet, so the
            best next step is another full attempt. Aim for the moments you
            saw on the previous cards.
          </p>
        </div>
      </section>
    );
  }

  const { skill, mastery: skillMastery } = recommendation;
  const drillSeconds = skill.drill_duration_seconds || 60;
  const masteryPct = Math.round(skillMastery * 100);

  return (
    <section className="flex h-full flex-col">
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full bg-coral/15 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-coral-deep">
        drill this next
      </div>
      <div className="mt-3 overflow-hidden rounded-3xl bg-ink text-cream-card shadow-lift">
        <div className="px-5 pt-5 pb-4">
          <h2 className="text-2xl font-semibold leading-tight">
            {skill.name}
          </h2>
          <p className="mt-3 text-sm leading-snug text-cream-card/85">
            {firstSentence(skill.description)}
          </p>
          {skill.common_mistakes.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-cream-card/60">
                watch for
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-snug text-cream-card/85">
                {skill.common_mistakes.slice(0, 2).map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="border-t border-cream-card/15 px-5 py-3 text-[11px] uppercase tracking-[0.18em] text-cream-card/70">
          <span>{drillSeconds}s drill</span>
          <span aria-hidden> · </span>
          <span>mastery {masteryPct}%</span>
        </div>
      </div>
      <Link
        href={`/drill/${skill.id}?from=dance:${dance.id}`}
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-coral px-5 py-4 text-sm font-bold uppercase tracking-[0.14em] text-white shadow-lg shadow-coral/30 active:scale-[0.98]"
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M8 5v14l11-7z" />
        </svg>
        drill it · {drillSeconds}s
      </Link>
    </section>
  );
}

function firstSentence(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  const m = trimmed.match(/[^.!?]+[.!?]/);
  if (m) return m[0].trim();
  return trimmed;
}
