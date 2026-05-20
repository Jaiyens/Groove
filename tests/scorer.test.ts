import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  correctionHint,
  frameScoreFromSimilarity,
  scoreSession,
} from '../lib/scoring/scorer.ts';
import type { BeatGrid } from '../lib/scoring/types.ts';
import type { FrameSample, JointAngleVector } from '../lib/pose/types.ts';

function makeVec(o: Partial<JointAngleVector> = {}): JointAngleVector {
  return {
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
    ...o,
  };
}

function fakeBeatGrid(bpm: number): BeatGrid {
  const period = 60000 / bpm;
  return {
    bpm,
    startMs: 0,
    getBeatAt(t: number) {
      return t / period;
    },
    msAtBeat(beat: number) {
      return beat * period;
    },
  };
}

function makeFrames(
  vec: JointAngleVector,
  count: number,
  dtMs = 33,
): FrameSample[] {
  return Array.from({ length: count }, (_, i) => ({
    timestampMs: i * dtMs,
    vector: vec,
  }));
}

describe('scorer', () => {
  it('frame_score(1.0) = 100', () => {
    assert.ok(Math.abs(frameScoreFromSimilarity(1.0) - 100) < 1e-9);
  });

  it('frame_score(0.0) = 100*e^-5 ≈ 0.67', () => {
    const got = frameScoreFromSimilarity(0);
    assert.ok(Math.abs(got - 100 * Math.exp(-5)) < 1e-9, `got ${got}`);
  });

  it('identical sequences give 100 overall', () => {
    const ref = makeFrames(makeVec({ left_elbow: 90, left_knee: 180 }), 30);
    const user = ref;
    const result = scoreSession({
      userFrames: user,
      referenceFrames: ref,
      beatGrid: fakeBeatGrid(120),
      skillIds: ['a', 'b'],
    });
    assert.ok(Math.abs(result.overall - 100) < 1e-6, `overall=${result.overall}`);
  });

  it('per-skill scores sum to skillIds entries', () => {
    const ref = makeFrames(makeVec({ left_elbow: 90 }), 40);
    const result = scoreSession({
      userFrames: ref,
      referenceFrames: ref,
      beatGrid: fakeBeatGrid(120),
      skillIds: ['s1', 's2', 's3', 's4'],
    });
    assert.deepEqual(
      Object.keys(result.perSkillScores).sort(),
      ['s1', 's2', 's3', 's4'],
    );
    for (const v of Object.values(result.perSkillScores)) {
      assert.ok(v > 90, `expected ~100, got ${v}`);
    }
  });

  it('empty inputs yield overall 0', () => {
    const r = scoreSession({
      userFrames: [],
      referenceFrames: [],
      beatGrid: fakeBeatGrid(120),
      skillIds: ['a'],
    });
    assert.equal(r.overall, 0);
  });

  it('diverged user gets a low score', () => {
    const ref = makeFrames(makeVec({ left_elbow: 90, left_knee: 180 }), 30);
    const user = makeFrames(makeVec({ left_elbow: -90, left_knee: -180 }), 30);
    const r = scoreSession({
      userFrames: user,
      referenceFrames: ref,
      beatGrid: fakeBeatGrid(120),
      skillIds: ['a'],
    });
    assert.ok(r.overall < 30, `expected low overall, got ${r.overall}`);
  });
});

describe('correctionHint', () => {
  it('returns null when frames are identical', () => {
    const v = makeVec({ left_elbow: 90 });
    assert.equal(correctionHint(v, v), null);
  });

  it('returns null when deviation is within tolerance', () => {
    const a = makeVec({ left_elbow: 90 });
    const b = makeVec({ left_elbow: 100 }); // 10° < 15° threshold
    assert.equal(correctionHint(a, b), null);
  });

  it('flags the worst joint when one deviates significantly', () => {
    const ref = makeVec({ left_elbow: 90, right_knee: 180 });
    const user = makeVec({ left_elbow: 90, right_knee: 90 }); // huge knee dev
    const hint = correctionHint(user, ref);
    assert.ok(hint);
    assert.equal(hint.joint, 'right_knee');
    assert.ok(hint.message.includes('knee'));
  });
});
