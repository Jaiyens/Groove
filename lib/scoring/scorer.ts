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

import { canonicalizeSkeleton, type CanonicalSkeleton } from '@/lib/pose/canonicalize';
import {
  CANONICAL_JOINT_NAMES,
  jointAnglesFromCanonical,
  type CanonicalJointAngles,
  type CanonicalJointName,
} from '@/lib/pose/jointAngles';
import type { FrameSample, JointAngleVector, JointName, LandmarkFrame } from '@/lib/pose/types';
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
  // Legacy vector-frame inputs. Kept for the existing scorer tests
  // that build synthetic angle vectors directly (without a
  // corresponding landmark configuration). Production callers should
  // use the landmark-frame inputs instead.
  userFrames?: FrameSample[];
  referenceFrames?: FrameSample[];
  // Stage 4 canonical-angle pipeline inputs. When both are provided,
  // scoreSession canonicalizes each frame and runs the rebuilt scoring
  // path on the resulting joint-angle vectors. This is the path that
  // production code (Mode B test/full pages) uses; the Stage 6
  // calibration suite exercises this path with body-size-invariant
  // tests.
  userLandmarkFrames?: LandmarkFrame[];
  referenceLandmarkFrames?: LandmarkFrame[];
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
  // Stage 4 canonical-angle pipeline: when landmark frames are
  // provided we canonicalize → joint-angle vector → score on the
  // body-relative angle space. This is the path Mode B production +
  // the Stage 6 calibration suite use.
  if (
    input.userLandmarkFrames &&
    input.referenceLandmarkFrames &&
    (input.userLandmarkFrames.length > 0 || input.referenceLandmarkFrames.length > 0)
  ) {
    return scoreSessionFromLandmarks({
      userLandmarkFrames: input.userLandmarkFrames,
      referenceLandmarkFrames: input.referenceLandmarkFrames,
      beatGrid: input.beatGrid,
      skillIds: input.skillIds,
    });
  }
  const userFrames = input.userFrames ?? [];
  const referenceFrames = input.referenceFrames ?? [];
  const { beatGrid, skillIds } = input;
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

// =======================================================================
// Stage 4 — canonical-angle scoring pipeline
//
// Inputs: raw landmark frames (user + reference). Pipeline per SPECK.md:
//
//   for each (user frame F_u, ref frame F_r) aligned by DTW:
//     c_u = canonicalizeSkeleton(F_u)        // pelvis-origin, torso=1
//     c_r = canonicalizeSkeleton(F_r)
//     if either is null → dropped frame
//     a_u = jointAnglesFromCanonical(c_u)    // 11-dim radians vector
//     a_r = jointAnglesFromCanonical(c_r)
//     per_joint_diff[j] = |a_u[j] − a_r[j]|
//     per_joint_score[j] = max(0, 1 − (diff[j]/TOL[j])^2)
//     frame_score = sum(w[j] · per_joint_score[j]) / sum(w[j])
//
//   weights derived from per-joint variance of the reference angle
//   sequence (joints that move more get more weight — same idea as the
//   legacy variance-driven weighting, applied in radian-angle space).
//
// All thresholds live at module scope so the next calibration pass can
// tune them against real recordings without spelunking.
// =======================================================================

// Per-joint angular tolerance (radians). A user frame whose joint
// differs from the reference by this much scores 0 on that joint;
// closer in scores higher, quadratically.
//
//   0.35 rad ≈ 20° for limb joints (elbows / shoulders / hips / knees)
//   0.20 rad ≈ 11° for torsoLean (spine alignment is a tighter signal)
//   0.25 rad ≈ 14° for shoulderTilt / hipTilt (body-roll axis)
//
// Calibration targets:
//   - half_scale_perfect / translated_perfect → ≥ 95 (perfect canonical
//     match, only tolerance differences come from floating-point
//     residue ≈ 1e-15 rad — far below threshold).
//   - rotated_5deg_perfect → ≥ 90 (5° = 0.087 rad on shoulderTilt
//     against 0.25 tolerance → 1 − (0.087/0.25)^2 ≈ 0.88 → ~88 per
//     tilt joint; weighted overall stays near 95 because only the
//     tilt fields move).
export const CANONICAL_TOLERANCES: Record<CanonicalJointName, number> = {
  leftElbow: 0.35,
  rightElbow: 0.35,
  leftShoulder: 0.35,
  rightShoulder: 0.35,
  leftHip: 0.35,
  rightHip: 0.35,
  leftKnee: 0.35,
  rightKnee: 0.35,
  torsoLean: 0.20,
  shoulderTilt: 0.25,
  hipTilt: 0.25,
};

