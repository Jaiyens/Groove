// Build reference JointAngleVector frames from a worker-produced pose
// data JSON. Used in Mode B as the actual ground truth for scoring,
// replacing the synthetic neutral-with-sway reference that was a
// placeholder.
//
// Pipeline per reference frame:
//   1. Take MediaPipe normalized image landmarks at timestamp t.
//   2. Mirror-flip them horizontally so the *reference dancer's*
//      anatomical right side maps to the user's anatomical right side
//      (the follow-along user is a mirror image of the dancer).
//   3. Run computeJointAngles() on those mirrored landmarks. computeJointAngles
//      expects world landmarks (meters), but the image landmarks are
//      already body-centered enough for joint angles to work — they're
//      angles, so the only thing that matters is the relative joint
//      geometry. We do convert: image y is "down" in MediaPipe so spine
//      direction comes out correct; the angleAt() and angleFromY math is
//      unit-agnostic.
//
// We expose two surfaces:
//   - buildReferenceSequence(data, startMs, endMs): full chunk sequence
//     for the final DTW score.
//   - referenceFrameAt(data, t): single live frame for the live score
//     readout during the run.
//
// hasRealReferenceFrames(data) lets the caller branch to a synthetic
// fallback for legacy dance rows that have no pose_data_url.

import { compute2DJointAngles } from '@/lib/pose/jointAngles';
import { mirrorLandmarksHorizontal } from '@/lib/pose/normalize';
import type { ReferencePoseData } from '@/lib/pose/referencePose';
import { landmarkAt } from '@/lib/pose/referencePose';
import type {
  FrameSample,
  JointAngleVector,
  LandmarkFrame,
  PoseLandmark,
} from '@/lib/pose/types';

export function hasRealReferenceFrames(
  data: ReferencePoseData | null | undefined,
): boolean {
  return !!data && data.frames.length > 0;
}

// Compute and cache reference joint-angle vectors per chunk so we don't
// recompute the entire sequence every frame. Key is "<chunkStart>-<chunkEnd>".
const sequenceCache = new WeakMap<ReferencePoseData, Map<string, FrameSample[]>>();

export function buildReferenceSequence(
  data: ReferencePoseData,
  chunkStartMs: number,
  chunkEndMs: number,
): FrameSample[] {
  const key = `${chunkStartMs}-${chunkEndMs}`;
  let perData = sequenceCache.get(data);
  if (!perData) {
    perData = new Map();
    sequenceCache.set(data, perData);
  }
  const cached = perData.get(key);
  if (cached) return cached;

  const out: FrameSample[] = [];
  for (const f of data.frames) {
    if (f.tMs < chunkStartMs || f.tMs >= chunkEndMs) continue;
    const v = vectorFromMirroredLandmarks(f.landmarks);
    if (!v) continue;
    out.push({ timestampMs: f.tMs, vector: v });
  }
  perData.set(key, out);
  return out;
}

export function referenceFrameAt(
  data: ReferencePoseData,
  tMs: number,
): JointAngleVector | null {
  const lm = landmarkAt(data, tMs);
  if (!lm) return null;
  return vectorFromMirroredLandmarks(lm);
}

// Same as `buildReferenceSequence` but returns LANDMARK frames for the
// Stage 4 canonical-angle pipeline instead of pre-computed angle
// vectors. Reference landmarks are mirror-flipped horizontally so the
// dancer's anatomical left maps to whichever side the user — looking
// at a CSS-mirrored selfie — calls left.
export function buildReferenceLandmarkSequence(
  data: ReferencePoseData,
  chunkStartMs: number,
  chunkEndMs: number,
): LandmarkFrame[] {
  const out: LandmarkFrame[] = [];
  for (const f of data.frames) {
    if (f.tMs < chunkStartMs || f.tMs >= chunkEndMs) continue;
    if (!f.landmarks || f.landmarks.length < 33) continue;
    out.push({
      timestampMs: f.tMs,
      landmarks: mirrorLandmarksHorizontal(f.landmarks),
    });
  }
  return out;
}

function vectorFromMirroredLandmarks(
  landmarks: PoseLandmark[],
): JointAngleVector | null {
  if (!landmarks || landmarks.length < 33) return null;
  const mirrored = mirrorLandmarksHorizontal(landmarks);
  // 2D variant: the worker JSON ships z=0 for every joint (YOLO COCO17
  // → MediaPipe33 conversion, see worker/pose.py:179-190). Use the
  // 2D-only joint-angle path so we don't compare a depth-zero reference
  // to a depth-real user — depth-dependent fields would contaminate
  // the cosine.
  return compute2DJointAngles(mirrored);
}
