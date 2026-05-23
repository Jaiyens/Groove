import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { jointAngleAngularSimilarity } from '../lib/scoring/similarity.ts';
import type { JointAngleVector } from '../lib/pose/types.ts';

// SPECK overnight Group 5 (experimental) — per-joint angular agreement.
//
// The live callout tier had been firing GROOVY/PERFECT on essentially
// every beat because cosineSimilarity over JointAngleVector inputs
// saturates around 0.95-0.999 for any two normal-pose vectors (see
// /docs/callout-tier-diagnosis-overnight.md). The replacement metric
// here, 1 - mean(|Δangle|/π) over the 8 named joint angles, should
// spread the live tier output across the [0,1] band so the existing
// CALLOUT_THRESHOLDS produce a real mix of GROOVY/PERFECT/GREAT/ALMOST.

function vec(overrides: Partial<JointAngleVector> = {}): JointAngleVector {
  // Default to a "standing arms slightly bent" baseline pose. The
  // specific numbers don't matter — they just need to be inside the
  // [0, π] range that jointAngles.ts produces.
  return {
    left_elbow: 2.0,
    right_elbow: 2.0,
    left_shoulder: 1.0,
    right_shoulder: 1.0,
    left_hip: 2.8,
    right_hip: 2.8,
    left_knee: 2.8,
    right_knee: 2.8,
    torso_lean: 0.1,
    hip_rotation_y: 0,
    chest_forward_z: 0,
    ...overrides,
  };
}

describe('jointAngleAngularSimilarity — boundary values', () => {
  it('identical vectors score exactly 1.0', () => {
    const v = vec();
    assert.equal(jointAngleAngularSimilarity(v, v), 1);
  });

  it('vectors differing by π on every key score exactly 0.0', () => {
    const a = vec({
      left_elbow: 0, right_elbow: 0, left_shoulder: 0, right_shoulder: 0,
      left_hip: 0, right_hip: 0, left_knee: 0, right_knee: 0,
    });
    const b = vec({
      left_elbow: Math.PI, right_elbow: Math.PI,
      left_shoulder: Math.PI, right_shoulder: Math.PI,
      left_hip: Math.PI, right_hip: Math.PI,
      left_knee: Math.PI, right_knee: Math.PI,
    });
    assert.equal(jointAngleAngularSimilarity(a, b), 0);
  });

  it('result is always in [0, 1]', () => {
    // Even with wraparound nonsense, clamping at π keeps the result
    // non-negative.
    const a = vec({ left_elbow: -10 });
    const b = vec({ left_elbow: 10 });
    const s = jointAngleAngularSimilarity(a, b);
    assert.ok(s >= 0 && s <= 1, `got ${s}`);
  });
});

describe('jointAngleAngularSimilarity — predicted band-by-band response', () => {
  // The diagnosis doc predicts these bands at the current callout thresholds.
  // Pin them so a future tweak to the metric (or to the participating keys)
  // re-validates against the published table.

  function makePair(perJointDiffRad: number): [JointAngleVector, JointAngleVector] {
    const a = vec();
    const b: JointAngleVector = {
      ...a,
      left_elbow: a.left_elbow + perJointDiffRad,
      right_elbow: a.right_elbow + perJointDiffRad,
      left_shoulder: a.left_shoulder + perJointDiffRad,
      right_shoulder: a.right_shoulder + perJointDiffRad,
      left_hip: a.left_hip - perJointDiffRad,
      right_hip: a.right_hip - perJointDiffRad,
      left_knee: a.left_knee - perJointDiffRad,
      right_knee: a.right_knee - perJointDiffRad,
    };
    return [a, b];
  }

  it('~10° per-joint error → ~0.944 → GROOVY band', () => {
    const [a, b] = makePair(10 * Math.PI / 180);
    const s = jointAngleAngularSimilarity(a, b);
    assert.ok(s > 0.93 && s < 0.96, `expected ~0.944, got ${s}`);
  });

  it('~30° per-joint error → ~0.834 → PERFECT band', () => {
    const [a, b] = makePair(30 * Math.PI / 180);
    const s = jointAngleAngularSimilarity(a, b);
    assert.ok(s > 0.82 && s < 0.85, `expected ~0.834, got ${s}`);
  });

  it('~60° per-joint error → ~0.667 → GREAT band', () => {
    const [a, b] = makePair(60 * Math.PI / 180);
    const s = jointAngleAngularSimilarity(a, b);
    assert.ok(s > 0.65 && s < 0.685, `expected ~0.667, got ${s}`);
  });

  it('~90° per-joint error → ~0.500 → ALMOST band', () => {
    const [a, b] = makePair(90 * Math.PI / 180);
    const s = jointAngleAngularSimilarity(a, b);
    assert.ok(s > 0.49 && s < 0.51, `expected ~0.500, got ${s}`);
  });
});

describe('jointAngleAngularSimilarity — excludes torso/hip/chest', () => {
  it('massive torso_lean difference does not affect the score', () => {
    const a = vec();
    const b = vec({ torso_lean: Math.PI });
    assert.equal(jointAngleAngularSimilarity(a, b), 1);
  });

  it('hip_rotation_y diff does not affect the score', () => {
    const a = vec();
    const b = vec({ hip_rotation_y: 1.5 });
    assert.equal(jointAngleAngularSimilarity(a, b), 1);
  });

  it('chest_forward_z diff does not affect the score', () => {
    const a = vec();
    const b = vec({ chest_forward_z: 0.5 });
    assert.equal(jointAngleAngularSimilarity(a, b), 1);
  });
});
