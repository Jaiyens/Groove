// Cosine similarity over joint-angle vectors. Pure TS — port to Swift directly.
//
// NOTE (SPECK overnight Group 5): cosineSimilarity over JointAngleVector
// inputs is structurally saturated for the live-callout use case — two
// normal-pose vectors almost always score 0.95-0.999 even when individual
// joints differ a lot. The post-attempt scorer side-steps this by
// computing per-joint weighted similarity via compareFrame() in
// scorer.ts; the live callout pipeline should use
// `jointAngleAngularSimilarity` (below) instead.
// See /docs/callout-tier-diagnosis-overnight.md for the math.

import { JOINT_NAMES, type JointAngleVector, type JointName } from '@/lib/pose/types';

export function cosineSimilarity(a: JointAngleVector, b: JointAngleVector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of JOINT_NAMES) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-9) return 0;
  return dot / denom;
}

// SPECK overnight Group 5 (experimental): per-joint angular agreement.
// For each of the 8 named joint angles, contributes `1 - |Δangle| / π`,
// then averages. Identical poses → 1.0; max-opposite poses → 0.0.
//
// Why this metric: cosineSimilarity over angle vectors saturates because
// every axis points in roughly the same direction for any pair of normal
// human poses (see /docs/callout-tier-diagnosis-overnight.md). Mean
// per-axis angular agreement, in contrast, responds linearly to per-joint
// differences and spreads across the full [0, 1] band on typical attempts.
//
// Why these 8 keys: torso_lean is a tiny near-zero angle dominated by
// noise; hip_rotation_y and chest_forward_z are zeroed when the user
// pipeline runs 2D landmarks (compute2DJointAngles). Keeping them would
// pull every sample close to 1.0 and partly re-introduce the saturation
// we're escaping.
const ANGULAR_SIMILARITY_KEYS: readonly JointName[] = [
  'left_elbow',
  'right_elbow',
  'left_shoulder',
  'right_shoulder',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
] as const;

export function jointAngleAngularSimilarity(
  a: JointAngleVector,
  b: JointAngleVector,
): number {
  let sum = 0;
  for (const k of ANGULAR_SIMILARITY_KEYS) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    const d = Math.abs(av - bv);
    // Clamp to π so a wraparound (e.g. -0.1 vs 3.04) doesn't push the
    // term negative. Angles produced by jointAngles.ts are in [0, π] so
    // this clamp is a safety belt, not a regular path.
    const clamped = Math.min(Math.PI, d);
    sum += 1 - clamped / Math.PI;
  }
  return sum / ANGULAR_SIMILARITY_KEYS.length;
}

// Euclidean distance over joint-angle vectors. Used as DTW local cost.
export function euclidean(a: JointAngleVector, b: JointAngleVector): number {
  let s = 0;
  for (const k of JOINT_NAMES) {
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    s += d * d;
  }
  return Math.sqrt(s);
}
