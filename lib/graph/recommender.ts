// Pick the next drill after a dance attempt.
//
// Strategy:
//   For each skill in dance.required_skills:
//     gap = weight * (1 - mastery)
//   Sort by gap desc, return top 1 with the corresponding skill node from the
//   graph. The drill text comes from the skill node's drill_description.

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
  mastery: Record<string, number>;
}

export interface Recommendation {
  skill: SkillNode;
  weight: number;
  mastery: number; // 0..1
  // weight * (1 - mastery)
  gap: number;
}

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

function nodeById(graph: KnowledgeGraph, id: string): SkillNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

// Returns the top N skills to drill next, sorted by gap (weight * (1 - mastery))
// descending. Defaults to 1 (matches spec: "Return the top 1 skill to drill").
export function recommendDrills(
  input: RecommenderInput,
  topN = 1,
): Recommendation[] {
  const weights = resolveWeights(input.dance, input.graph);
  const ids = Object.keys(weights);
  const candidates: Recommendation[] = [];
  for (const id of ids) {
    const skill = nodeById(input.graph, id);
    if (!skill) continue;
    const w = weights[id] ?? 0;
    const m = input.mastery[id] ?? 0;
    candidates.push({
      skill,
      weight: w,
      mastery: m,
      gap: w * (1 - m),
    });
  }
  candidates.sort((a, b) => b.gap - a.gap);
  return candidates.slice(0, topN);
}

export function recommendNextDrill(
  input: RecommenderInput,
): Recommendation | undefined {
  return recommendDrills(input, 1)[0];
}