// Components grouping for the rebuilt scorer.
const CANONICAL_COMPONENT_JOINTS: Record<'arms' | 'legs' | 'body', CanonicalJointName[]> = {
  arms: ['leftElbow', 'rightElbow', 'leftShoulder', 'rightShoulder'],
  legs: ['leftHip', 'rightHip', 'leftKnee', 'rightKnee'],
  body: ['torsoLean', 'shoulderTilt', 'hipTilt'],
};

// Stage 4.4 timing tolerance: the fraction of total path length that
// each (user, reference) path point is allowed to drift off the
// diagonal before timing drops to 0. 0.10 ≈ 10% off-diagonal is the
// "10% of the dance" rule of thumb from the legacy DTW band.
const TIMING_TOLERANCE = 0.10;

// Floor and shape constants for variance-driven joint weighting on
// the canonical-angle vector. Mirrors the legacy `MIN_WEIGHT` from
// `lib/scoring/jointWeights.ts` but scoped to the new joint set.
const CANONICAL_MIN_WEIGHT = 0.05;

// Below this confidence, a per-joint contribution is treated as
// dropped — the joint's score and weight both go to 0 for that frame.
const PER_JOINT_CONFIDENCE_FLOOR = 0.3;

export interface CanonicalScoreSessionInput {
  userLandmarkFrames: LandmarkFrame[];
  referenceLandmarkFrames: LandmarkFrame[];
  beatGrid: BeatGrid;
  skillIds: string[];
}

// Per-joint score from an angular delta (radians), with quadratic
// falloff between 0 and the joint's tolerance.
export function canonicalPerJointScore(
  userAngle: number,
  refAngle: number,
  tolerance: number,
): number {
  if (tolerance <= 0) return 0;
  const d = Math.abs(userAngle - refAngle);
  if (!Number.isFinite(d)) return 0;
  if (d <= 0) return 1;
  if (d >= tolerance) return 0;
  const t = 1 - d / tolerance;
  return t * t;
}

export type CanonicalJointWeights = Record<CanonicalJointName, number>;

// Derive per-joint weights from the reference's angle-vector variance.
// Joints that don't move in the reference get the floor weight; joints
// that move a lot dominate. Output weights sum to N_joints so the
// average weight is 1 and the weighted mean stays comparable across
// chunks.
export function deriveCanonicalJointWeights(
  referenceAngles: CanonicalJointAngles[],
): CanonicalJointWeights {
  const w: CanonicalJointWeights = {} as CanonicalJointWeights;
  if (referenceAngles.length === 0) {
    for (const k of CANONICAL_JOINT_NAMES) w[k] = 1;
    return w;
  }
  const N = referenceAngles.length;
  const raw: Partial<Record<CanonicalJointName, number>> = {};
  for (const k of CANONICAL_JOINT_NAMES) {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += referenceAngles[i]![k] ?? 0;
    const mean = sum / N;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const d = (referenceAngles[i]![k] ?? 0) - mean;
      sq += d * d;
    }
    raw[k] = Math.sqrt(sq / N);
  }
  let totalRaw = 0;
  for (const k of CANONICAL_JOINT_NAMES) totalRaw += (raw[k] ?? 0) + CANONICAL_MIN_WEIGHT;
  const N_JOINTS = CANONICAL_JOINT_NAMES.length;
  const scale = N_JOINTS / Math.max(1e-9, totalRaw);
  for (const k of CANONICAL_JOINT_NAMES) {
    w[k] = ((raw[k] ?? 0) + CANONICAL_MIN_WEIGHT) * scale;
  }
  return w;
}

interface CanonicalCompareResult {
  perJoint: Record<CanonicalJointName, number>;
  overall: number; // 0..1
}

