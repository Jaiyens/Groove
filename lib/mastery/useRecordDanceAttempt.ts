'use client';

// One-stop hook for the results screen.
//
// Given the freshly-scored dance + the AI score, this hook:
//   1. Looks up the previous attempt's overall (for the delta line)
//   2. Projects Gemini's 4 axes onto per-skill scores (skill-by-skill)
//   3. Builds the teaching recommendation (weakest skill by gap, etc.)
//   4. Persists the attempt to the mastery store (EMA bump) — once
//      per mount; the persistence is idempotent under React Strict Mode
//      double-mount via a ref guard
//   5. After the persist, diffs prior vs post mastery and surfaces the
//      highest tier crossing (40→60 or 60→80) so the WhatsNextCard can
//      show an ambient "Skills tightened" line
//
// All of (1–3) happen synchronously during render so the carousel can
// render the recommendation immediately. (4) and (5) happen in an
// effect so they don't fight Strict Mode.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dance } from '@/lib/dances/types';
import { useGraph } from '@/lib/graph/context';
import {
  projectSkillScores,
  type AxisScores,
} from '@/lib/graph/skillScoreProjection';
import {
  buildTeachingRecommendation,
  type SkillRow,
  type TeachingRecommendation,
} from '@/lib/graph/teachingRecommender';
import type { KnowledgeGraph, SkillNode } from '@/lib/graph/types';
import type { DanceScore } from '@/lib/scoring/gemini/score-attempt';
import { getMasteryStore } from './store';

export type TierLabel = 'getting-there' | 'dialed-in';

export interface TierCrossing {
  skill: SkillNode;
  tier: TierLabel;
}

// When Gemini attributes a fix to a specific required skill, the drill
// recommendation switches to that skill and surfaces the fix text. The
// gap-based pick is preserved on `gapWeakest` for debugging / fallback.
export interface AttributionOverride {
  skill: SkillRow;
  fix: string;
}

export interface AttemptOutcome {
  projection: Record<string, number>;
  recommendation: TeachingRecommendation;
  previousScore: number | null;
  tierCrossing: TierCrossing | null;
  attribution: AttributionOverride | null;
}

function requiredSkillNodes(
  graph: KnowledgeGraph,
  required: string[],
): SkillNode[] {
  const byId = new Map<string, SkillNode>(graph.nodes.map((n) => [n.id, n]));
  const out: SkillNode[] = [];
  for (const id of required) {
    const node = byId.get(id);
    if (node) out.push(node);
  }
  return out;
}

// Pick the highest tier crossing across all required skills. 80 wins
// over 60 if both happened in the same attempt.
function pickTierCrossing(
  required: SkillNode[],
  prior: Record<string, number>,
  post: Record<string, number>,
): TierCrossing | null {
  let dialedIn: TierCrossing | null = null;
  let gettingThere: TierCrossing | null = null;
  for (const skill of required) {
    const p = prior[skill.id] ?? 0;
    const q = post[skill.id] ?? 0;
    if (p < 0.8 && q >= 0.8) {
      if (!dialedIn) dialedIn = { skill, tier: 'dialed-in' };
    } else if (p < 0.6 && q >= 0.6) {
      if (!gettingThere) gettingThere = { skill, tier: 'getting-there' };
    }
  }
  return dialedIn ?? gettingThere;
}

const EMPTY_OUTCOME: AttemptOutcome = {
  projection: {},
  recommendation: {
    weakestSkill: null,
    otherWeak: [],
    skillRows: [],
    headline: '',
    fallback: true,
  },
  previousScore: null,
  tierCrossing: null,
  attribution: null,
};

