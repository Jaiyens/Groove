import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeJointAngles, vectorDistance } from '../lib/pose/jointAngles.ts';
import { LANDMARK, type PoseLandmark } from '../lib/pose/types.ts';

// Build a synthetic 33-landmark array. Defaults to all-zero; you can override
// specific indices. MediaPipe world coords are meters, origin at hip midpoint,
// +Y DOWN (head is at negative y).
function makeLandmarks(overrides: Record<number, Partial<PoseLandmark>> = {}): PoseLandmark[] {
  const arr: PoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 1,
  }));
  for (const [idx, lm] of Object.entries(overrides)) {
    const i = Number(idx);
    if (arr[i]) {
      arr[i] = { ...arr[i], ...lm };
    }
  }
  return arr;
}

const APPROX = 1.0; // tolerance in degrees for shape sanity

function approx(a: number, b: number, tol = APPROX): boolean {
  return Math.abs(a - b) <= tol;
}

describe('joint angles — T-pose', () => {
  // T-pose: body upright, arms straight out horizontal, legs straight down.
  // World coords: head/shoulders above hips (-y), knees/ankles below (+y).
  // Arms extend along ±x at shoulder height.
  // Hip / knee / ankle / shoulder share the same x-coordinate per side, so the
  // shoulder-hip-knee chain is colinear and the hip angle is exactly 180°.
  function tPose() {
    return makeLandmarks({
      [LANDMARK.LEFT_SHOULDER]: { x: 0.1, y: -0.5 },
      [LANDMARK.RIGHT_SHOULDER]: { x: -0.1, y: -0.5 },
      [LANDMARK.LEFT_ELBOW]: { x: 0.4, y: -0.5 },
      [LANDMARK.RIGHT_ELBOW]: { x: -0.4, y: -0.5 },
      [LANDMARK.LEFT_WRIST]: { x: 0.7, y: -0.5 },
      [LANDMARK.RIGHT_WRIST]: { x: -0.7, y: -0.5 },
      [LANDMARK.LEFT_HIP]: { x: 0.1, y: 0 },
      [LANDMARK.RIGHT_HIP]: { x: -0.1, y: 0 },
      [LANDMARK.LEFT_KNEE]: { x: 0.1, y: 0.5 },
      [LANDMARK.RIGHT_KNEE]: { x: -0.1, y: 0.5 },
      [LANDMARK.LEFT_ANKLE]: { x: 0.1, y: 1.0 },
      [LANDMARK.RIGHT_ANKLE]: { x: -0.1, y: 1.0 },
    });
  }

  it('elbows are straight (~180°)', () => {
    const a = computeJointAngles(tPose());
    assert.ok(approx(a.left_elbow, 180), `left_elbow=${a.left_elbow}`);
    assert.ok(approx(a.right_elbow, 180), `right_elbow=${a.right_elbow}`);
  });

  it('knees are straight (~180°)', () => {
    const a = computeJointAngles(tPose());
    assert.ok(approx(a.left_knee, 180), `left_knee=${a.left_knee}`);
    assert.ok(approx(a.right_knee, 180), `right_knee=${a.right_knee}`);
  });

  it('shoulders are ~90° (arm out perpendicular to torso)', () => {
    const a = computeJointAngles(tPose());
    // arm vector along +x, torso vector along -y -> angle is 90°
    assert.ok(approx(a.left_shoulder, 90, 3), `left_shoulder=${a.left_shoulder}`);
    assert.ok(approx(a.right_shoulder, 90, 3), `right_shoulder=${a.right_shoulder}`);
  });

  it('hips are ~180° (torso aligned with leg)', () => {
    const a = computeJointAngles(tPose());
    assert.ok(approx(a.left_hip, 180, 3), `left_hip=${a.left_hip}`);
    assert.ok(approx(a.right_hip, 180, 3), `right_hip=${a.right_hip}`);
  });

  it('torso lean ~0° (upright)', () => {
    const a = computeJointAngles(tPose());
    assert.ok(approx(a.torso_lean, 0, 2), `torso_lean=${a.torso_lean}`);
  });

  it('hip rotation ~180° (left hip is on +x facing the camera)', () => {
    // Our T-pose places LEFT_HIP on +x and RIGHT_HIP on -x. The vector from
    // L->R points to -x, so atan2(z=0, x=-1) = 180°. Same magnitude either way.
    const a = computeJointAngles(tPose());
    assert.ok(approx(Math.abs(a.hip_rotation_y), 180, 2), `hip_rotation_y=${a.hip_rotation_y}`);
  });

  it('chest_forward_z ~0 (chest above hips, no z offset)', () => {
    const a = computeJointAngles(tPose());
    assert.ok(Math.abs(a.chest_forward_z) < 0.01, `chest_forward_z=${a.chest_forward_z}`);
  });
});

describe('joint angles — bent elbow', () => {
  it('elbow at 90° when forearm goes perpendicular', () => {
    // Shoulder at (0,-0.5,0), elbow at (0.3,-0.5,0), wrist at (0.3,-0.8,0)
    // upper arm along +x, forearm along -y, angle at elbow = 90°.
    const lm = makeLandmarks({
      [LANDMARK.LEFT_SHOULDER]: { x: 0, y: -0.5, z: 0 },
      [LANDMARK.LEFT_ELBOW]: { x: 0.3, y: -0.5, z: 0 },
      [LANDMARK.LEFT_WRIST]: { x: 0.3, y: -0.8, z: 0 },
    });
    const a = computeJointAngles(lm);
    assert.ok(approx(a.left_elbow, 90), `left_elbow=${a.left_elbow}`);
  });
});

describe('vectorDistance', () => {
  it('is 0 for identical vectors', () => {
    const v = computeJointAngles(makeLandmarks());
    assert.equal(vectorDistance(v, v), 0);
  });

  it('grows with deviation (knee bent vs straight)', () => {
    const straight = makeLandmarks({
      [LANDMARK.LEFT_HIP]: { x: 0, y: 0 },
      [LANDMARK.LEFT_KNEE]: { x: 0, y: 0.5 },
      [LANDMARK.LEFT_ANKLE]: { x: 0, y: 1.0 },
    });
    const bent = makeLandmarks({
      [LANDMARK.LEFT_HIP]: { x: 0, y: 0 },
      [LANDMARK.LEFT_KNEE]: { x: 0, y: 0.5 },
      [LANDMARK.LEFT_ANKLE]: { x: 0.3, y: 0.5 }, // ankle kicked back -> 90° knee
    });
    const a = computeJointAngles(straight);
    const b = computeJointAngles(bent);
    const d = vectorDistance(a, b);
    assert.ok(d > 80, `expected large distance, got ${d}`);
  });
});
