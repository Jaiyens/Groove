// Per-joint weights, tolerances, and component grouping.
//
// Weighting strategy:
//   - For each chunk, the joints that move the MOST in the reference are
//     the joints the user has to get right. A joint that's static (e.g.,
//     knees during a hand-jive) is downweighted to near-zero so the user
//     isn't penalized for not perfectly aligning a part the dance isn't
//     using.
//   - We use the standard deviation of each joint angle across the
//     reference's chunk frames as the raw importance signal. Add a small
//     floor (so a totally-static joint still contributes a little) and
//     normalize across joints so weights sum to a sensible value.
//
// Component grouping:
//   - ARMS: elbows + shoulders.
//   - LEGS: hips + knees.
//   - BODY: torso_lean only — the spine angle is the cleanest single
//     signal for whether the user is leaning the right direction.
//   - TIMING: not joint-based; computed from the DTW path warping.

import type { FrameSample, JointAngleVector, JointName } from '@/lib/pose/types';
import { JOINT_NAMES } from '@/lib/pose/types';

export type JointWeights = Record<JointName, number>;
export type JointTolerances = Record<JointName, number>;

// Tolerance per joint, in the joint's native units. A user frame whose
// joint differs from the reference by exactly this many units scores 0
// on that joint. Smaller delta = higher per-joint score.
//
// Calibrated against typical dance variability: 45° on an elbow/knee
// flexion is a "totally wrong move", 20° on the spine is "you're leaning
// wrong". hip_rotation_y / chest_forward_z get a large tolerance because
// they're zeroed in 2D-only mode.
export const DEFAULT_TOLERANCES: JointTolerances = {
  left_elbow: 45,
  right_elbow: 45,
  left_shoulder: 45,
  right_shoulder: 45,
  left_hip: 45,
  right_hip: 45,
  left_knee: 45,
  right_knee: 45,
  torso_lean: 25,
  hip_rotation_y: 60,
  chest_forward_z: 0.3,
};

export const COMPONENT_JOINTS = {
  arms: ['left_elbow', 'right_elbow', 'left_shoulder', 'right_shoulder'] as JointName[],
  legs: ['left_hip', 'right_hip', 'left_knee', 'right_knee'] as JointName[],
  body: ['torso_lean'] as JointName[],
} as const;

const MIN_WEIGHT = 0.15; // floor so a fully static joint isn't ignored

// Variance-driven per-joint weights for a reference frame sequence.
// Returns weights that sum to JOINT_NAMES.length so the average weight
// across joints is 1.0 — making the units of weighted-mean comparable to
// unweighted-mean scores.
export function deriveJointWeights(referenceFrames: FrameSample[]): JointWeights {
  const weights: JointWeights = {} as JointWeights;
  if (referenceFrames.length === 0) {
    for (const k of JOINT_NAMES) weights[k] = 1;
    return weights;
  }
  const N = referenceFrames.length;
  const raw: Partial<Record<JointName, number>> = {};
  for (const k of JOINT_NAMES) {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += referenceFrames[i]!.vector[k] ?? 0;
    const mean = sum / N;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const d = (referenceFrames[i]!.vector[k] ?? 0) - mean;
      sq += d * d;
    }
    const stddev = Math.sqrt(sq / N);
    // For joints we hard-zero in 2D mode, stddev is exactly 0 — give
    // them no weight at all (they'd otherwise pull the floor in for free).
    if (k === 'hip_rotation_y' || k === 'chest_forward_z') {
      raw[k] = 0;
    } else {
      raw[k] = stddev;
    }
  }
  // Sum across all joints, add MIN_WEIGHT to nonzero rows, normalize so
  // the eligible joints' weights average to 1.
  let totalRaw = 0;
  let nEligible = 0;
  for (const k of JOINT_NAMES) {
    const r = raw[k]!;
    if (k === 'hip_rotation_y' || k === 'chest_forward_z') continue;
    totalRaw += r + MIN_WEIGHT;
    nEligible += 1;
  }
  const scale = nEligible > 0 ? nEligible / Math.max(1e-9, totalRaw) : 0;
  for (const k of JOINT_NAMES) {
    if (k === 'hip_rotation_y' || k === 'chest_forward_z') {
      weights[k] = 0;
    } else {
      weights[k] = ((raw[k] ?? 0) + MIN_WEIGHT) * scale;
    }
  }
  return weights;
}

// 0-1 per-joint score from an angle delta. 1 at zero delta, 0 at the
// joint's tolerance (and beyond), linear in between. We could go
// quadratic for smoother feel — saving for later if calibration says so.
export function perJointScore(
  userAngle: number,
  refAngle: number,
  tolerance: number,
): number {
  if (tolerance <= 0) return 0;
  const d = Math.abs(userAngle - refAngle);
  if (d <= 0) return 1;
  if (d >= tolerance) return 0;
  return 1 - d / tolerance;
}

// One-frame comparison: per-joint scores (0..1), weighted overall (0..1).
export interface FrameComparison {
  perJoint: Record<JointName, number>;
  overall: number; // 0..1
}

export function compareFrame(
  user: JointAngleVector,
  reference: JointAngleVector,
  weights: JointWeights,
  tolerances: JointTolerances = DEFAULT_TOLERANCES,
): FrameComparison {
  const perJoint: Record<JointName, number> = {} as Record<JointName, number>;
  let total = 0;
  let sumW = 0;
  for (const k of JOINT_NAMES) {
    const s = perJointScore(user[k] ?? 0, reference[k] ?? 0, tolerances[k]);
    perJoint[k] = s;
    const w = weights[k] ?? 0;
    total += s * w;
    sumW += w;
  }
  const overall = sumW > 0 ? total / sumW : 0;
  return { perJoint, overall };
}
