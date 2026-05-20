// Compute % ready (0..100 int) for a dance given current mastery.
// Pure function — no DOM, no React.

import type { Dance } from '@/lib/dances/types';
import { isRoutineNode, type AnyNode, type KnowledgeGraph } from './types';

export interface ReadinessInput {
  dance: Dance;
  graph: KnowledgeGraph;
  mastery: Record<string, number>; // skill_id -> 0..1
}

export interface SkillReadiness {
  skill_id: string;
  skill_name: string;
  mastery: number; // 0..1
  weight: number; // 0..1
}

export interface ReadinessResult {
  percent: number; // 0..100 integer
  perSkill: SkillReadiness[];
}

// If a RoutineNode in the graph has id === dance.id, use its skill_weights.
// Otherwise distribute weight uniformly across dance.required_skills.
function resolveWeights(
  dance: Dance,
  graph: KnowledgeGraph,
): Record<string, number> {
  const match = graph.nodes.find((n): n is AnyNode => n.id === dance.id);
  if (match && isRoutineNode(match)) {
    return match.skill_weights;
  }
  const n = dance.required_skills.length;
  if (n === 0) return {};
  const uniform = 1 / n;
  const out: Record<string, number> = {};
  for (const id of dance.required_skills) out[id] = uniform;
  return out;
}

function nameOf(graph: KnowledgeGraph, id: string): string {
  return graph.nodes.find((n) => n.id === id)?.name ?? id;
}

export function computeReadiness({
  dance,
  graph,
  mastery,
}: ReadinessInput): ReadinessResult {
  const weights = resolveWeights(dance, graph);
  // Iterate the full required_skills list (not just the weighted ones) so
  // every required skill appears in the per-skill breakdown — even those a
  // routine left unweighted (e.g. routine_golden lists posture_alignment in
  // required_skills but assigns it no weight).
  const ids =
    dance.required_skills.length > 0
      ? [...dance.required_skills]
      : Object.keys(weights);
  if (ids.length === 0) {
    return { percent: 0, perSkill: [] };
  }
  const totalWeight = ids.reduce((s, id) => s + (weights[id] ?? 0), 0);
  let weighted = 0;
  const perSkill: SkillReadiness[] = [];
  for (const id of ids) {
    const w = weights[id] ?? 0;
    const m = mastery[id] ?? 0;
    weighted += w * m;
    perSkill.push({
      skill_id: id,
      skill_name: nameOf(graph, id),
      mastery: m,
      weight: w,
    });
  }
  const normalized = totalWeight > 0 ? weighted / totalWeight : 0;
  return {
    percent: Math.round(Math.max(0, Math.min(1, normalized)) * 100),
    perSkill,
  };
}
