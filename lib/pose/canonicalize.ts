// Canonical skeleton normalization — translate + scale (and optional
// rotate) every pose into a single body-unit coordinate frame so that
// downstream comparison (angles, positions, anything) works the same
// way regardless of how the body was framed in the source image.
//
// This is the SINGLE chokepoint where every skeleton — user or
// reference — enters the scoring pipeline. The SPECK Stage 1 audit
// found that scoring sites relied on "angles are invariant" holding for
// inputs from differently-framed images; in practice MediaPipe's
// normalized image-space coordinates can be anisotropic (1 unit of x ≠
// 1 unit of y in pixel space when the source aspect ratio is not 1:1),
// and image-space torso/limb scales differ by ~2x between the user's
// camera and the reference video. Canonicalization eliminates both.
//
// Algorithm:
//   1. pelvis = midpoint(LEFT_HIP=23, RIGHT_HIP=24)
//   2. translate every landmark by -pelvis
//   3. torso_length = ||midpoint(LEFT_SHOULDER=11, RIGHT_SHOULDER=12) − pelvis||
//      if torso_length < MIN_TORSO_LENGTH → return null (dropped frame)
//   4. divide every translated landmark by torso_length
//   5. if rotateToUpright: rotate the whole skeleton 2D so the shoulder
//      line is horizontal
//
// After this, pelvis_midpoint = (0,0,0) and torso_length = 1.0 in the
// canonical frame. Two bodies of vastly different image sizes / positions
// produce coordinate-compatible canonical skeletons.
//
// Pure TS — no DOM / no MediaPipe types. The PoseLandmark interface is
// our own (`lib/pose/types`), shaped exactly like a MediaPipe landmark
// but free of browser-only types. Ports cleanly to Swift.

import { LANDMARK, type PoseLandmark } from './types';

export interface CanonicalSkeleton {
  // 33 landmarks in canonical body units. pelvis_midpoint = (0,0,0),
  // torso_length = 1.0. Visibility is passed through unchanged.
  landmarks: PoseLandmark[];
  // Original (input-units) torso length. Useful for the body-relative
  // criterion evaluator (Stage 5) — meter thresholds in the skill graph
  // get converted into torso-length fractions using this value.
  torsoLength: number;
  // Original (input-units) shoulder-line length — distance between the
  // two shoulder landmarks. Different from torso length because it
  // measures across the shoulders rather than from hip to shoulder.
  shoulderWidth: number;
  // Original (input-units) pelvis midpoint.
  pelvis: { x: number; y: number; z: number };
  // Radians the skeleton was rotated by when rotateToUpright was set;
  // 0 otherwise.
  rotationApplied: number;
}

// MediaPipe-style minimal pose-result shape for the canonicalizer
// input. We accept either the raw image landmarks or world landmarks —
// both shapes match this interface. Calling code picks which one is
// appropriate for the comparison primitive at hand.
export interface PoseLike {
  landmarks: readonly PoseLandmark[];
}

export interface CanonicalizeOptions {
  // When true, the whole skeleton is rotated 2D so the shoulder line
  // becomes horizontal. Default false: angle-space comparison is
  // already rotation-tolerant; rotation only matters when we want
  // canonical render orientation or position-based comparison.
  rotateToUpright?: boolean;
}

// Below this torso length we treat the input as a dropped frame.
// 0.05 of input units — for normalized image landmarks (0..1) this is
// 5% of the frame's smaller axis; for world landmarks (meters) it's
// 5cm. Either is well below what a real human body produces and acts
// as a "degenerate / low confidence" sentinel.
const MIN_TORSO_LENGTH = 0.05;

// Minimum landmark visibility required for the four anchor landmarks
// (both hips + both shoulders) before canonicalization will proceed.
// Below this we drop the frame: a torso we can't see can't anchor a
// body frame.
const MIN_ANCHOR_VISIBILITY = 0.3;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
  };
}

function distance3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function canonicalizeSkeleton(
  raw: PoseLike | { landmarks: readonly PoseLandmark[] } | null | undefined,
  opts: CanonicalizeOptions = {},
): CanonicalSkeleton | null {
  if (!raw || !raw.landmarks || raw.landmarks.length < 33) return null;
  const lm = raw.landmarks;
  const Lh = lm[LANDMARK.LEFT_HIP];
  const Rh = lm[LANDMARK.RIGHT_HIP];
  const Ls = lm[LANDMARK.LEFT_SHOULDER];
  const Rs = lm[LANDMARK.RIGHT_SHOULDER];
  if (!Lh || !Rh || !Ls || !Rs) return null;
  if (
    (Lh.visibility ?? 1) < MIN_ANCHOR_VISIBILITY ||
    (Rh.visibility ?? 1) < MIN_ANCHOR_VISIBILITY ||
    (Ls.visibility ?? 1) < MIN_ANCHOR_VISIBILITY ||
    (Rs.visibility ?? 1) < MIN_ANCHOR_VISIBILITY
  ) {
    return null;
  }

  const pelvis = midpoint(Lh, Rh);
  const shoulderMid = midpoint(Ls, Rs);
  const torsoLength = distance3(shoulderMid, pelvis);
  if (!Number.isFinite(torsoLength) || torsoLength < MIN_TORSO_LENGTH) {
    return null;
  }
  const shoulderWidth = distance3(Ls, Rs);

  // Translate + scale.
  const inv = 1 / torsoLength;
  let landmarks: PoseLandmark[] = lm.map((p) => ({
    x: (p.x - pelvis.x) * inv,
    y: (p.y - pelvis.y) * inv,
    z: (p.z - pelvis.z) * inv,
    visibility: p.visibility ?? 1,
  }));

  let rotationApplied = 0;
  if (opts.rotateToUpright) {
    // Shoulder vector in the already-translated-and-scaled frame.
    const sl = landmarks[LANDMARK.LEFT_SHOULDER]!;
    const sr = landmarks[LANDMARK.RIGHT_SHOULDER]!;
    const sdx = sr.x - sl.x;
    const sdy = sr.y - sl.y;
    // Current angle of the (left→right) shoulder line measured from
    // the world +X axis. We rotate by -theta so the shoulder line
    // ends up along +X (horizontal).
    const theta = Math.atan2(sdy, sdx);
    rotationApplied = -theta;
    const c = Math.cos(rotationApplied);
    const s = Math.sin(rotationApplied);
    landmarks = landmarks.map((p) => ({
      x: c * p.x - s * p.y,
      y: s * p.x + c * p.y,
      z: p.z,
      visibility: p.visibility,
    }));
  }

  return {
    landmarks,
    torsoLength,
    shoulderWidth,
    pelvis: { x: pelvis.x, y: pelvis.y, z: pelvis.z },
    rotationApplied,
  };
}
