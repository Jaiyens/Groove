// Per-skill score projection.
//
// Gemini returns 4 axes (timing/shape/energy/flow) plus an overall.
// Mastery wants one number per skill. Each skill has a `category`, and
// each category has a default weighting over the axes — e.g. an
// isolation skill is mostly shape, a travel skill is mostly flow/timing.
// A skill node may also declare its own `axis_weights` to override the
// category default when the category fit is wrong.
//
// The output is rounded ints in [0, 100], one per skill, suitable for
// recordAttempt() in the mastery store.

import type { AxisWeights, SkillCategory, SkillNode } from './types';

export interface AxisScores {
  timing: number;
  shape: number;
  energy: number;
  flow: number;
  overall: number;
}

// Category defaults. Coefficients per axis should sum to 1.0; if a
// category is missing one (e.g. isolation has no flow term), the
// missing axes are treated as zero. Keep these as the single source of
// truth — `lib/graph/types.ts` SkillNode.axis_weights is the override
// path.
export const CATEGORY_AXIS_WEIGHTS: Record<SkillCategory, AxisWeights> = {
  foundation: { timing: 0.5, shape: 0.2, energy: 0.15, flow: 0.15 },
  isolation: { timing: 0.15, shape: 0.65, energy: 0.2, flow: 0.0 },
  travel: { timing: 0.3, shape: 0.15, energy: 0.1, flow: 0.45 },
  combo: { timing: 0.3, shape: 0.3, energy: 0.2, flow: 0.2 },
  vocabulary: { timing: 0.1, shape: 0.4, energy: 0.3, flow: 0.2 },
  // Routines pass `overall` through verbatim — the per-axis blend
  // doesn't apply to a whole-routine node.
  routine: { timing: 0, shape: 0, energy: 0, flow: 0 },
};

function clampScore(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 100) return 100;
  return x;
}

function weightsFor(skill: SkillNode): AxisWeights {
  return skill.axis_weights ?? CATEGORY_AXIS_WEIGHTS[skill.category];
}

// Blend the 4 axes for a single skill. For `routine` skills, returns the
// overall score directly.
export function projectOneSkill(skill: SkillNode, scores: AxisScores): number {
  if (skill.category === 'routine') return Math.round(clampScore(scores.overall));
  const w = weightsFor(skill);
  const t = clampScore(scores.timing);
  const s = clampScore(scores.shape);
  const e = clampScore(scores.energy);
  const f = clampScore(scores.flow);
  const projected = w.timing * t + w.shape * s + w.energy * e + w.flow * f;
  return Math.round(clampScore(projected));
}

// Project the 4-axis Gemini score into a per-skill score for every
// skill in `skills`. Output keys are skill ids.
export function projectSkillScores(
  scores: AxisScores,
  skills: SkillNode[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const skill of skills) {
    out[skill.id] = projectOneSkill(skill, scores);
  }
  return out;
}
