import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dtw } from '../lib/scoring/dtw.ts';
import { cosineSimilarity, euclidean } from '../lib/scoring/similarity.ts';
import { JOINT_NAMES, type JointAngleVector } from '../lib/pose/types.ts';

function makeVec(overrides: Partial<JointAngleVector> = {}): JointAngleVector {
  const base: JointAngleVector = {
    left_elbow: 0,
    right_elbow: 0,
    left_shoulder: 0,
    right_shoulder: 0,
    left_hip: 0,
    right_hip: 0,
    left_knee: 0,
    right_knee: 0,
    torso_lean: 0,
    hip_rotation_y: 0,
    chest_forward_z: 0,
  };
  return { ...base, ...overrides };
}

function makeSequence(
  n: number,
  fn: (i: number) => Partial<JointAngleVector>,
): JointAngleVector[] {
  return Array.from({ length: n }, (_, i) => makeVec(fn(i)));
}

describe('cosine similarity', () => {
  it('is 1 for identical non-zero vectors', () => {
    const a = makeVec({ left_elbow: 90, right_elbow: 90 });
    assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-9);
  });

  it('is 0 for orthogonal vectors', () => {
    const a = makeVec({ left_elbow: 1 });
    const b = makeVec({ right_elbow: 1 });
    assert.equal(cosineSimilarity(a, b), 0);
  });
});

describe('dtw', () => {
  it('returns cost 0 for two identical sequences', () => {
    const seq = makeSequence(20, (i) => ({ left_elbow: 90 + i * 5 }));
    const result = dtw(seq, seq);
    assert.equal(result.cost, 0);
    assert.equal(result.path[0]![0], 0);
    assert.equal(result.path[0]![1], 0);
    const last = result.path[result.path.length - 1]!;
    assert.equal(last[0], 19);
    assert.equal(last[1], 19);
  });

  it('small cost for a shifted sequence', () => {
    const ref = makeSequence(30, (i) => ({ left_elbow: 90 + Math.sin(i * 0.4) * 30 }));
    const user = makeSequence(30, (i) => ({
      // shifted by 1 frame
      left_elbow: 90 + Math.sin((i - 1) * 0.4) * 30,
    }));
    const identity = dtw(ref, ref);
    const shifted = dtw(user, ref);
    assert.equal(identity.cost, 0);
    // DTW should align the shift without huge penalty
    assert.ok(shifted.cost < 50, `expected small cost, got ${shifted.cost}`);
  });

  it('larger cost when sequences diverge', () => {
    const ref = makeSequence(20, (i) => ({ left_elbow: 90 + i * 2 }));
    const user = makeSequence(20, (i) => ({ left_elbow: 90 - i * 5, left_knee: 180 - i * 8 }));
    const close = dtw(ref, ref);
    const far = dtw(user, ref);
    assert.equal(close.cost, 0);
    assert.ok(far.cost > 200, `expected large cost, got ${far.cost}`);
  });

  it('handles sequences of unequal length', () => {
    const a = makeSequence(15, (i) => ({ left_elbow: 90 + i }));
    const b = makeSequence(20, (i) => ({ left_elbow: 90 + i * 0.75 }));
    const r = dtw(a, b);
    assert.ok(Number.isFinite(r.cost));
    // path endpoints touch the matrix corners
    assert.equal(r.path[0]![0], 0);
    assert.equal(r.path[0]![1], 0);
    const last = r.path[r.path.length - 1]!;
    assert.equal(last[0], 14);
    assert.equal(last[1], 19);
  });

  it('handles empty inputs without throwing', () => {
    const r1 = dtw([], []);
    assert.equal(r1.cost, 0);
    assert.equal(r1.path.length, 0);
  });

  it('euclidean is 0 for identical vectors and positive otherwise', () => {
    const a = makeVec({ left_elbow: 90 });
    assert.equal(euclidean(a, a), 0);
    const b = makeVec({ left_elbow: 80 });
    assert.ok(euclidean(a, b) > 0);
  });

  it('JOINT_NAMES has 11 entries (matches JointAngleVector keys)', () => {
    assert.equal(JOINT_NAMES.length, 11);
  });
});
