// Chunk a routine into byte-sized practice segments.
//
// Pedagogical model: people learn TikTok dances in 2–4 beat chunks. Each chunk
// covers 1–2 sequential skills from the routine's `required_skills` array.
// A 16-second / 123 BPM routine with ~12 required skills yields ~6 chunks of
// ~2.5 seconds.
//
// Pure TS — no DOM. Swift-portable.

import type { RoutineNode } from './types';

export interface Chunk {
  index: number;
  startMs: number;
  endMs: number;
  // The skill ids practiced in this chunk (ordered as they appear in
  // routine.required_skills). The chunk's "primary" is skills[0].
  skills: string[];
  // Human-readable label, derived from the primary skill if a graph is
  // supplied, else `chunk N/M`.
  label: string;
}

export interface ChunkerOptions {
  // Target chunk duration in seconds. Default 2.5s — short enough to mirror,
  // long enough to feel like a "move".
  targetChunkSeconds?: number;
  // Skills per chunk. Default 2. Used when the routine has enough skills to
  // support this many chunks at the target duration.
  skillsPerChunk?: number;
  // Optional name lookup (skillId → display name). When supplied, chunk
  // labels are derived from the primary skill's name.
  nameOf?: (id: string) => string | undefined;
}

const DEFAULT_TARGET_SECONDS = 2.5;
const DEFAULT_SKILLS_PER_CHUNK = 2;

export function chunkRoutine(
  routine: RoutineNode,
  options: ChunkerOptions = {},
): Chunk[] {
  const target = options.targetChunkSeconds ?? DEFAULT_TARGET_SECONDS;
  const sppc = Math.max(1, options.skillsPerChunk ?? DEFAULT_SKILLS_PER_CHUNK);
  const totalMs = Math.max(0, routine.duration_seconds * 1000);
  const skills = routine.required_skills;

  if (totalMs <= 0 || skills.length === 0) {
    return [];
  }

  // Number of chunks: clamp by both duration target and skills-per-chunk so
  // we always have at least 2 chunks (otherwise mode-C is the same as mode-A)
  // and at most 8 (any more and the overview screen gets unreadable).
  const byDuration = Math.max(2, Math.round(routine.duration_seconds / target));
  const bySkills = Math.max(1, Math.ceil(skills.length / sppc));
  const n = clamp(Math.min(byDuration, bySkills), 2, 8);

  const chunkMs = totalMs / n;
  const chunks: Chunk[] = [];
  for (let i = 0; i < n; i++) {
    const startMs = Math.round(i * chunkMs);
    const endMs = i === n - 1 ? totalMs : Math.round((i + 1) * chunkMs);

    // Distribute skills as evenly as possible. Skill k goes in chunk
    // floor(k * n / skills.length).
    const chunkSkills: string[] = [];
    for (let k = 0; k < skills.length; k++) {
      if (Math.floor((k * n) / skills.length) === i) {
        chunkSkills.push(skills[k]!);
      }
    }
    // Guard: if rounding left a chunk with no skills (rare), give it the
    // nearest skill so the UI never shows an empty chunk.
    if (chunkSkills.length === 0) {
      const k = Math.min(skills.length - 1, Math.round(i * (skills.length / n)));
      chunkSkills.push(skills[k]!);
    }

    const primary = chunkSkills[0]!;
    const primaryName = options.nameOf?.(primary);
    const label = primaryName ?? `Chunk ${i + 1}`;

    chunks.push({ index: i, startMs, endMs, skills: chunkSkills, label });
  }
  return chunks;
}

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