function compareCanonicalFrame(
  user: CanonicalJointAngles,
  reference: CanonicalJointAngles,
  weights: CanonicalJointWeights,
): CanonicalCompareResult {
  const perJoint: Record<CanonicalJointName, number> = {} as Record<CanonicalJointName, number>;
  let total = 0;
  let sumW = 0;
  for (const k of CANONICAL_JOINT_NAMES) {
    const conf = Math.min(user.confidence[k] ?? 1, reference.confidence[k] ?? 1);
    if (conf < PER_JOINT_CONFIDENCE_FLOOR) {
      perJoint[k] = 0;
      continue;
    }
    const s = canonicalPerJointScore(user[k], reference[k], CANONICAL_TOLERANCES[k]);
    perJoint[k] = s;
    const w = weights[k] ?? 0;
    total += s * w;
    sumW += w;
  }
  const overall = sumW > 0 ? total / sumW : 0;
  return { perJoint, overall };
}

// Local cost for the new DTW: weighted Euclidean over the angle
// vector. Returns a positive scalar; smaller = closer match.
function canonicalAngleDistance(
  a: CanonicalJointAngles,
  b: CanonicalJointAngles,
): number {
  let s = 0;
  for (const k of CANONICAL_JOINT_NAMES) {
    const d = a[k] - b[k];
    s += d * d;
  }
  return Math.sqrt(s);
}

// DTW for the canonical-angle path. Sakoe-Chiba band sized from the
// 220ms timing slack same as the legacy DTW window heuristic.
function canonicalDtw(
  userAngles: CanonicalJointAngles[],
  refAngles: CanonicalJointAngles[],
  windowSize: number,
): Array<[number, number]> {
  const N = userAngles.length;
  const M = refAngles.length;
  if (N === 0 || M === 0) return [];
  const w = Math.max(windowSize, Math.abs(N - M));
  const scaleNM = N / M;
  const D = new Float64Array(N * M);
  D.fill(Number.POSITIVE_INFINITY);
  const idx = (i: number, j: number) => i * M + j;
  for (let i = 0; i < N; i++) {
    const jLo = Math.max(0, Math.floor(i / scaleNM) - w);
    const jHi = Math.min(M - 1, Math.ceil(i / scaleNM) + w);
    for (let j = jLo; j <= jHi; j++) {
      if (Math.abs(i - j * scaleNM) > w) continue;
      const local = canonicalAngleDistance(userAngles[i]!, refAngles[j]!);
      if (i === 0 && j === 0) {
        D[idx(i, j)] = local;
        continue;
      }
      const a = i > 0 && j > 0 ? D[idx(i - 1, j - 1)]! : Number.POSITIVE_INFINITY;
      const b = i > 0 ? D[idx(i - 1, j)]! : Number.POSITIVE_INFINITY;
      const c = j > 0 ? D[idx(i, j - 1)]! : Number.POSITIVE_INFINITY;
      const minPrev = Math.min(a, b, c);
      D[idx(i, j)] = local + (Number.isFinite(minPrev) ? minPrev : Number.POSITIVE_INFINITY);
    }
  }
  const path: Array<[number, number]> = [];
  let i = N - 1;
  let j = M - 1;
  path.push([i, j]);
  while (i > 0 || j > 0) {
    if (i === 0) {
      j--;
    } else if (j === 0) {
      i--;
    } else {
      const a = D[idx(i - 1, j - 1)] ?? Number.POSITIVE_INFINITY;
      const b = D[idx(i - 1, j)] ?? Number.POSITIVE_INFINITY;
      const c = D[idx(i, j - 1)] ?? Number.POSITIVE_INFINITY;
      const min = Math.min(a, b, c);
      if (min === a) {
        i--;
        j--;
      } else if (min === b) {
        i--;
      } else {
        j--;
      }
    }
    path.push([i, j]);
  }
  path.reverse();
  return path;
}

