// Stage 4 of the SPECK mirror fix — handedness unit tests that would
// have caught the bug that shipped (user raises right hand →
// reference skeleton lifts left).
//
// The full_pipeline_handedness test is the one the manual UI failure
// reproduces in code. If it doesn't pass, Stage 3 isn't done.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorLandmarksHorizontal } from '../lib/pose/normalize.ts';
import { scoreSession } from '../lib/scoring/scorer.ts';
import type { BeatGrid } from '../lib/scoring/types.ts';
import { LANDMARK, type LandmarkFrame, type PoseLandmark } from '../lib/pose/types.ts';

function makeLandmarks(
  overrides: Record<number, Partial<PoseLandmark>> = {},
): PoseLandmark[] {
  const arr: PoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 1,
  }));
  for (const [idx, lm] of Object.entries(overrides)) {
    const i = Number(idx);
    if (arr[i]) arr[i] = { ...arr[i], ...lm };
  }
  return arr;
}

function beats(bpm: number): BeatGrid {
  const period = 60000 / bpm;
  return {
    bpm,
    startMs: 0,
    getBeatAt: (t) => t / period,
    msAtBeat: (b) => b * period,
  };
}

// Pose where the right wrist is raised (low y in MediaPipe normalized
// image coords; y increases downward, so "up" is small y). All other
// joints in a rest position. Anatomical right wrist = LANDMARK
// index 16, which in an UN-mirrored image of a person facing the
// camera lives on the LEFT side of the frame (low x).
function rightArmRaisedPose(): PoseLandmark[] {
  const pts: Record<number, { x: number; y: number }> = {
    [LANDMARK.LEFT_SHOULDER]: { x: 0.6, y: 0.30 },
    [LANDMARK.RIGHT_SHOULDER]: { x: 0.4, y: 0.30 },
    [LANDMARK.LEFT_ELBOW]: { x: 0.65, y: 0.45 },
    [LANDMARK.RIGHT_ELBOW]: { x: 0.35, y: 0.15 }, // raised — elbow up
    [LANDMARK.LEFT_WRIST]: { x: 0.70, y: 0.55 },
    [LANDMARK.RIGHT_WRIST]: { x: 0.30, y: 0.05 }, // raised — wrist up
    [LANDMARK.LEFT_HIP]: { x: 0.55, y: 0.55 },
    [LANDMARK.RIGHT_HIP]: { x: 0.45, y: 0.55 },
    [LANDMARK.LEFT_KNEE]: { x: 0.55, y: 0.75 },
    [LANDMARK.RIGHT_KNEE]: { x: 0.45, y: 0.75 },
    [LANDMARK.LEFT_ANKLE]: { x: 0.55, y: 0.95 },
    [LANDMARK.RIGHT_ANKLE]: { x: 0.45, y: 0.95 },
  };
  const overrides: Record<number, Partial<PoseLandmark>> = {};
  for (let i = 0; i < 33; i++) {
    const p = pts[i] ?? { x: 0.5, y: 0.5 };
    overrides[i] = { x: p.x, y: p.y, z: 0, visibility: 1 };
  }
  return makeLandmarks(overrides);
}

// Reference pose: teacher raises HER anatomical LEFT hand (the
// "mirror partner" to a user who raised their right). In an
// UN-mirrored frame of a person facing camera, anatomical left is on
// the RIGHT side of the frame (high x).
function teacherLeftArmRaisedPose(): PoseLandmark[] {
  const pts: Record<number, { x: number; y: number }> = {
    [LANDMARK.LEFT_SHOULDER]: { x: 0.6, y: 0.30 },
    [LANDMARK.RIGHT_SHOULDER]: { x: 0.4, y: 0.30 },
    [LANDMARK.LEFT_ELBOW]: { x: 0.65, y: 0.15 }, // raised — anatomical LEFT
    [LANDMARK.RIGHT_ELBOW]: { x: 0.35, y: 0.45 },
    [LANDMARK.LEFT_WRIST]: { x: 0.70, y: 0.05 }, // raised
    [LANDMARK.RIGHT_WRIST]: { x: 0.30, y: 0.55 },
    [LANDMARK.LEFT_HIP]: { x: 0.55, y: 0.55 },
    [LANDMARK.RIGHT_HIP]: { x: 0.45, y: 0.55 },
    [LANDMARK.LEFT_KNEE]: { x: 0.55, y: 0.75 },
    [LANDMARK.RIGHT_KNEE]: { x: 0.45, y: 0.75 },
    [LANDMARK.LEFT_ANKLE]: { x: 0.55, y: 0.95 },
    [LANDMARK.RIGHT_ANKLE]: { x: 0.45, y: 0.95 },
  };
  const overrides: Record<number, Partial<PoseLandmark>> = {};
  for (let i = 0; i < 33; i++) {
    const p = pts[i] ?? { x: 0.5, y: 0.5 };
    overrides[i] = { x: p.x, y: p.y, z: 0, visibility: 1 };
  }
  return makeLandmarks(overrides);
}

