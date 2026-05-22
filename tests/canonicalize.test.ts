// Stage 2 — canonical skeleton invariance tests.
//
// THESE ARE NOT OPTIONAL. SPECK.md hard rule #8: "The canonicalization
// invariance unit tests are not optional. They are the proof that the
// bug is fixed." If any of these fail, do not move past Stage 2.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeSkeleton } from '../lib/pose/canonicalize.ts';
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

// A simple-but-realistic pose: head/shoulders above the hips,
// arms-out-T pose, ankles down. Lives in image-space-ish coords (0..1
// range, +y down). The unscaled-untranslated pose places its pelvis at
// (0, 0). For invariance tests we apply the (scale, offset) to EVERY
// landmark — including the unmapped ones that would otherwise stay at
// the origin and create false "the unmapped landmark moved" failures.
function basePose(
  scale = 1,
  offsetX = 0,
  offsetY = 0,
): PoseLandmark[] {
  const pts: Record<number, { x: number; y: number }> = {
    [LANDMARK.NOSE]: { x: 0, y: -0.40 },
    [LANDMARK.LEFT_SHOULDER]: { x: 0.10, y: -0.30 },
    [LANDMARK.RIGHT_SHOULDER]: { x: -0.10, y: -0.30 },
    [LANDMARK.LEFT_ELBOW]: { x: 0.30, y: -0.30 },
    [LANDMARK.RIGHT_ELBOW]: { x: -0.30, y: -0.30 },
    [LANDMARK.LEFT_WRIST]: { x: 0.50, y: -0.30 },
    [LANDMARK.RIGHT_WRIST]: { x: -0.50, y: -0.30 },
    [LANDMARK.LEFT_HIP]: { x: 0.06, y: 0.00 },
    [LANDMARK.RIGHT_HIP]: { x: -0.06, y: 0.00 },
    [LANDMARK.LEFT_KNEE]: { x: 0.06, y: 0.25 },
    [LANDMARK.RIGHT_KNEE]: { x: -0.06, y: 0.25 },
    [LANDMARK.LEFT_ANKLE]: { x: 0.06, y: 0.50 },
    [LANDMARK.RIGHT_ANKLE]: { x: -0.06, y: 0.50 },
  };
  // Default-unmapped landmarks share the pelvis position so the test
  // is comparing equivalent bodies, not a body whose unmapped joints
  // happen to sit at the origin.
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

function compareLandmarks(
  a: PoseLandmark[],
  b: PoseLandmark[],
  tol = 1e-6,
): void {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(
      Math.abs(a[i]!.x - b[i]!.x) < tol,
      `landmark[${i}].x mismatch: ${a[i]!.x} vs ${b[i]!.x}`,
    );
    assert.ok(
      Math.abs(a[i]!.y - b[i]!.y) < tol,
      `landmark[${i}].y mismatch: ${a[i]!.y} vs ${b[i]!.y}`,
    );
    assert.ok(
      Math.abs(a[i]!.z - b[i]!.z) < tol,
      `landmark[${i}].z mismatch: ${a[i]!.z} vs ${b[i]!.z}`,
    );
  }
}

describe('canonicalizeSkeleton — pelvis at origin, torso = 1', () => {
  it('places pelvis midpoint at (0,0,0)', () => {
    const c = canonicalizeSkeleton({ landmarks: basePose() });
    assert.ok(c, 'canonicalize returned null');
    const lh = c!.landmarks[LANDMARK.LEFT_HIP]!;
    const rh = c!.landmarks[LANDMARK.RIGHT_HIP]!;
    const px = (lh.x + rh.x) / 2;
    const py = (lh.y + rh.y) / 2;
    const pz = (lh.z + rh.z) / 2;
    assert.ok(Math.abs(px) < 1e-9, `pelvis.x = ${px}`);
    assert.ok(Math.abs(py) < 1e-9, `pelvis.y = ${py}`);
    assert.ok(Math.abs(pz) < 1e-9, `pelvis.z = ${pz}`);
  });

  it('makes torso length exactly 1.0 in canonical units', () => {
    const c = canonicalizeSkeleton({ landmarks: basePose() });
    assert.ok(c);
    const ls = c!.landmarks[LANDMARK.LEFT_SHOULDER]!;
    const rs = c!.landmarks[LANDMARK.RIGHT_SHOULDER]!;
    const smx = (ls.x + rs.x) / 2;
    const smy = (ls.y + rs.y) / 2;
    const smz = (ls.z + rs.z) / 2;
    const torso = Math.sqrt(smx * smx + smy * smy + smz * smz);
    assert.ok(Math.abs(torso - 1) < 1e-9, `torso = ${torso}`);
  });

  it('preserves visibility', () => {
    const lms = basePose();
    lms[LANDMARK.LEFT_WRIST] = { ...lms[LANDMARK.LEFT_WRIST]!, visibility: 0.42 };
    const c = canonicalizeSkeleton({ landmarks: lms });
    assert.equal(c!.landmarks[LANDMARK.LEFT_WRIST]!.visibility, 0.42);
  });
});

describe('canonicalizeSkeleton — scale invariance', () => {
  it('identical pose at 0.5x and 2.0x scale → identical canonical landmarks within 1e-6', () => {
    const a = canonicalizeSkeleton({ landmarks: basePose(0.5) });
    const b = canonicalizeSkeleton({ landmarks: basePose(2.0) });
    assert.ok(a && b);
    compareLandmarks(a!.landmarks, b!.landmarks);
  });

  it('records the original torso length so callers can recover input units', () => {
    const a = canonicalizeSkeleton({ landmarks: basePose(1.0) });
    const b = canonicalizeSkeleton({ landmarks: basePose(0.5) });
    assert.ok(a && b);
    assert.ok(
      Math.abs(a!.torsoLength - 2 * b!.torsoLength) < 1e-9,
      `torsoLength: a=${a!.torsoLength}, b=${b!.torsoLength}`,
    );
  });
});

