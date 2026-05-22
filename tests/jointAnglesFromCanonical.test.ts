// Stage 3 — joint-angle vector from canonical skeleton.
//
// The scale-invariance and translation-invariance tests in this file
// are the proof that the angle primitive itself doesn't reintroduce
// body-size sensitivity once the canonical chokepoint normalizes
// inputs. The combination — canonicalize then take angles — is what
// the Stage 6 calibration suite is going to lean on.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeSkeleton } from '../lib/pose/canonicalize.ts';
import { CANONICAL_JOINT_NAMES, jointAnglesFromCanonical } from '../lib/pose/jointAngles.ts';
import type { CanonicalJointName } from '../lib/pose/jointAngles.ts';
import { LANDMARK, type PoseLandmark } from '../lib/pose/types.ts';

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

// T-pose in image-space coords (+y down). Arms horizontal, legs
// straight down, body upright. Pelvis at (0, 0).
function tPose(scale = 1, offsetX = 0, offsetY = 0): PoseLandmark[] {
  const pts: Record<number, { x: number; y: number }> = {
    [LANDMARK.LEFT_SHOULDER]: { x: 0.10, y: -0.40 },
    [LANDMARK.RIGHT_SHOULDER]: { x: -0.10, y: -0.40 },
    [LANDMARK.LEFT_ELBOW]: { x: 0.30, y: -0.40 },
    [LANDMARK.RIGHT_ELBOW]: { x: -0.30, y: -0.40 },
    [LANDMARK.LEFT_WRIST]: { x: 0.50, y: -0.40 },
    [LANDMARK.RIGHT_WRIST]: { x: -0.50, y: -0.40 },
    // Hip / knee / ankle share the shoulder x so each side is a
    // perfectly vertical column — keeps the "T-pose hip and knee are
    // straight (~π)" assertion exact rather than approximate.
    [LANDMARK.LEFT_HIP]: { x: 0.10, y: 0.00 },
    [LANDMARK.RIGHT_HIP]: { x: -0.10, y: 0.00 },
    [LANDMARK.LEFT_KNEE]: { x: 0.10, y: 0.30 },
    [LANDMARK.RIGHT_KNEE]: { x: -0.10, y: 0.30 },
    [LANDMARK.LEFT_ANKLE]: { x: 0.10, y: 0.60 },
    [LANDMARK.RIGHT_ANKLE]: { x: -0.10, y: 0.60 },
  };
  const overrides: Record<number, Partial<PoseLandmark>> = {};
  for (let i = 0; i < 33; i++) {
    const p = pts[i] ?? { x: 0, y: 0 };
    overrides[i] = {
      x: p.x * scale + offsetX,
      y: p.y * scale + offsetY,
      z: 0,
      visibility: 1,
    };
  }
  return makeLandmarks(overrides);
}

// Arms-down rest pose: shoulders, elbows, wrists all stacked
// vertically (shoulder → elbow → wrist all along -y). Hips below.
function armsDownPose(scale = 1, offsetX = 0, offsetY = 0): PoseLandmark[] {
  const pts: Record<number, { x: number; y: number }> = {
    [LANDMARK.LEFT_SHOULDER]: { x: 0.10, y: -0.40 },
    [LANDMARK.RIGHT_SHOULDER]: { x: -0.10, y: -0.40 },
    [LANDMARK.LEFT_ELBOW]: { x: 0.10, y: -0.20 },
    [LANDMARK.RIGHT_ELBOW]: { x: -0.10, y: -0.20 },
    [LANDMARK.LEFT_WRIST]: { x: 0.10, y: 0.00 },
    [LANDMARK.RIGHT_WRIST]: { x: -0.10, y: 0.00 },
    // Hip / knee / ankle share the shoulder x so each side is a
    // perfectly vertical column — keeps the "T-pose hip and knee are
    // straight (~π)" assertion exact rather than approximate.
    [LANDMARK.LEFT_HIP]: { x: 0.10, y: 0.00 },
    [LANDMARK.RIGHT_HIP]: { x: -0.10, y: 0.00 },
    [LANDMARK.LEFT_KNEE]: { x: 0.10, y: 0.30 },
    [LANDMARK.RIGHT_KNEE]: { x: -0.10, y: 0.30 },
    [LANDMARK.LEFT_ANKLE]: { x: 0.10, y: 0.60 },
    [LANDMARK.RIGHT_ANKLE]: { x: -0.10, y: 0.60 },
  };
  const overrides: Record<number, Partial<PoseLandmark>> = {};
  for (let i = 0; i < 33; i++) {
    const p = pts[i] ?? { x: 0, y: 0 };
    overrides[i] = {
      x: p.x * scale + offsetX,
      y: p.y * scale + offsetY,
      z: 0,
      visibility: 1,
    };
  }
  return makeLandmarks(overrides);
}

function angles(lms: PoseLandmark[]) {
  const c = canonicalizeSkeleton({ landmarks: lms });
  assert.ok(c, 'canonicalize returned null in test setup');
  return jointAnglesFromCanonical(c!);
}

