// End-to-end scorer. Pure TS, no DOM.
//
// Pipeline:
//   1. DTW-align user frames against reference frames (caller can pass pre-
//      computed alignment for live scoring).
//   2. For each aligned pair, compute frame_score = 100 * exp(-(1 - cos) * 5).
//   3. Group frames by beat (via BeatGrid.getBeatAt).
//   4. Beat score = mean of frame scores in that beat.
//   5. Overall = mean of beat scores.
//   6. Per-skill scores: partition the dance uniformly over skillIds.
//      Tomorrow's real choreography labels will replace this with per-move
//      timestamp ranges; the partition strategy is isolated to a single
//      function so swapping is trivial.

import type { FrameSample, JointAngleVector, JointName } from '@/lib/pose/types';
import { JOINT_NAMES } from '@/lib/pose/types';
import { dtw } from './dtw';
import { cosineSimilarity } from './similarity';
import type {
  BeatGrid,
  BeatScore,
  CorrectionHint,
  FrameScore,
  SessionScore,
} from './types';

export interface ScoreSessionInput {
  userFrames: FrameSample[];
  referenceFrames: FrameSample[];
  beatGrid: BeatGrid;
  skillIds: string[];
  totalBeats?: number; // optional override, derived from frames if absent
}

// Frame-score mapping calibrated empirically against real Mode B
// recordings. The old exponential (exp(-(1-s)*5)) crushed honest cosine
// scores of 0.95 down to a misleading 78. Real human follow-along
// performances on competent attempts land around cosine 0.85-0.97
// against a real reference. We map those linearly into a 0-100 band so
// the displayed number tracks what a human watching would call out.
//
// Calibration anchors (see docs/scoring-rebuild-summary.md):
//   sim 1.00 → 100   (perfect)
//   sim 0.95 → 88    (mild divergence, still excellent)
//   sim 0.90 → 76    (visible divergence, passing)
//   sim 0.80 → 56    (clearly off)
//   sim 0.60 → 22    (very off — wrong move)
//   sim 0.40 → 0     (no resemblance — stand still floor)
//   sim ≤0.40 → 0
//
// Piecewise-linear with two anchors at (0.40, 0) and (1.00, 100), bent
// at (0.85, 65) to keep "passing" performances within reach without
// flattering bad ones. Floor at 0, ceiling at 100.
export function frameScoreFromSimilarity(similarity: number): number {
  const s = Number.isFinite(similarity) ? similarity : 0;
  if (s <= 0.4) return 0;
  if (s >= 1.0) return 100;
  if (s < 0.85) {
    // (0.4, 0) → (0.85, 65)
    const t = (s - 0.4) / (0.85 - 0.4);
    return Math.max(0, Math.min(100, 65 * t));
  }
  // (0.85, 65) → (1.0, 100)
  const t = (s - 0.85) / (1.0 - 0.85);
  return Math.max(0, Math.min(100, 65 + (100 - 65) * t));
}

// Mirror a joint-angle vector: swap left_* ↔ right_*. Hip rotation
// flips sign (the hip line orientation reverses), torso_lean and
// chest_forward_z are bilaterally symmetric so they pass through. Used
// when comparing a follow-along user against a normally-oriented
// reference dancer.
export function mirrorJointAngleVector(v: JointAngleVector): JointAngleVector {
  return {
    left_elbow: v.right_elbow,
    right_elbow: v.left_elbow,
    left_shoulder: v.right_shoulder,
    right_shoulder: v.left_shoulder,
    left_hip: v.right_hip,
    right_hip: v.left_hip,
    left_knee: v.right_knee,
    right_knee: v.left_knee,
    torso_lean: v.torso_lean,
    hip_rotation_y: -v.hip_rotation_y,
    chest_forward_z: v.chest_forward_z,
  };
}