describe('canonicalizeSkeleton — translation invariance', () => {
  it('identical pose at different image positions → identical canonical landmarks within 1e-6', () => {
    const a = canonicalizeSkeleton({ landmarks: basePose(1.0, 0, 0) });
    const b = canonicalizeSkeleton({ landmarks: basePose(1.0, 0.4, -0.2) });
    assert.ok(a && b);
    compareLandmarks(a!.landmarks, b!.landmarks);
  });

  it('records the original pelvis so callers can recover input units', () => {
    const a = canonicalizeSkeleton({ landmarks: basePose(1.0, 0.4, -0.2) });
    assert.ok(a);
    // Pelvis offset = (0.4, -0.2). In basePose the unscaled pelvis is
    // at (0,0), so the actual pelvis matches the applied offset.
    assert.ok(Math.abs(a!.pelvis.x - 0.4) < 1e-9, `pelvis.x = ${a!.pelvis.x}`);
    assert.ok(Math.abs(a!.pelvis.y - -0.2) < 1e-9, `pelvis.y = ${a!.pelvis.y}`);
  });
});

describe('canonicalizeSkeleton — combined scale + translation', () => {
  it('any (scale, offset) pair is canonicalized to the unit-torso, pelvis-origin frame', () => {
    const a = canonicalizeSkeleton({ landmarks: basePose(1.0, 0, 0) });
    const b = canonicalizeSkeleton({ landmarks: basePose(2.3, 0.7, -0.4) });
    assert.ok(a && b);
    compareLandmarks(a!.landmarks, b!.landmarks);
  });
});

describe('canonicalizeSkeleton — mirrored pose', () => {
  it('a horizontally mirrored input becomes the mirrored canonical pose', () => {
    // Build the same pose horizontally flipped (swap left↔right
    // anatomical landmark x sign by manually constructing a mirrored
    // base pose). We canonicalize both and confirm the canonical
    // forms are mirror images of each other.
    const a = canonicalizeSkeleton({ landmarks: basePose() });
    const flipped: PoseLandmark[] = basePose().map((p) => ({
      x: -p.x,
      y: p.y,
      z: p.z,
      visibility: p.visibility,
    }));
    const b = canonicalizeSkeleton({ landmarks: flipped });
    assert.ok(a && b);
    for (let i = 0; i < 33; i++) {
      // After canonicalization, b should have negated x relative to a
      // (since canonicalization is linear and we mirrored before
      // canonicalizing). Y and z preserved.
      assert.ok(
        Math.abs(a!.landmarks[i]!.x + b!.landmarks[i]!.x) < 1e-6,
        `mirror x[${i}]: ${a!.landmarks[i]!.x} vs ${b!.landmarks[i]!.x}`,
      );
      assert.ok(
        Math.abs(a!.landmarks[i]!.y - b!.landmarks[i]!.y) < 1e-6,
        `mirror y[${i}]: ${a!.landmarks[i]!.y} vs ${b!.landmarks[i]!.y}`,
      );
    }
  });
});

describe('canonicalizeSkeleton — degenerate frames', () => {
  it('returns null when torso length is below the floor', () => {
    // Everything at origin → torso length 0.
    const lm = makeLandmarks();
    const c = canonicalizeSkeleton({ landmarks: lm });
    assert.equal(c, null);
  });

  it('returns null when input has fewer than 33 landmarks', () => {
    const lm = makeLandmarks().slice(0, 10);
    const c = canonicalizeSkeleton({ landmarks: lm });
    assert.equal(c, null);
  });

  it('returns null when anchor landmarks are low-visibility', () => {
    const lm = basePose();
    lm[LANDMARK.LEFT_HIP] = { ...lm[LANDMARK.LEFT_HIP]!, visibility: 0.0 };
    const c = canonicalizeSkeleton({ landmarks: lm });
    assert.equal(c, null);
  });

  it('returns null on null / undefined input', () => {
    assert.equal(canonicalizeSkeleton(null), null);
    assert.equal(canonicalizeSkeleton(undefined), null);
  });
});

describe('canonicalizeSkeleton — rotateToUpright', () => {
  it('puts the shoulder line horizontal when rotateToUpright is set', () => {
    // Build a pose tilted ~30° to the right by rotating the base pose
    // before feeding it in.
    const theta = (30 * Math.PI) / 180;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const rotated: PoseLandmark[] = basePose().map((p) => ({
      x: c * p.x - s * p.y,
      y: s * p.x + c * p.y,
      z: p.z,
      visibility: p.visibility,
    }));
    const out = canonicalizeSkeleton(
      { landmarks: rotated },
      { rotateToUpright: true },
    );
    assert.ok(out);
    const ls = out!.landmarks[LANDMARK.LEFT_SHOULDER]!;
    const rs = out!.landmarks[LANDMARK.RIGHT_SHOULDER]!;
    // After rotateToUpright the shoulder line is along +X, so y should match.
    assert.ok(Math.abs(ls.y - rs.y) < 1e-9, `shoulder y mismatch: ${ls.y} vs ${rs.y}`);
  });

  it('rotationApplied = 0 by default', () => {
    const c = canonicalizeSkeleton({ landmarks: basePose() });
    assert.equal(c!.rotationApplied, 0);
  });
});
