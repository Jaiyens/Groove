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
import {
  COMPONENT_JOINTS,
  DEFAULT_TOLERANCES,
  compareFrame,
  deriveJointWeights,
  perJointScore,
  type JointWeights,
} from './jointWeights';
import { cosineSimilarity } from './similarity';
import type {
  BeatGrid,
  BeatScore,
  ComponentScores,
  CorrectionHint,
  FrameScore,
  SessionScore,
  TroubleSpot,
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

// Time slack (ms) that DTW is allowed to warp a frame by. Spec stage 3.5:
// "Allow ~200ms of timing slack but not more. Too much warping rewards
// lazy timing." The dtw() local function converts this to an index-based
// band via the streams' median frame interval.
const DTW_MAX_SLACK_MS = 220;

export function scoreSession(input: ScoreSessionInput): SessionScore {
  const { userFrames, referenceFrames, beatGrid, skillIds } = input;
  if (userFrames.length === 0 || referenceFrames.length === 0) {
    return {
      overall: 0,
      beats: [],
      frames: [],
      perSkillScores: {},
      components: { arms: 0, legs: 0, body: 0, timing: 0 },
      troubleSpots: [],
    };
  }
  const jointWeights = deriveJointWeights(referenceFrames);
  const userVectors = userFrames.map((f) => f.vector);
  const refVectors = referenceFrames.map((f) => f.vector);
  const dtwWindow = computeDtwWindow(userFrames, referenceFrames);
  const alignment = dtw(userVectors, refVectors, dtwWindow);

  // Per-frame-pair score using the per-joint, weighted similarity. We
  // ALSO keep the cosine number around so the (legacy) FrameScore type's
  // `similarity` field stays meaningful.
  const frames: FrameScore[] = [];
  // Accumulators for the components.
  const jointTotals: Record<JointName, number> = {} as Record<JointName, number>;
  const jointCounts: Record<JointName, number> = {} as Record<JointName, number>;
  for (const k of JOINT_NAMES) {
    jointTotals[k] = 0;
    jointCounts[k] = 0;
  }
  // Map of routine-time (ms) → list of frame scores for trouble-spot
  // detection. Bucketing happens in a second pass.
  const perFrame: Array<{
    tMs: number;
    score: number;
    perJoint: Record<JointName, number>;
    refVec: JointAngleVector;
    userVec: JointAngleVector;
  }> = [];

  for (const [u, r] of alignment.path) {
    const userF = userFrames[u]!;
    const refF = referenceFrames[r]!;
    const sim = clampCos(cosineSimilarity(userF.vector, refF.vector));
    const cmp = compareFrame(userF.vector, refF.vector, jointWeights);
    const score = Math.max(0, Math.min(100, cmp.overall * 100));
    const beatIdx = Math.max(0, Math.floor(beatGrid.getBeatAt(userF.timestampMs)));
    frames.push({ userIdx: u, refIdx: r, similarity: sim, score, beatIdx });
    for (const k of JOINT_NAMES) {
      jointTotals[k] += cmp.perJoint[k];
      jointCounts[k] += 1;
    }
    perFrame.push({
      tMs: userF.timestampMs,
      score,
      perJoint: cmp.perJoint,
      refVec: refF.vector,
      userVec: userF.vector,
    });
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

  // Component scores: mean per-joint score (0-1) within each group →
  // 0-100. For timing we use DTW path properties — see
  // computeTimingScore().
  const components: ComponentScores = {
    arms: meanGroupScore(jointTotals, jointCounts, COMPONENT_JOINTS.arms) * 100,
    legs: meanGroupScore(jointTotals, jointCounts, COMPONENT_JOINTS.legs) * 100,
    body: meanGroupScore(jointTotals, jointCounts, COMPONENT_JOINTS.body) * 100,
    timing: computeTimingScore(alignment.path),
  };

  const troubleSpots = findTroubleSpots(perFrame, overall);

  return {
    overall,
    beats,
    frames,
    perSkillScores,
    components,
    troubleSpots,
    jointWeights,
  };
}

// Convert the spec's 220ms timing slack into a DTW index window via the
// median frame interval of the longer of the two streams. Falls back to
// the existing 10%-of-max-length heuristic for very short chunks.
function computeDtwWindow(
  userFrames: FrameSample[],
  referenceFrames: FrameSample[],
): number {
  const candidate = Math.max(userFrames.length, referenceFrames.length);
  if (candidate < 4) return Math.max(1, candidate);
  const interval = medianFrameInterval(
    userFrames.length >= referenceFrames.length ? userFrames : referenceFrames,
  );
  if (interval <= 0) return Math.ceil(candidate * 0.04);
  return Math.max(
    Math.abs(userFrames.length - referenceFrames.length),
    Math.ceil(DTW_MAX_SLACK_MS / interval),
  );
}

function medianFrameInterval(frames: FrameSample[]): number {
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    deltas.push(frames[i]!.timestampMs - frames[i - 1]!.timestampMs);
  }
  if (deltas.length === 0) return 0;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas[mid] ?? 0;
}

function meanGroupScore(
  totals: Record<JointName, number>,
  counts: Record<JointName, number>,
  group: JointName[],
): number {
  let s = 0;
  let n = 0;
  for (const k of group) {
    if (counts[k] === 0) continue;
    s += totals[k] / counts[k];
    n += 1;
  }
  return n > 0 ? s / n : 0;
}

// Timing score from DTW path warping. A perfect tempo match has every
// step diagonal — both user and reference advance together. Stalls (move
// only along one axis) mean the dancer is behind/ahead; we count the
// fraction of strictly diagonal steps and convert to 0-100. We also
// bake in a floor so a chunk with no path returns 0 instead of NaN.
function computeTimingScore(path: ReadonlyArray<readonly [number, number]>): number {
  if (path.length < 2) return 100;
  let diag = 0;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [u0, r0] = path[i - 1]!;
    const [u1, r1] = path[i]!;
    if (u1 === u0 && r1 === r0) continue; // shouldn't happen but be defensive
    total += 1;
    if (u1 > u0 && r1 > r0) diag += 1;
  }
  if (total === 0) return 100;
  const ratio = diag / total;
  // Calibrated so a ratio of 0.9 (typical real performance with some
  // micro-warping) lands around 88 — same band as the frame-score
  // calibration. Linear above 0.6, floored at 0 below.
  if (ratio <= 0.5) return 0;
  if (ratio >= 1.0) return 100;
  return Math.round(((ratio - 0.5) / 0.5) * 100);
}