describe('mirrorLandmarksHorizontal — function correctness', () => {
  it('is an involution: mirror(mirror(x)) ≈ x within 1e-6', () => {
    const lm = rightArmRaisedPose();
    const twice = mirrorLandmarksHorizontal(mirrorLandmarksHorizontal(lm));
    assert.equal(twice.length, 33);
    for (let i = 0; i < 33; i++) {
      assert.ok(
        Math.abs(twice[i]!.x - lm[i]!.x) < 1e-6,
        `landmark[${i}].x: orig=${lm[i]!.x}, twice=${twice[i]!.x}`,
      );
      assert.ok(Math.abs(twice[i]!.y - lm[i]!.y) < 1e-6);
      assert.ok(Math.abs(twice[i]!.z - lm[i]!.z) < 1e-6);
    }
  });

  it('swaps labels correctly: after mirror, LEFT_WRIST holds original RIGHT_WRIST data with x negated', () => {
    const lm = rightArmRaisedPose();
    const m = mirrorLandmarksHorizontal(lm);
    // After mirror, the landmark at index LEFT_WRIST should be the
    // original landmark at index RIGHT_WRIST with x negated.
    const origRW = lm[LANDMARK.RIGHT_WRIST]!;
    const newLW = m[LANDMARK.LEFT_WRIST]!;
    assert.ok(
      Math.abs(newLW.x - -origRW.x) < 1e-6,
      `expected LEFT_WRIST.x = ${-origRW.x}, got ${newLW.x}`,
    );
    assert.ok(Math.abs(newLW.y - origRW.y) < 1e-6);
    // And the converse for shoulders + hips.
    const origRS = lm[LANDMARK.RIGHT_SHOULDER]!;
    const newLS = m[LANDMARK.LEFT_SHOULDER]!;
    assert.ok(Math.abs(newLS.x - -origRS.x) < 1e-6);
    const origRH = lm[LANDMARK.RIGHT_HIP]!;
    const newLH = m[LANDMARK.LEFT_HIP]!;
    assert.ok(Math.abs(newLH.x - -origRH.x) < 1e-6);
  });

  it('does both: negates x AND swaps labels (neither half alone is correct)', () => {
    const lm = rightArmRaisedPose();
    const m = mirrorLandmarksHorizontal(lm);
    // Negation check: original RIGHT_WRIST.x = 0.30; original
    // LEFT_WRIST.x = 0.70. After mirror, the data at index LEFT_WRIST
    // should be the right wrist's negated x = -0.30. If the function
    // only swapped labels without negating x, we'd see +0.30 here.
    // If it only negated x without swapping, we'd see -0.70 here.
    assert.equal(m[LANDMARK.LEFT_WRIST]!.x, -0.30);
  });
});

// Build a tiny 3-frame landmark sequence at 33ms intervals.
function tinySeq(pose: PoseLandmark[]): LandmarkFrame[] {
  return [
    { timestampMs: 0, landmarks: pose },
    { timestampMs: 33, landmarks: pose },
    { timestampMs: 66, landmarks: pose },
  ];
}

describe('user_right_lifts_reference_right — the unit-test version of the shipped bug', () => {
  it('identical-handedness frames score ≥ 95 (the scorer is mirror-agnostic)', () => {
    // Per SPECK Stage 4.1: construct a synthetic user landmark frame
    // where RIGHT_WRIST is raised. Construct a reference frame where
    // her RIGHT_WRIST is also raised. Pass through the scoring
    // pipeline DIRECTLY (no chokepoint mirror — the scorer + canonical
    // pipeline are supposed to be ignorant of mirror state, per
    // tiebreaker #2). Expect high per-joint score on right-arm
    // joints. This is what would have caught the shipped bug at the
    // scorer layer.
    const user = tinySeq(rightArmRaisedPose());
    const ref = tinySeq(rightArmRaisedPose());
    const r = scoreSession({
      userLandmarkFrames: user,
      referenceLandmarkFrames: ref,
      beatGrid: beats(120),
      skillIds: [],
    });
    assert.ok(r.overall >= 95, `expected identical-handedness ≥95, got ${r.overall}`);
  });
});

describe('full_pipeline_handedness — chokepoint-aware mirror copy', () => {
  it('user raises anatomical right; reference raises anatomical left (mirror partner) → ≥ 95', () => {
    // The complete UX scenario: user raises their physical right
    // hand. MediaPipe outputs landmarks where RIGHT_WRIST (index 16)
    // is raised. The chokepoint applies mirrorLandmarksHorizontal,
    // moving the raised wrist's data to index LEFT_WRIST. The
    // reference dancer at this beat has her anatomical left hand
    // raised (also LEFT_WRIST index, by anatomy — reference is never
    // mirrored). Post-chokepoint user and reference both have data
    // at LEFT_WRIST raised → the canonical scorer recognizes this as
    // a correct copy.
    const userMirrored = mirrorLandmarksHorizontal(rightArmRaisedPose());
    const refRaw = teacherLeftArmRaisedPose();
    const r = scoreSession({
      userLandmarkFrames: tinySeq(userMirrored),
      referenceLandmarkFrames: tinySeq(refRaw),
      beatGrid: beats(120),
      skillIds: [],
    });
    assert.ok(
      r.overall >= 95,
      `expected mirror-copy to score ≥95, got ${r.overall}`,
    );
  });
});
