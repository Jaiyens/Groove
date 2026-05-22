// Scoring & timing types.

import type { JointAngleVector, JointName } from '@/lib/pose/types';

export interface DTWResult {
  cost: number;
  path: Array<[number, number]>; // (userIdx, refIdx)
}

export interface FrameScore {
  userIdx: number;
  refIdx: number;
  similarity: number; // 0..1 cosine
  score: number;      // 0..100 mapped from similarity
  beatIdx: number;    // which beat this frame belongs to
}

export interface BeatScore {
  beatIdx: number;
  score: number; // 0..100 mean of frame scores in this beat
  frameCount: number;
}

// Per-frame, per-joint score (0..100) so the results UI can show the
// user where the deviation happened. Sparse — empty in legacy callers.
export interface FrameJointScores {
  // Same axis order as JOINT_NAMES.
  values: number[];
}

export interface ComponentScores {
  arms: number; // 0..100, weighted mean of arm joint scores
  legs: number; // 0..100
  body: number; // 0..100
  timing: number; // 0..100, derived from DTW path warping
}

export interface TroubleSpot {
  // Absolute routine time (ms) — same coordinate as the chunk's
  // startMs/endMs so the drill-mode URL is a one-liner.
  startMs: number;
  endMs: number;
  // Mean overall score in this window, 0..100.
  score: number;
  // Name of the joint that diverged the most in this window.
  worstJoint: JointName | null;
  // Magnitude of that worst-joint divergence, in the joint's native unit.
  worstJointDelta: number;
  // Human-readable phrase, e.g. "right arm 30° off".
  message: string;
}

export interface SessionScore {
  overall: number; // 0..100
  beats: BeatScore[];
  frames: FrameScore[];
  perSkillScores: Record<string, number>; // skill_id -> 0..100
  // Filled in by the rebuilt scorer (Stage 3+). Older callers that
  // ignore these can still read .overall as before.
  components?: ComponentScores;
  troubleSpots?: TroubleSpot[];
  // Variance-derived weights actually used in the score, exposed so UI
  // and debug overlays can explain "we weighted arms heavily this
  // chunk because that's where the move lives".
  jointWeights?: Record<JointName, number>;
}

export interface CorrectionHint {
  joint: JointName | 'tempo';
  // human-readable, e.g. "left elbow higher", "you're a beat behind"
  message: string;
  // magnitude of deviation, in vector units (degrees for angles, m for displacements)
  magnitude: number;
}

export interface BeatGrid {
  bpm: number;
  startMs: number;
  // Returns 0-based beat index at a given audio time (ms relative to startMs).
  getBeatAt(timestampMs: number): number;
  // ms position of beat N relative to startMs.
  msAtBeat(beatIdx: number): number;
}

export interface ScoreColorTier {
  tier: 'good' | 'okay' | 'low';
  // Tailwind utility for foreground color.
  color: string;
}

export function scoreColor(score: number): ScoreColorTier {
  if (score >= 80) return { tier: 'good', color: 'text-accent-green' };
  if (score >= 60) return { tier: 'okay', color: 'text-accent-amber' };
  return { tier: 'low', color: 'text-accent-red' };
}

export function scoreBarColor(score: number): string {
  if (score >= 80) return 'bg-accent-green';
  if (score >= 60) return 'bg-accent-amber';
  return 'bg-accent-red';
}
