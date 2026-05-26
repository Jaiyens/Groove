// Attempt-aware drill recommender.
//
// The old recommender picks based on persistent mastery only — same
// answer regardless of how the most recent attempt went. This one
// folds in the actual per-skill scores from the attempt so the
// recommendation reflects what just went wrong, not just what's
// historically weakest.
//
// Gap formula: `gap = weight * (1 - score/100)`, where score is the
// projected per-skill score from this attempt. Ties break on lower
// mastery — that way, if two skills got the same projected score,
// drill the one with the weaker persistent foundation.

import type { Dance } from '@/lib/dances/types';
import {
  isRoutineNode,
  type AnyNode,
  type KnowledgeGraph,
  type SkillNode,
} from './types';

export interface RecommenderInput {
  dance: Dance;
  graph: KnowledgeGraph;
  perSkillScores: Record<string, number>;
  mastery: Record<string, number>;
}

export interface SkillRow {
  skill: SkillNode;
  score: number; // this attempt's projected per-skill score, 0..100
  weight: number; // 0..1
  mastery: number; // 0..1, persistent
  gap: number; // weight * (1 - score/100)
}

export interface TeachingRecommendation {
  // null when every required skill scored >= 80 — nothing to drill.
  weakestSkill: SkillRow | null;
  // Positions 2 and 3 by gap, useful for an "other weak skills" surface.
  otherWeak: SkillRow[];
  // All required skills sorted by weight desc; for the breakdown disclosure.
  skillRows: SkillRow[];
  // Composed headline; "<strongest> landed, <weakest> needs work" when
  // both are identifiable, else a fallback.
  headline: string;
  // True when the dance has no required-skills mapping (legacy row).
  fallback: boolean;
}

// Threshold above which a skill is considered "fine" and the drill
// card collapses — don't push a drill for a skill the user just nailed.
const WEAKEST_SCORE_CEILING = 80;

function resolveWeights(
  dance: Dance,
  graph: KnowledgeGraph,
): Record<string, number> {
  // Priority: graph routine (canonical) > dance.skill_weights (server-
  // populated for fresh uploads) > uniform across required_skills.
  const match = graph.nodes.find((n): n is AnyNode => n.id === dance.id);
  if (match && isRoutineNode(match)) {
    return match.skill_weights;
  }
  if (dance.skill_weights && Object.keys(dance.skill_weights).length > 0) {
    return dance.skill_weights;
  }
  const n = dance.required_skills.length;
  if (n === 0) return {};
  const uniform = 1 / n;
  const out: Record<string, number> = {};
  for (const id of dance.required_skills) out[id] = uniform;
  return out;
}

function nodeById(graph: KnowledgeGraph, id: string): SkillNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

function emptyRecommendation(headline: string): TeachingRecommendation {
  return {
    weakestSkill: null,
    otherWeak: [],
    skillRows: [],
    headline,
    fallback: true,
  };
}

export function buildTeachingRecommendation(
  input: RecommenderInput,
): TeachingRecommendation {
  const weights = resolveWeights(input.dance, input.graph);
  const ids = Object.keys(weights);
  if (ids.length === 0) {
    return emptyRecommendation('nice work');
  }

  const rows: SkillRow[] = [];
  for (const id of ids) {
    const skill = nodeById(input.graph, id);
    if (!skill) continue;
    const w = weights[id] ?? 0;
    const score = clamp100(input.perSkillScores[id] ?? 0);
    const mastery = clamp01(input.mastery[id] ?? 0);
    rows.push({
      skill,
      score,
      weight: w,
      mastery,
      gap: w * (1 - score / 100),
    });
  }

  if (rows.length === 0) {
    return emptyRecommendation('nice work');
  }

  const byGap = [...rows].sort((a, b) => {
    if (b.gap !== a.gap) return b.gap - a.gap;
    // Tiebreak: lower mastery wins so the weaker foundation gets the
    // drill priority on equal-gap days.
    return a.mastery - b.mastery;
  });

  const byScore = [...rows].sort((a, b) => b.score - a.score);
  const strongest = byScore[0] ?? null;

  const topGap = byGap[0] ?? null;
  const weakestSkill =
    topGap && topGap.score < WEAKEST_SCORE_CEILING ? topGap : null;
  const otherWeak = byGap
    .slice(1, 3)
    .filter((r) => r.score < WEAKEST_SCORE_CEILING);

  const skillRows = [...rows].sort((a, b) => b.weight - a.weight);

  let headline: string;
  if (weakestSkill && strongest && strongest.skill.id !== weakestSkill.skill.id) {
    headline = `${strongest.skill.name} landed — ${weakestSkill.skill.name} needs work`;
  } else if (weakestSkill) {
    headline = `${weakestSkill.skill.name} needs work`;
  } else if (strongest) {
    headline = `everything landed — nice run`;
  } else {
    headline = 'nice work';
  }

  return {
    weakestSkill,
    otherWeak,
    skillRows,
    headline,
    fallback: false,
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
