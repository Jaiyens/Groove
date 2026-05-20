// Legacy reference-dance fixtures.
//
// v2 NOTE: the library is now backend-driven (see `lib/dances/api.ts`). These
// fixtures are kept around per SPECK.md hard-rule §3 ("do NOT delete the
// existing fixtures file in this commit. Comment it out and keep it for
// reference until the backend is verified working") and are exposed under
// `LEGACY_DANCES` for any caller that still wants them.
//
// They are NOT rendered on the home page. The home page reads from
// `GET /api/dances`. If you genuinely want offline / no-Supabase mode for
// local UI iteration, import `LEGACY_DANCES` directly.
//
// `getDance(id, graph)` still works against the legacy fixtures so the
// existing practice routes (Mode A / B / C) keep compiling — Phase 5 swaps
// them to the API-driven path.

import type { Dance, DanceFixture } from './types';
import { isRoutineNode, type KnowledgeGraph } from '@/lib/graph/types';

export const LEGACY_DANCES: readonly DanceFixture[] = [
  { id: 'routine_golden',           name: 'Golden',           artist: 'HUNTR/X',   video_url: '/data/reference_dances/golden.mp4' },
  { id: 'routine_dead_dance',       name: 'The Dead Dance',   artist: 'Lady Gaga', video_url: '/data/reference_dances/dead_dance.mp4' },
  { id: 'routine_not_cute_anymore', name: 'Not Cute Anymore', artist: 'ILLIT',     video_url: '/data/reference_dances/not_cute_anymore.mp4' },
] as const;

// kept as the legacy alias so any old import sites still resolve.
export const DANCES = LEGACY_DANCES;

export function getDanceFixture(id: string): DanceFixture | undefined {
  return LEGACY_DANCES.find((d) => d.id === id);
}

export function resolveDance(
  fixture: DanceFixture,
  graph: KnowledgeGraph,
): Dance | undefined {
  const node = graph.nodes.find((n) => n.id === fixture.id);
  if (!node || !isRoutineNode(node)) return undefined;
  return {
    id: fixture.id,
    name: fixture.name,
    artist: fixture.artist,
    video_url: fixture.video_url,
    audio_url: fixture.video_url,
    thumbnail_url: null,
    tiktok_url: '',
    bpm: node.bpm,
    duration_seconds: node.duration_seconds,
    required_skills: [...node.required_skills],
    skill_weights: { ...node.skill_weights },
    pose_data_url: null,
    low_quality: false,
    audio_start_offset_ms: 0,
  };
}

export function getDance(id: string, graph: KnowledgeGraph): Dance | undefined {
  const fixture = getDanceFixture(id);
  if (!fixture) return undefined;
  return resolveDance(fixture, graph);
}
