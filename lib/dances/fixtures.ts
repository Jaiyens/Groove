// Reference dance fixtures.
//
// Each fixture's `id` MUST match a Layer 6 routine node in
// public/data/knowledge_graph.json. At runtime we merge the fixture (editorial
// metadata — name, artist, video file) with the routine node (pedagogy — bpm,
// duration, required_skills, skill_weights) via resolveDance().
//
// Placeholder mp4s — Jaiyen will drop real chorus clips into
// public/data/reference_dances/ tomorrow.

import type { Dance, DanceFixture } from './types';
import { isRoutineNode, type KnowledgeGraph } from '@/lib/graph/types';

export const DANCES: readonly DanceFixture[] = [
  {
    id: 'routine_golden',
    name: 'Golden',
    artist: 'HUNTR/X',
    video_url: '/data/reference_dances/golden.mp4',
  },
  {
    id: 'routine_dead_dance',
    name: 'The Dead Dance',
    artist: 'Lady Gaga',
    video_url: '/data/reference_dances/dead_dance.mp4',
  },
  {
    id: 'routine_not_cute_anymore',
    name: 'Not Cute Anymore',
    artist: 'ILLIT',
    video_url: '/data/reference_dances/not_cute_anymore.mp4',
  },
] as const;

export function getDanceFixture(id: string): DanceFixture | undefined {
  return DANCES.find((d) => d.id === id);
}

// Merge a fixture with its routine node from the graph. Returns undefined
// if either the fixture or the routine node is missing — callers should
// surface this as "dance unavailable".
export function resolveDance(
  fixture: DanceFixture,
  graph: KnowledgeGraph,
): Dance | undefined {
  const node = graph.nodes.find((n) => n.id === fixture.id);
  if (!node || !isRoutineNode(node)) return undefined;
  return {
    ...fixture,
    bpm: node.bpm,
    duration_seconds: node.duration_seconds,
    required_skills: [...node.required_skills],
    skill_weights: { ...node.skill_weights },
  };
}

export function getDance(id: string, graph: KnowledgeGraph): Dance | undefined {
  const fixture = getDanceFixture(id);
  if (!fixture) return undefined;
  return resolveDance(fixture, graph);
}