// Timing score from DTW path (SPECK 4.4 formula):
//   1 - mean(|path[i].user/N − path[i].ref/M|) / timing_tolerance
function canonicalTimingScore(
  path: ReadonlyArray<readonly [number, number]>,
  N: number,
  M: number,
): number {
  if (path.length === 0 || N === 0 || M === 0) return 100;
  let total = 0;
  for (const [u, r] of path) {
    const off = Math.abs(u / Math.max(1, N - 1) - r / Math.max(1, M - 1));
    total += off;
  }
  const meanOff = total / path.length;
  const ratio = Math.min(1, meanOff / TIMING_TOLERANCE);
  return Math.round((1 - ratio) * 100);
}

function emptyCanonicalSessionScore(): SessionScore {
  return {
    overall: 0,
    beats: [],
    frames: [],
    perSkillScores: {},
    components: { arms: 0, legs: 0, body: 0, timing: 0 },
    troubleSpots: [],
  };
}

interface PerFrameRecord {
  tMs: number;
  score: number;
  perJoint: Record<CanonicalJointName, number>;
  refAngles: CanonicalJointAngles;
  userAngles: CanonicalJointAngles;
}

export function scoreSessionFromLandmarks(
  input: CanonicalScoreSessionInput,
): SessionScore {
  const { userLandmarkFrames, referenceLandmarkFrames, beatGrid, skillIds } = input;
  if (userLandmarkFrames.length === 0 || referenceLandmarkFrames.length === 0) {
    return emptyCanonicalSessionScore();
  }

  // 1. Canonicalize every input frame. Dropped (null) frames are
  // skipped — the SPECK contract says "skip frame, count as dropped".
  const userAngles: CanonicalJointAngles[] = [];
  const userTimes: number[] = [];
  for (const f of userLandmarkFrames) {
    const c = canonicalizeSkeleton({ landmarks: f.landmarks });
    if (!c) continue;
    userAngles.push(jointAnglesFromCanonical(c));
    userTimes.push(f.timestampMs);
  }
  const refAngles: CanonicalJointAngles[] = [];
  const refTimes: number[] = [];
  for (const f of referenceLandmarkFrames) {
    const c = canonicalizeSkeleton({ landmarks: f.landmarks });
    if (!c) continue;
    refAngles.push(jointAnglesFromCanonical(c));
    refTimes.push(f.timestampMs);
  }
  if (userAngles.length === 0 || refAngles.length === 0) {
    return emptyCanonicalSessionScore();
  }

  const weights = deriveCanonicalJointWeights(refAngles);

  // 2. DTW window: same 220ms slack as the legacy scorer, expressed
  // in path-index units.
  const dtwWindow = computeCanonicalDtwWindow(userTimes, refTimes);
  const path = canonicalDtw(userAngles, refAngles, dtwWindow);

  // 3. Per-(user, ref) pair scoring on the warp path.
  const frames: FrameScore[] = [];
  const jointTotals: Record<CanonicalJointName, number> = {} as Record<
    CanonicalJointName,
    number
  >;
  const jointCounts: Record<CanonicalJointName, number> = {} as Record<
    CanonicalJointName,
    number
  >;
  for (const k of CANONICAL_JOINT_NAMES) {
    jointTotals[k] = 0;
    jointCounts[k] = 0;
  }
  const perFrame: PerFrameRecord[] = [];

  for (const [u, r] of path) {
    const userA = userAngles[u]!;
    const refA = refAngles[r]!;
    const cmp = compareCanonicalFrame(userA, refA, weights);
    const score = Math.max(0, Math.min(100, cmp.overall * 100));
    const userT = userTimes[u]!;
    const beatIdx = Math.max(0, Math.floor(beatGrid.getBeatAt(userT)));
    // similarity in FrameScore is legacy — keep it as the same value as
    // the per-joint weighted overall (cmp.overall in [0,1]) so consumers
    // that read `similarity` see a comparable number.
    frames.push({ userIdx: u, refIdx: r, similarity: cmp.overall, score, beatIdx });
    for (const k of CANONICAL_JOINT_NAMES) {
      jointTotals[k] += cmp.perJoint[k];
      jointCounts[k] += 1;
    }
    perFrame.push({
      tMs: userT,
      score,
      perJoint: cmp.perJoint,
      refAngles: refA,
      userAngles: userA,
    });
  }

  // 4. Aggregate by beat.
  const byBeat = new Map<number, number[]>();
  for (const f of frames) {
    const arr = byBeat.get(f.beatIdx);
    if (arr) arr.push(f.score);
    else byBeat.set(f.beatIdx, [f.score]);
  }
  const beatIdxs = Array.from(byBeat.keys()).sort((a, b) => a - b);
  const beats: BeatScore[] = beatIdxs.map((idx) => {
    const xs = byBeat.get(idx)!;
    return { beatIdx: idx, score: meanArr(xs), frameCount: xs.length };
  });
  const overall = beats.length > 0 ? meanArr(beats.map((b) => b.score)) : 0;

  // 5. Components.
  const components: ComponentScores = {
    arms: meanCanonicalGroup(jointTotals, jointCounts, CANONICAL_COMPONENT_JOINTS.arms) * 100,
    legs: meanCanonicalGroup(jointTotals, jointCounts, CANONICAL_COMPONENT_JOINTS.legs) * 100,
    body: meanCanonicalGroup(jointTotals, jointCounts, CANONICAL_COMPONENT_JOINTS.body) * 100,
    timing: canonicalTimingScore(path, userAngles.length, refAngles.length),
  };

  // 6. Trouble spots: 1.5s non-overlapping windows ranked by mean
  // frame score, filtering to windows that are meaningfully worse
  // than overall.
  const troubleSpots = findCanonicalTroubleSpots(perFrame, overall);

  // 7. Per-skill: same uniform partition strategy as the legacy path.
  const perSkillScores = partitionBeatsToSkillsCanonical(beats, skillIds);

  // Map the canonical joint weights back to the legacy JointName for
  // SessionScore.jointWeights, which the UI reads. Use approximate
  // analogues for joints that exist in both vocabularies; map the
  // tilt joints onto torso_lean since there's no exact match.
  const legacyWeights: Record<JointName, number> = {
    left_elbow: weights.leftElbow,
    right_elbow: weights.rightElbow,
    left_shoulder: weights.leftShoulder,
    right_shoulder: weights.rightShoulder,
    left_hip: weights.leftHip,
    right_hip: weights.rightHip,
    left_knee: weights.leftKnee,
    right_knee: weights.rightKnee,
    torso_lean: weights.torsoLean,
    hip_rotation_y: 0,
    chest_forward_z: 0,
  };

  return {
    overall,
    beats,
    frames,
    perSkillScores,
    components,
    troubleSpots,
    jointWeights: legacyWeights,
  };
}