export function useRecordDanceAttempt(
  dance: Dance | null | undefined,
  score: DanceScore,
): AttemptOutcome {
  const { graph, mastery, bumpMastery } = useGraph();

  // Synchronous snapshot, computed once. We freeze the prior mastery
  // and the previous-attempt overall here so subsequent re-renders
  // (after bumpMastery fires) don't shift what the carousel shows.
  const [snapshot] = useState(() => {
    if (!dance || !graph) {
      return {
        ready: false as const,
        projection: {} as Record<string, number>,
        recommendation: EMPTY_OUTCOME.recommendation,
        previousScore: null as number | null,
        priorMastery: {} as Record<string, number>,
        requiredSkills: [] as SkillNode[],
      };
    }
    const axes: AxisScores = score.scores;
    const requiredSkills = requiredSkillNodes(graph, dance.required_skills);
    const projection = projectSkillScores(axes, requiredSkills);

    // Snapshot mastery values for tier-crossing diff later.
    const priorMastery: Record<string, number> = {};
    for (const skill of requiredSkills) {
      priorMastery[skill.id] = mastery[skill.id] ?? 0;
    }

    const baseRec = buildTeachingRecommendation({
      dance,
      graph,
      perSkillScores: projection,
      mastery: priorMastery,
    });

    const attribution = buildAttributionOverride(
      score,
      dance,
      requiredSkills,
      projection,
      priorMastery,
      baseRec,
    );

    // When Gemini attribution lands, it wins over the gap-based pick — the
    // user sees the same skill on the miss card and the drill card.
    const recommendation: TeachingRecommendation = attribution
      ? {
          ...baseRec,
          weakestSkill: attribution.skill,
          headline: `${attribution.skill.skill.name} — Gemini flagged this`,
        }
      : baseRec;

    let previousScore: number | null = null;
    try {
      const prev = getMasteryStore().getLatestAttempt(dance.id);
      previousScore = prev ? prev.overall_score : null;
    } catch {
      previousScore = null;
    }

    return {
      ready: true as const,
      projection,
      recommendation,
      attribution,
      previousScore,
      priorMastery,
      requiredSkills,
    };
  });

  const persistedRef = useRef(false);
  const [tierCrossing, setTierCrossing] = useState<TierCrossing | null>(null);

  useEffect(() => {
    if (!snapshot.ready || persistedRef.current) return;
    if (!dance) return;
    persistedRef.current = true;
    try {
      getMasteryStore().recordAttempt(
        dance.id,
        snapshot.projection,
        score.scores.overall,
      );
      const postMastery = getMasteryStore().getAllMastery();
      const crossing = pickTierCrossing(
        snapshot.requiredSkills,
        snapshot.priorMastery,
        postMastery,
      );
      if (crossing) setTierCrossing(crossing);
      bumpMastery();
    } catch {
      /* storage disabled — fine */
    }
  }, [snapshot, dance, score.scores.overall, bumpMastery]);

  return useMemo<AttemptOutcome>(() => {
    if (!snapshot.ready) return EMPTY_OUTCOME;
    return {
      projection: snapshot.projection,
      recommendation: snapshot.recommendation,
      previousScore: snapshot.previousScore,
      tierCrossing,
      attribution: snapshot.attribution,
    };
  }, [snapshot, tierCrossing]);
}

// Build the override if Gemini attributed the top fix to a known required
// skill. Returns null when (a) there is no top fix, (b) the fix has no
// attribution, or (c) the attributed id isn't in this dance's required
// skills. In those cases the gap-based recommender stands.
//
// Exported for unit testing; not part of the hook surface.
export function buildAttributionOverride(
  score: DanceScore,
  dance: Dance,
  requiredSkills: SkillNode[],
  projection: Record<string, number>,
  mastery: Record<string, number>,
  baseRec: TeachingRecommendation,
): AttributionOverride | null {
  const topFix = score.fixes[0];
  if (!topFix?.attributed_skill_id) return null;
  const skill = requiredSkills.find((s) => s.id === topFix.attributed_skill_id);
  if (!skill) return null;

  // Prefer the row the recommender already computed (so we keep the exact
  // weight + gap), but fall back to a freshly-built row if Gemini named a
  // skill that the recommender filtered out (e.g. unknown to skill_weights).
  const existing = baseRec.skillRows.find((r) => r.skill.id === skill.id);
  if (existing) return { skill: existing, fix: topFix.fix };

  const weights = dance.skill_weights ?? {};
  const w = weights[skill.id] ?? 1 / Math.max(1, requiredSkills.length);
  const s = clamp100(projection[skill.id] ?? 0);
  const m = clamp01(mastery[skill.id] ?? 0);
  return {
    skill: {
      skill,
      score: s,
      weight: w,
      mastery: m,
      gap: w * (1 - s / 100),
    },
    fix: topFix.fix,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function clamp100(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}
