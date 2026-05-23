// Leg-visibility detector. Reads MediaPipe pose frames captured during
// a Mode B attempt and returns whether the user's legs were in frame.
// We feed this to Gemini so it can downweight legs when the user
// filmed upper-body only (SPECK §windowing-fix Change 3).
//
// Legs are "visible" if knee+ankle landmarks (MediaPipe indices 25–28)
// were detected with confidence > 0.5 in at least 60% of frames where
// any pose was detected at all. The thresholds err on the generous
// side: if there's any doubt, treat legs as visible and let the
// reference scoring run normally.

import type { LandmarkFrame } from '@/lib/pose/types';

const LEG_LANDMARK_INDICES = [25, 26, 27, 28] as const;
const VISIBILITY_THRESHOLD = 0.5;
const FRAME_RATIO_THRESHOLD = 0.6;
const MIN_LEG_LANDMARKS_PER_FRAME = 3;

export function detectLegsVisible(poseFrames: readonly LandmarkFrame[]): boolean {
  // Default generous: no frames means we have no signal, so don't
  // hand Gemini a false "upper body only" hint.
  if (poseFrames.length === 0) return true;

  const framesWithLegsVisible = poseFrames.filter((frame) => {
    if (!frame.landmarks || frame.landmarks.length < 29) return false;
    let visibleCount = 0;
    for (const idx of LEG_LANDMARK_INDICES) {
      const lm = frame.landmarks[idx];
      if (lm && (lm.visibility ?? 0) > VISIBILITY_THRESHOLD) visibleCount++;
    }
    return visibleCount >= MIN_LEG_LANDMARKS_PER_FRAME;
  });

  return framesWithLegsVisible.length / poseFrames.length >= FRAME_RATIO_THRESHOLD;
}
