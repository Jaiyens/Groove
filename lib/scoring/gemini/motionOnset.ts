// Motion-onset detection from a stream of frame-diff magnitudes.
//
// SPECK round-3 §Group-2: the reference video is a chunk window that still
// contains the source dancer's "walk back to camera" pre-roll. The prompt
// was being told "ignore the first 2 seconds" while still being shown those
// seconds — Gemini does not reliably obey "ignore what I'm showing you."
// Solution: cut the pre-roll before sending. Do the same on the attempt so
// both videos' t=0 aligns to the same choreography moment.
//
// This module is intentionally pure (no DOM, no canvas) so the threshold
// logic can be unit-tested without a browser harness. The DOM side — frame
// sampling at 64×64 grayscale, frame-diff computation — lives in
// lib/scoring/gemini/client.ts and feeds samples here.

export interface MotionOnsetOptions {
  // Number of samples used to compute the rolling baseline that the current
  // sample is compared against. 3 is the minimum that lets us require some
  // pre-roll context; default 3 keeps detection fast on short pre-rolls.
  baselineWindow?: number;
  // Onset requires currentSample > multiplier × baseline. Spec: 3×.
  multiplier?: number;
  // Floor on the absolute sample value before we'll call it an onset. A
  // 3× ratio against a near-zero baseline is meaningless if the absolute
  // diff is also near zero — encoder noise or sensor jitter would fire it.
  absoluteFloor?: number;
}

const DEFAULTS: Required<MotionOnsetOptions> = {
  baselineWindow: 3,
  multiplier: 3,
  absoluteFloor: 0.5,
};

// Returns the index of the first sample whose value exceeds `multiplier ×
// rolling-baseline` AND clears `absoluteFloor`. The baseline is the mean of
// the previous `baselineWindow` samples. Returns null when no onset is found
// (e.g. a steady-state video or a too-short stream).
//
// Indexing convention: sample[i] is the frame-diff magnitude AT time index i.
// Callers map index → seconds via the sampling interval.
export function detectMotionOnsetIndex(
  samples: readonly number[],
  opts: MotionOnsetOptions = {},
): number | null {
  const { baselineWindow, multiplier, absoluteFloor } = { ...DEFAULTS, ...opts };
  if (samples.length < baselineWindow + 1) return null;

  for (let i = baselineWindow; i < samples.length; i++) {
    let sum = 0;
    for (let j = i - baselineWindow; j < i; j++) sum += samples[j];
    const baseline = sum / baselineWindow;
    const current = samples[i];

    if (current < absoluteFloor) continue;

    // Baseline-zero edge case: a perfectly still pre-roll has baseline ≈ 0,
    // so the ratio test is undefined. Any sample clearing absoluteFloor here
    // is onset.
    if (baseline <= 0) return i;
    if (current > multiplier * baseline) return i;
  }
  return null;
}