function meanArr(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function meanCanonicalGroup(
  totals: Record<CanonicalJointName, number>,
  counts: Record<CanonicalJointName, number>,
  group: CanonicalJointName[],
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

function computeCanonicalDtwWindow(userTimes: number[], refTimes: number[]): number {
  const candidate = Math.max(userTimes.length, refTimes.length);
  if (candidate < 4) return Math.max(1, candidate);
  const longest = userTimes.length >= refTimes.length ? userTimes : refTimes;
  const deltas: number[] = [];
  for (let i = 1; i < longest.length; i++) {
    deltas.push(longest[i]! - longest[i - 1]!);
  }
  if (deltas.length === 0) return Math.ceil(candidate * 0.1);
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)] ?? 0;
  if (median <= 0) return Math.ceil(candidate * 0.04);
  return Math.max(Math.abs(userTimes.length - refTimes.length), Math.ceil(220 / median));
}

function findCanonicalTroubleSpots(
  perFrame: PerFrameRecord[],
  overallScore: number,
): TroubleSpot[] {
  if (perFrame.length === 0) return [];
  const WINDOW_MS = 1500;
  const STEP_MS = 1500;
  const t0 = perFrame[0]!.tMs;
  const tN = perFrame[perFrame.length - 1]!.tMs;
  const buckets: Array<{ startMs: number; endMs: number; items: PerFrameRecord[] }> = [];
  for (let start = t0; start < tN; start += STEP_MS) {
    const end = Math.min(tN, start + WINDOW_MS);
    const items: PerFrameRecord[] = [];
    for (const f of perFrame) {
      if (f.tMs >= start && f.tMs < end) items.push(f);
    }
    if (items.length > 0) buckets.push({ startMs: start, endMs: end, items });
  }
  const ranked = buckets
    .map((b) => ({
      startMs: b.startMs,
      endMs: b.endMs,
      score: meanArr(b.items.map((i) => i.score)),
      items: b.items,
    }))
    .sort((a, b) => a.score - b.score);
  const out: TroubleSpot[] = [];
  for (const b of ranked) {
    if (out.length >= 3) break;
    if (b.score >= overallScore - 8) continue;
    const worst = worstCanonicalJointInBucket(b.items);
    out.push({
      startMs: b.startMs,
      endMs: b.endMs,
      score: Math.round(b.score),
      worstJoint: worst.legacyJoint,
      worstJointDelta: worst.meanDelta,
      message: worst.message,
    });
  }
  return out;
}

