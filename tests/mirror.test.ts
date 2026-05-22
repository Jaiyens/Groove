// Stage 4 of the SPECK mirror fix — handedness unit tests that would
// have caught the bug that shipped (user raises right hand →
// reference skeleton lifts left).
//
// The full_pipeline_handedness test is the one the manual UI failure
// reproduces in code. If it doesn't pass, Stage 3 isn't done.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorLandmarksHorizontal, normalizeToBody } from '../lib/pose/normalize.ts';
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

describe('overlay_handedness — the visual property the manual UI check looks for', () => {
  // Stage 5 of the SPECK mirror fix asks for a human-loop verification:
  // "Raise your physical right hand. The reference skeleton must raise
  // the side that visually corresponds to your right hand in the
  // overlay." This test encodes that property programmatically:
  // after the chokepoint mirror on the user side and the no-mirror
  // pass-through on the reference side, both bodies' raised wrists in
  // canonical (overlay draw) space must land on the SAME screen side.
  //
  // The overlay projects canonical-x onto the canvas as
  //   pixel_x = anchorX_px + canonical_x * pixelScale
  // so canonical_x > 0 → screen-RIGHT of the anchor and < 0 → screen-LEFT.
  // The invariant: when the user raises their physical right and the
  // reference raises her anatomical left (mirror partner), both raised
  // wrists must yield canonical_x with the SAME SIGN. The visual
  // property holds iff that sign is consistent.

  function raisedWristCanonicalX(
    landmarks: PoseLandmark[],
  ): { left: number; right: number } {
    const norm = normalizeToBody(landmarks);
    if (!norm.ok) {
      throw new Error('normalizeToBody returned !ok in test setup');
    }
    return {
      left: norm.landmarks[LANDMARK.LEFT_WRIST]!.x,
      right: norm.landmarks[LANDMARK.RIGHT_WRIST]!.x,
    };
  }

  it('user-mirrored raised wrist and reference-raw raised wrist share screen side', () => {
    // User raises anatomical right hand. After chokepoint mirror:
    const userMirrored = mirrorLandmarksHorizontal(rightArmRaisedPose());
    const userCanonical = raisedWristCanonicalX(userMirrored);
    // The raised wrist's data now lives at LEFT_WRIST (the chokepoint
    // mirror moved it). LEFT_WRIST.y in user-mirrored canonical is
    // the raised one, so check LEFT_WRIST.x.

    // Reference: teacher raises anatomical left hand (mirror partner).
    const refRaw = teacherLeftArmRaisedPose();
    const refCanonical = raisedWristCanonicalX(refRaw);
    // Teacher's anatomical left is at index LEFT_WRIST in the raw
    // landmarks. So her raised wrist is also at LEFT_WRIST.

    // The visual property: both LEFT_WRIST.x values have the same
    // sign in canonical space, so the overlay draws both raised
    // wrists on the same screen side. THIS is the test that
    // captures the manual UI check.
    assert.ok(
      Math.sign(userCanonical.left) === Math.sign(refCanonical.left),
      `expected user LEFT_WRIST.x sign === ref LEFT_WRIST.x sign; ` +
        `got user=${userCanonical.left}, ref=${refCanonical.left}`,
    );
    // And same screen side means both are non-trivially displaced
    // from x=0 (the centerline) — not coincidentally both zero.
    assert.ok(
      Math.abs(userCanonical.left) > 0.1,
      `user raised wrist canonical x too close to centerline: ${userCanonical.left}`,
    );
    assert.ok(
      Math.abs(refCanonical.left) > 0.1,
      `ref raised wrist canonical x too close to centerline: ${refCanonical.left}`,
    );
  });

  it('NEGATIVE control: without the chokepoint mirror, the visual property breaks', () => {
    // If the user's landmarks are passed un-mirrored to the overlay
    // (the shipped bug), the user's raised wrist ends up at RIGHT_WRIST
    // index with the OPPOSITE x sign from the reference's raised
    // wrist at LEFT_WRIST. This is what produced the manual UI
    // symptom "I raise my right hand and the reference raises its
    // left." Pinning the negative case here so a future regression
    // that drops the chokepoint mirror is caught by the suite.
    const userRaw = rightArmRaisedPose();
    const userCanonical = raisedWristCanonicalX(userRaw);
    const refRaw = teacherLeftArmRaisedPose();
    const refCanonical = raisedWristCanonicalX(refRaw);
    // In the un-mirrored user, the raised wrist is at index RIGHT_WRIST.
    // Compare user-right to ref-left (the raised wrists on each side):
    assert.ok(
      Math.sign(userCanonical.right) !== Math.sign(refCanonical.left),
      `expected un-mirrored user RIGHT_WRIST.x sign to DIFFER from ref ` +
        `LEFT_WRIST.x sign (the bug); got user=${userCanonical.right}, ` +
        `ref=${refCanonical.left}`,
    );
  });
});