// 1.5-second non-overlapping windows, ranked by mean overall frame score
// ascending. Returns the 3 worst whose mean is at least 10 points below
// the chunk's overall score (filter out "the whole chunk was bad
// uniformly" cases that wouldn't yield a useful drill target). For each
// window, also identify the joint that diverged the most.
function findTroubleSpots(
  perFrame: Array<{
    tMs: number;
    score: number;
    perJoint: Record<JointName, number>;
    refVec: JointAngleVector;
    userVec: JointAngleVector;
  }>,
  overallScore: number,
): TroubleSpot[] {
  if (perFrame.length === 0) return [];
  const WINDOW_MS = 1500;
  const STEP_MS = 1500; // non-overlapping windows
  const t0 = perFrame[0]!.tMs;
  const tN = perFrame[perFrame.length - 1]!.tMs;
  const buckets: Array<{ startMs: number; endMs: number; items: typeof perFrame }> = [];
  for (let start = t0; start < tN; start += STEP_MS) {
    const end = Math.min(tN, start + WINDOW_MS);
    const items: typeof perFrame = [];
    for (const f of perFrame) {
      if (f.tMs >= start && f.tMs < end) items.push(f);
    }
    if (items.length > 0) buckets.push({ startMs: start, endMs: end, items });
  }
  const ranked = buckets
    .map((b) => ({
      startMs: b.startMs,
      endMs: b.endMs,
      score: mean(b.items.map((i) => i.score)),
      items: b.items,
    }))
    .sort((a, b) => a.score - b.score);

  const out: TroubleSpot[] = [];
  for (const b of ranked) {
    if (out.length >= 3) break;
    // Require the bucket to be meaningfully worse than the overall —
    // otherwise we'd just be listing arbitrary chunks of a uniformly
    // mediocre performance.
    if (b.score >= overallScore - 8) continue;
    const { worstJoint, worstJointDelta, message } = worstJointInBucket(b.items);
    out.push({
      startMs: b.startMs,
      endMs: b.endMs,
      score: Math.round(b.score),
      worstJoint,
      worstJointDelta,
      message,
    });
  }
  return out;
}

function worstJointInBucket(
  items: Array<{
    perJoint: Record<JointName, number>;
    refVec: JointAngleVector;
    userVec: JointAngleVector;
  }>,
): { worstJoint: JointName | null; worstJointDelta: number; message: string } {
  // The "worst joint" in a window is the one with the lowest mean per-joint
  // score AND the largest mean absolute angle delta. Both signals point at
  // the same joint normally; we use score-rank as the tie-breaker so we
  // don't pick a static joint that happens to be slightly off the
  // tolerance threshold.
  let worst: { joint: JointName; meanScore: number; meanDelta: number } | null = null;
  for (const k of JOINT_NAMES) {
    if (k === 'hip_rotation_y' || k === 'chest_forward_z') continue;
    let sumScore = 0;
    let sumDelta = 0;
    for (const it of items) {
      sumScore += it.perJoint[k] ?? 0;
      sumDelta += Math.abs((it.userVec[k] ?? 0) - (it.refVec[k] ?? 0));
    }
    const meanScore = sumScore / Math.max(1, items.length);
    const meanDelta = sumDelta / Math.max(1, items.length);
    if (!worst || meanScore < worst.meanScore) {
      worst = { joint: k, meanScore, meanDelta };
    }
  }
  if (!worst || worst.meanDelta < 10) {
    return { worstJoint: null, worstJointDelta: 0, message: 'rhythm slipped' };
  }
  const noun = HINT_PRETTY[worst.joint] ?? worst.joint;
  const deg = Math.round(worst.meanDelta);
  return {
    worstJoint: worst.joint,
    worstJointDelta: worst.meanDelta,
    message: `${noun} ${deg}° off`,
  };
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