const CANONICAL_TO_LEGACY_JOINT: Partial<Record<CanonicalJointName, JointName>> = {
  leftElbow: 'left_elbow',
  rightElbow: 'right_elbow',
  leftShoulder: 'left_shoulder',
  rightShoulder: 'right_shoulder',
  leftHip: 'left_hip',
  rightHip: 'right_hip',
  leftKnee: 'left_knee',
  rightKnee: 'right_knee',
  torsoLean: 'torso_lean',
  // shoulderTilt + hipTilt have no exact legacy analogue. We map them
  // onto torso_lean for the trouble-spot label so the UI's pretty-name
  // dictionary still hits.
  shoulderTilt: 'torso_lean',
  hipTilt: 'torso_lean',
};

const CANONICAL_HINT_PRETTY: Record<CanonicalJointName, string> = {
  leftElbow: 'left elbow',
  rightElbow: 'right elbow',
  leftShoulder: 'left shoulder',
  rightShoulder: 'right shoulder',
  leftHip: 'left hip',
  rightHip: 'right hip',
  leftKnee: 'left knee',
  rightKnee: 'right knee',
  torsoLean: 'torso',
  shoulderTilt: 'shoulders',
  hipTilt: 'hips',
};

function worstCanonicalJointInBucket(items: PerFrameRecord[]): {
  legacyJoint: JointName | null;
  meanDelta: number;
  message: string;
} {
  let worst: { joint: CanonicalJointName; meanScore: number; meanDelta: number } | null = null;
  for (const k of CANONICAL_JOINT_NAMES) {
    let sumScore = 0;
    let sumDelta = 0;
    for (const it of items) {
      sumScore += it.perJoint[k] ?? 0;
      sumDelta += Math.abs((it.userAngles[k] ?? 0) - (it.refAngles[k] ?? 0));
    }
    const meanScore = sumScore / Math.max(1, items.length);
    const meanDelta = sumDelta / Math.max(1, items.length);
    if (!worst || meanScore < worst.meanScore) {
      worst = { joint: k, meanScore, meanDelta };
    }
  }
  // Convert mean-delta (radians) into degrees for the message so the
  // UI surface keeps reading natural.
  if (!worst || worst.meanDelta < 0.17) {
    return { legacyJoint: null, meanDelta: 0, message: 'rhythm slipped' };
  }
  const deg = Math.round((worst.meanDelta * 180) / Math.PI);
  return {
    legacyJoint: CANONICAL_TO_LEGACY_JOINT[worst.joint] ?? null,
    meanDelta: worst.meanDelta,
    message: `${CANONICAL_HINT_PRETTY[worst.joint]} ${deg}° off`,
  };
}

function partitionBeatsToSkillsCanonical(
  beats: BeatScore[],
  skillIds: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (skillIds.length === 0) return out;
  if (beats.length === 0) {
    for (const id of skillIds) out[id] = 0;
    return out;
  }
  const overall = meanArr(beats.map((b) => b.score));
  const B = beats.length;
  const K = skillIds.length;
  for (let k = 0; k < K; k++) {
    const start = Math.floor((k * B) / K);
    const end = Math.floor(((k + 1) * B) / K);
    const slice = beats.slice(start, end);
    const id = skillIds[k]!;
    out[id] = slice.length > 0 ? meanArr(slice.map((b) => b.score)) : overall;
  }
  return out;
}