export function scoreSession(input: ScoreSessionInput): SessionScore {
  const { userFrames, referenceFrames, beatGrid, skillIds } = input;
  if (userFrames.length === 0 || referenceFrames.length === 0) {
    return { overall: 0, beats: [], frames: [], perSkillScores: {} };
  }
  const userVectors = userFrames.map((f) => f.vector);
  const refVectors = referenceFrames.map((f) => f.vector);
  const alignment = dtw(userVectors, refVectors);

  const frames: FrameScore[] = [];
  for (const [u, r] of alignment.path) {
    const userF = userFrames[u]!;
    const refF = referenceFrames[r]!;
    const sim = clampCos(cosineSimilarity(userF.vector, refF.vector));
    const score = frameScoreFromSimilarity(sim);
    const beatIdx = Math.max(0, Math.floor(beatGrid.getBeatAt(userF.timestampMs)));
    frames.push({ userIdx: u, refIdx: r, similarity: sim, score, beatIdx });
  }

  // Aggregate per-beat.
  const byBeat = new Map<number, number[]>();
  for (const f of frames) {
    const arr = byBeat.get(f.beatIdx);
    if (arr) arr.push(f.score);
    else byBeat.set(f.beatIdx, [f.score]);
  }
  const beatIdxs = Array.from(byBeat.keys()).sort((a, b) => a - b);
  const beats: BeatScore[] = beatIdxs.map((idx) => {
    const xs = byBeat.get(idx)!;
    return { beatIdx: idx, score: mean(xs), frameCount: xs.length };
  });

  const overall = beats.length > 0 ? mean(beats.map((b) => b.score)) : 0;
  const perSkillScores = partitionBeatsToSkills(beats, skillIds);

  return { overall, beats, frames, perSkillScores };
}

// Partition beats uniformly across skillIds. Skill k gets beats in
// [k*B/K, (k+1)*B/K). Placeholder strategy until real choreography labels.
// If a slice is empty (fewer beats than skills), fall back to the overall mean
// so we never penalize a skill purely because the partition gave it no beats.
function partitionBeatsToSkills(
  beats: BeatScore[],
  skillIds: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (skillIds.length === 0) return out;
  if (beats.length === 0) {
    for (const id of skillIds) out[id] = 0;
    return out;
  }
  const overall = mean(beats.map((b) => b.score));
  const B = beats.length;
  const K = skillIds.length;
  for (let k = 0; k < K; k++) {
    const start = Math.floor((k * B) / K);
    const end = Math.floor(((k + 1) * B) / K);
    const slice = beats.slice(start, end);
    const id = skillIds[k]!;
    out[id] = slice.length > 0 ? mean(slice.map((b) => b.score)) : overall;
  }
  return out;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function clampCos(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// -------- correctionHint --------

const HINT_PRETTY: Record<JointName, string> = {
  left_elbow: 'left elbow',
  right_elbow: 'right elbow',
  left_shoulder: 'left shoulder',
  right_shoulder: 'right shoulder',
  left_hip: 'left hip',
  right_hip: 'right hip',
  left_knee: 'left knee',
  right_knee: 'right knee',
  torso_lean: 'torso',
  hip_rotation_y: 'hips',
  chest_forward_z: 'chest',
};

const ANGLE_DEVIATION_THRESHOLD = 15; // degrees
const DISPLACEMENT_THRESHOLD = 0.06; // meters

// Given a user frame and a reference frame, return the most significant
// correction hint, or null if everything is within tolerance.
export function correctionHint(
  user: JointAngleVector,
  reference: JointAngleVector,
): CorrectionHint | null {
  let worst: { joint: JointName; mag: number; signed: number } | null = null;
  for (const k of JOINT_NAMES) {
    const u = user[k] ?? 0;
    const r = reference[k] ?? 0;
    const diff = u - r;
    const mag = Math.abs(diff);
    const isDisplacement = k === 'chest_forward_z';
    const threshold = isDisplacement
      ? DISPLACEMENT_THRESHOLD
      : ANGLE_DEVIATION_THRESHOLD;
    if (mag < threshold) continue;
    if (!worst || mag > worst.mag) worst = { joint: k, mag, signed: diff };
  }
  if (!worst) return null;
  return {
    joint: worst.joint,
    message: phraseFor(worst.joint, worst.signed),
    magnitude: worst.mag,
  };
}

function phraseFor(joint: JointName, signed: number): string {
  const noun = HINT_PRETTY[joint];
  // For angle joints, user > reference means joint is more extended → "straighten less" / "bend more"
  // We keep the language UI-friendly with a directional verb.
  switch (joint) {
    case 'left_elbow':
    case 'right_elbow':
    case 'left_knee':
    case 'right_knee':
      return signed > 0 ? `bend your ${noun}` : `straighten your ${noun}`;
    case 'left_shoulder':
    case 'right_shoulder':
      return signed > 0 ? `lower your ${noun}` : `raise your ${noun}`;
    case 'left_hip':
    case 'right_hip':
      return signed > 0 ? `straighten your ${noun}` : `bend your ${noun} more`;
    case 'torso_lean':
      return signed > 0 ? `stand taller` : `lean in a bit`;
    case 'hip_rotation_y':
      return `square your ${noun}`;
    case 'chest_forward_z':
      return signed > 0 ? `pull your ${noun} back` : `push your ${noun} forward`;
  }
}