describe('jointAnglesFromCanonical — known poses', () => {
  it('T-pose: both shoulders at π/2 within 0.01 rad', () => {
    const a = angles(tPose());
    assert.ok(
      Math.abs(a.leftShoulder - Math.PI / 2) < 0.01,
      `leftShoulder=${a.leftShoulder}`,
    );
    assert.ok(
      Math.abs(a.rightShoulder - Math.PI / 2) < 0.01,
      `rightShoulder=${a.rightShoulder}`,
    );
  });

  it('T-pose: elbows are straight (~π)', () => {
    const a = angles(tPose());
    assert.ok(Math.abs(a.leftElbow - Math.PI) < 0.01, `leftElbow=${a.leftElbow}`);
    assert.ok(Math.abs(a.rightElbow - Math.PI) < 0.01, `rightElbow=${a.rightElbow}`);
  });

  it('T-pose: knees and hips are straight (~π)', () => {
    const a = angles(tPose());
    assert.ok(Math.abs(a.leftKnee - Math.PI) < 0.01, `leftKnee=${a.leftKnee}`);
    assert.ok(Math.abs(a.rightKnee - Math.PI) < 0.01, `rightKnee=${a.rightKnee}`);
    assert.ok(Math.abs(a.leftHip - Math.PI) < 0.01, `leftHip=${a.leftHip}`);
    assert.ok(Math.abs(a.rightHip - Math.PI) < 0.01, `rightHip=${a.rightHip}`);
  });

  it('T-pose: torsoLean ~ 0 (upright)', () => {
    const a = angles(tPose());
    assert.ok(Math.abs(a.torsoLean) < 0.01, `torsoLean=${a.torsoLean}`);
  });

  it('arms-down rest pose: shoulders near 0 (arm parallel to torso)', () => {
    const a = angles(armsDownPose());
    assert.ok(a.leftShoulder < 0.05, `leftShoulder=${a.leftShoulder}`);
    assert.ok(a.rightShoulder < 0.05, `rightShoulder=${a.rightShoulder}`);
  });

  it('right elbow flexed 90°: rightElbow ≈ π/2 ± 0.05', () => {
    // Shoulder-Elbow horizontal, then forearm perpendicular (down).
    const lms = tPose();
    lms[LANDMARK.RIGHT_SHOULDER] = { x: -0.10, y: -0.40, z: 0, visibility: 1 };
    lms[LANDMARK.RIGHT_ELBOW] = { x: -0.30, y: -0.40, z: 0, visibility: 1 };
    lms[LANDMARK.RIGHT_WRIST] = { x: -0.30, y: -0.20, z: 0, visibility: 1 };
    const a = angles(lms);
    assert.ok(
      Math.abs(a.rightElbow - Math.PI / 2) < 0.05,
      `rightElbow=${a.rightElbow}`,
    );
  });
});

describe('jointAnglesFromCanonical — invariance', () => {
  it('scale invariance: angles for 0.5x and 2.0x bodies match within 1e-6 rad', () => {
    const a = angles(tPose(0.5));
    const b = angles(tPose(2.0));
    for (const k of CANONICAL_JOINT_NAMES) {
      assert.ok(
        Math.abs(a[k] - b[k]) < 1e-6,
        `${k}: 0.5x=${a[k]} vs 2.0x=${b[k]}`,
      );
    }
  });

  it('translation invariance: angles for offset pose match within 1e-6 rad', () => {
    const a = angles(tPose(1.0, 0, 0));
    const b = angles(tPose(1.0, 0.4, -0.2));
    for (const k of CANONICAL_JOINT_NAMES) {
      assert.ok(
        Math.abs(a[k] - b[k]) < 1e-6,
        `${k}: at-origin=${a[k]} vs offset=${b[k]}`,
      );
    }
  });

  it('combined scale + translation invariance', () => {
    const a = angles(tPose(1.0, 0, 0));
    const b = angles(tPose(2.3, 0.7, -0.4));
    for (const k of CANONICAL_JOINT_NAMES) {
      assert.ok(
        Math.abs(a[k] - b[k]) < 1e-6,
        `${k}: ref=${a[k]} vs scaled+translated=${b[k]}`,
      );
    }
  });
});

describe('jointAnglesFromCanonical — confidence', () => {
  it('per-joint confidence = min(visibility) across the joint\'s landmarks', () => {
    const lms = tPose();
    lms[LANDMARK.LEFT_WRIST] = { ...lms[LANDMARK.LEFT_WRIST]!, visibility: 0.2 };
    lms[LANDMARK.LEFT_ELBOW] = { ...lms[LANDMARK.LEFT_ELBOW]!, visibility: 0.9 };
    lms[LANDMARK.LEFT_SHOULDER] = { ...lms[LANDMARK.LEFT_SHOULDER]!, visibility: 0.8 };
    const a = angles(lms);
    assert.equal(a.confidence.leftElbow, 0.2);
  });

  it('every angle field has a confidence entry', () => {
    const a = angles(tPose());
    for (const k of CANONICAL_JOINT_NAMES) {
      assert.ok(
        typeof a.confidence[k as CanonicalJointName] === 'number',
        `missing confidence for ${k}`,
      );
    }
  });
});