describe('score_rank_order — the programmatic version of Stage 5.3', () => {
  // SPECK Stage 5.3 asks the human to record three scores:
  //   - stand still, hands at sides
  //   - bad attempt, wrong moves
  //   - real attempt, best you can
  // and verify the rank order is good > bad > still with meaningful
  // gaps. We can't drive a real camera, but we CAN synthesize the
  // three landmark streams and assert the rank order programmatically.
  // If this fails, the manual Stage 5.3 attempt would also fail —
  // there's no way for live video to score correctly when synthetic
  // streams of the same shape don't.

  function restPose(): PoseLandmark[] {
    const pts: Record<number, { x: number; y: number }> = {
      [LANDMARK.LEFT_SHOULDER]: { x: 0.6, y: 0.30 },
      [LANDMARK.RIGHT_SHOULDER]: { x: 0.4, y: 0.30 },
      [LANDMARK.LEFT_ELBOW]: { x: 0.65, y: 0.45 },
      [LANDMARK.RIGHT_ELBOW]: { x: 0.35, y: 0.45 },
      [LANDMARK.LEFT_WRIST]: { x: 0.70, y: 0.55 },
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

  // A 5-second arm-swinging reference like the calibration suite uses.
  function armSwingingRefSeq(): LandmarkFrame[] {
    const dur = 5000;
    const fps = 30;
    const dt = 1000 / fps;
    const out: LandmarkFrame[] = [];
    for (let i = 0; i < dur / dt; i++) {
      const t = i * dt;
      const phase = (t / 1000) * 2 * Math.PI;
      const elbowDx = 0.20 * Math.cos(phase);
      const elbowDy = -0.15 * Math.sin(phase);
      const pts: Record<number, { x: number; y: number }> = {
        [LANDMARK.LEFT_SHOULDER]: { x: 0.6, y: 0.30 },
        [LANDMARK.RIGHT_SHOULDER]: { x: 0.4, y: 0.30 },
        [LANDMARK.LEFT_ELBOW]: { x: 0.60 + elbowDx, y: 0.30 + elbowDy },
        [LANDMARK.RIGHT_ELBOW]: { x: 0.40 - elbowDx, y: 0.30 + elbowDy },
        [LANDMARK.LEFT_WRIST]: { x: 0.60 + 2 * elbowDx, y: 0.30 + 2 * elbowDy },
        [LANDMARK.RIGHT_WRIST]: { x: 0.40 - 2 * elbowDx, y: 0.30 + 2 * elbowDy },
        [LANDMARK.LEFT_HIP]: { x: 0.55, y: 0.55 },
        [LANDMARK.RIGHT_HIP]: { x: 0.45, y: 0.55 },
        [LANDMARK.LEFT_KNEE]: { x: 0.55, y: 0.75 },
        [LANDMARK.RIGHT_KNEE]: { x: 0.45, y: 0.75 },
        [LANDMARK.LEFT_ANKLE]: { x: 0.55, y: 0.95 },
        [LANDMARK.RIGHT_ANKLE]: { x: 0.45, y: 0.95 },
      };
      const overrides: Record<number, Partial<PoseLandmark>> = {};
      for (let j = 0; j < 33; j++) {
        const p = pts[j] ?? { x: 0.5, y: 0.5 };
        overrides[j] = { x: p.x, y: p.y, z: 0, visibility: 1 };
      }
      out.push({ timestampMs: t, landmarks: makeLandmarks(overrides) });
    }
    return out;
  }

  function score(
    userFrames: LandmarkFrame[],
    refFrames: LandmarkFrame[],
  ): number {
    const r = scoreSession({
      userLandmarkFrames: userFrames,
      referenceLandmarkFrames: refFrames,
      beatGrid: beats(120),
      skillIds: [],
    });
    return r.overall;
  }

  it('good > bad > still with meaningful gaps', () => {
    const ref = armSwingingRefSeq();

    // "Stand still" — user holds rest pose throughout. Mirror-flipped
    // at the chokepoint so the comparison is in the same coordinate
    // frame as the running production pipeline.
    const stillRaw = restPose();
    const still: LandmarkFrame[] = ref.map((f) => ({
      timestampMs: f.timestampMs,
      landmarks: mirrorLandmarksHorizontal(stillRaw),
    }));

    // "Bad attempt — wrong moves" — user flails arms in random
    // positions, uncorrelated with the reference's oscillation.
    // Modeled on the legacy `random-arm-flailing` calibration test:
    // arms are moving (engaging the high-weighted joints) but in the
    // wrong shapes. Should score above stand-still (which has zero
    // arm motion at all) but well below a real attempt.
    let badSeed = 13;
    const badRand = () => {
      badSeed = (badSeed * 9301 + 49297) % 233280;
      return badSeed / 233280;
    };
    const bad: LandmarkFrame[] = ref.map((f) => {
      const lm = restPose();
      // Place wrists somewhere random within a wide envelope around
      // the shoulders, simulating "trying but flailing".
      const lWristDx = 0.20 * (badRand() - 0.5);
      const lWristDy = 0.30 * (badRand() - 0.5);
      const rWristDx = 0.20 * (badRand() - 0.5);
      const rWristDy = 0.30 * (badRand() - 0.5);
      lm[LANDMARK.LEFT_ELBOW] = {
        x: 0.60 + lWristDx * 0.5,
        y: 0.30 + lWristDy * 0.5,
        z: 0,
        visibility: 1,
      };
      lm[LANDMARK.RIGHT_ELBOW] = {
        x: 0.40 + rWristDx * 0.5,
        y: 0.30 + rWristDy * 0.5,
        z: 0,
        visibility: 1,
      };
      lm[LANDMARK.LEFT_WRIST] = {
        x: 0.60 + lWristDx,
        y: 0.30 + lWristDy,
        z: 0,
        visibility: 1,
      };
      lm[LANDMARK.RIGHT_WRIST] = {
        x: 0.40 + rWristDx,
        y: 0.30 + rWristDy,
        z: 0,
        visibility: 1,
      };
      return {
        timestampMs: f.timestampMs,
        landmarks: mirrorLandmarksHorizontal(lm),
      };
    });

    // "Real attempt" — user mirrors the reference with small noise.
    // The user's input would be RAW from MediaPipe (anatomical-correct
    // labels for the user's body). The reference is anatomically-correct
    // too. For a mirror-COPY, the user's anatomical-right traces the
    // same motion as the reference's anatomical-LEFT, i.e. the user's
    // raw landmarks look like a mirror-flipped reference. Simulate
    // that and apply the chokepoint mirror to make the comparison.
    let seed = 7;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const real: LandmarkFrame[] = ref.map((f) => {
      // User's raw input is the mirror of the reference (because
      // they're physically mirroring the move).
      const mirroredRef = mirrorLandmarksHorizontal(f.landmarks);
      const noisy = mirroredRef.map((p) => ({
        x: p.x + 0.012 * (rand() - 0.5),
        y: p.y + 0.012 * (rand() - 0.5),
        z: p.z,
        visibility: p.visibility,
      }));
      // Chokepoint applies mirror to user landmarks. The user's
      // "raw camera" input was the mirrored-reference (because they
      // physically mirror); the chokepoint mirrors AGAIN, getting us
      // back to reference-shaped data for comparison.
      return {
        timestampMs: f.timestampMs,
        landmarks: mirrorLandmarksHorizontal(noisy),
      };
    });

    const stillScore = score(still, ref);
    const badScore = score(bad, ref);
    const realScore = score(real, ref);

    // Rank order check.
    assert.ok(
      realScore > badScore,
      `expected real (${realScore}) > bad (${badScore})`,
    );
    assert.ok(
      badScore > stillScore,
      `expected bad (${badScore}) > still (${stillScore})`,
    );
    // Meaningful gaps (not 50/48/46).
    assert.ok(
      realScore - badScore >= 15,
      `expected real-bad gap ≥15, got ${realScore - badScore} (real=${realScore}, bad=${badScore})`,
    );
    assert.ok(
      badScore - stillScore >= 7,
      `expected bad-still gap ≥7, got ${badScore - stillScore} (bad=${badScore}, still=${stillScore})`,
    );
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
