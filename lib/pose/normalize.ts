// Canonical-body normalization for pose landmarks.
//
// Two pose streams (user + reference) need to live in the same coordinate
// space before they can be drawn on top of each other or used for any
// position-based comparison. MediaPipe's "image" landmarks vary with where
// the body is in frame and how far the camera is. Strategy:
//
//   1. Compute hip midpoint and shoulder midpoint from the input landmarks.
//   2. Treat the shoulder→hip distance as the body's "unit" — scale so
//      that distance is 1.0.
//   3. Translate hip midpoint to (0, 0).
//
// After this, an upright body roughly occupies a 1×2 box centered on the
// origin, regardless of who's posing or where they stand in frame. Mirror
// flipping is handled separately so we can mirror the reference to make
// it a follow-along partner.

import { LANDMARK, type PoseLandmark } from './types';

export interface NormalizedBody {
  // Same length as the input. Same visibility values copied through. x/y/z
  // are in canonical body units (1 ≈ shoulder-to-hip distance), centered
  // on the hip midpoint.
  landmarks: PoseLandmark[];
  // True if normalization had enough hip + shoulder visibility to proceed.
  // When false, the caller should hide the skeleton this frame.
  ok: boolean;
}

const MIN_VISIBILITY = 0.3;

export function normalizeToBody(
  landmarks: readonly PoseLandmark[] | null | undefined,
): NormalizedBody {
  if (!landmarks || landmarks.length < 33) return { landmarks: [], ok: false };
  const Lh = landmarks[LANDMARK.LEFT_HIP];
  const Rh = landmarks[LANDMARK.RIGHT_HIP];
  const Ls = landmarks[LANDMARK.LEFT_SHOULDER];
  const Rs = landmarks[LANDMARK.RIGHT_SHOULDER];
  if (!Lh || !Rh || !Ls || !Rs) return { landmarks: [], ok: false };
  if (
    (Lh.visibility ?? 0) < MIN_VISIBILITY ||
    (Rh.visibility ?? 0) < MIN_VISIBILITY ||
    (Ls.visibility ?? 0) < MIN_VISIBILITY ||
    (Rs.visibility ?? 0) < MIN_VISIBILITY
  ) {
    return { landmarks: [], ok: false };
  }
  const hipX = (Lh.x + Rh.x) / 2;
  const hipY = (Lh.y + Rh.y) / 2;
  const hipZ = (Lh.z + Rh.z) / 2;
  const shX = (Ls.x + Rs.x) / 2;
  const shY = (Ls.y + Rs.y) / 2;
  const shZ = (Ls.z + Rs.z) / 2;
  const dx = shX - hipX;
  const dy = shY - hipY;
  const dz = shZ - hipZ;
  const scale = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (scale < 1e-6) return { landmarks: [], ok: false };
  const out: PoseLandmark[] = landmarks.map((lm) => ({
    x: (lm.x - hipX) / scale,
    y: (lm.y - hipY) / scale,
    z: (lm.z - hipZ) / scale,
    visibility: lm.visibility ?? 1,
  }));
  return { landmarks: out, ok: true };
}

// Horizontally flip a normalized landmark set AND swap left/right
// labels. Used to convert a reference dancer (filmed normally) into the
// frame the user — who is mirroring the dancer — actually lives in.
//
// Mechanically:
//   - negate x for every landmark
//   - swap landmark indices for LEFT_* ↔ RIGHT_* pairs so a downstream
//     consumer that asks for LEFT_SHOULDER on the mirrored landmark set
//     gets the dancer's anatomical right shoulder (the one on the user's
//     "left" when they look at the dancer).
export function mirrorLandmarksHorizontal(
  landmarks: readonly PoseLandmark[] | null | undefined,
): PoseLandmark[] {
  if (!landmarks || landmarks.length === 0) return [];
  // Start by copying every landmark with x negated.
  const out: PoseLandmark[] = landmarks.map((lm) => ({
    x: -lm.x,
    y: lm.y,
    z: lm.z,
    visibility: lm.visibility ?? 1,
  }));
  // Swap left/right pairs in-place. Order matters: we're using the
  // negated copies so we can just swap indices.
  for (const [a, b] of LEFT_RIGHT_PAIRS) {
    const tmp = out[a]!;
    out[a] = out[b]!;
    out[b] = tmp;
  }
  return out;
}

const LEFT_RIGHT_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [LANDMARK.LEFT_EYE_INNER, LANDMARK.RIGHT_EYE_INNER],
  [LANDMARK.LEFT_EYE, LANDMARK.RIGHT_EYE],
  [LANDMARK.LEFT_EYE_OUTER, LANDMARK.RIGHT_EYE_OUTER],
  [LANDMARK.LEFT_EAR, LANDMARK.RIGHT_EAR],
  [LANDMARK.MOUTH_LEFT, LANDMARK.MOUTH_RIGHT],
  [LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER],
  [LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW],
  [LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST],
  [LANDMARK.LEFT_PINKY, LANDMARK.RIGHT_PINKY],
  [LANDMARK.LEFT_INDEX, LANDMARK.RIGHT_INDEX],
  [LANDMARK.LEFT_THUMB, LANDMARK.RIGHT_THUMB],
  [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
  [LANDMARK.LEFT_KNEE, LANDMARK.RIGHT_KNEE],
  [LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE],
  [LANDMARK.LEFT_HEEL, LANDMARK.RIGHT_HEEL],
  [LANDMARK.LEFT_FOOT_INDEX, LANDMARK.RIGHT_FOOT_INDEX],
];
