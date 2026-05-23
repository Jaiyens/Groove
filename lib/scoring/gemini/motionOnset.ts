// Motion-onset detection from a stream of frame-diff magnitudes.
//
// SPECK round-3 §Group-2: the reference video is a chunk window that still
// contains the source dancer's "walk back to camera" pre-roll. Telling
// Gemini "ignore the first 2 seconds" while showing it those 2 seconds did
// not work. Solution: cut the pre-roll before sending. Do the same on the
// attempt so both videos' t=0 aligns to the same choreography moment.
//
// Round-4 algorithm change: the round-3 "first sample exceeding 3× rolling
// baseline" rule was designed for "dead-air → first movement." Real
// reference videos are NOT dead-air at the start — they are continuous
// motion throughout (the dancer is already moving when the chunk window
// opens). In that regime the rolling baseline IS the motion itself, and
// no spike ever clears 3× baseline. Field data: sampleMean 7.9, sampleMax
// 15.3 — never crosses 3× (≈ 24).
//
// New rule: scan the entire window, take the windowed maximum, and return
// the first sample at or above `threshold × max` (default threshold 0.5).
// This generalizes both shapes:
//   - "Dead-air then movement" — the max lives in the motion region;
//     samples in the dead-air are well below 0.5 × max → onset lands on
//     the first motion frame, just like the old rule.
//   - "Continuous motion throughout" — the max lives at the loudest
//     frame; the very first frame is already ≥ 0.5 × max → onset lands
//     at the start of the window, which is correct: there is no pre-roll
//     to trim.
//
// `absoluteFloor` survives as a sanity guard: if even the windowed max is
// below it, the video is essentially still (pose extraction frozen, blank
// canvas, etc.) and we return null so the caller falls back to the legacy
// padded trim. The DOM harness in lib/scoring/gemini/client.ts samples
// 64×64 luminance frame-diffs at ~12 fps and feeds them here.

export interface MotionOnsetOptions {
  // Fraction of the windowed max that a sample must reach to count as
  // "onset." 0.5 means "as soon as we see anything at least half as
  // energetic as the loudest moment, that's the onset." 1.0 would mean
  // "the onset is the loudest moment itself"; 0.0 would mean "the first
  // sample is always the onset." Default 0.5.
  threshold?: number;
  // Floor on the windowed max. A 64×64 luminance-diff stream from a
  // completely still video clusters near 0; we require the max to clear
  // this floor before we trust the signal. Default 0.5 (raw luminance
  // diff units, see DOM harness for the per-pixel calc).
  absoluteFloor?: number;
}

const DEFAULTS: Required<MotionOnsetOptions> = {
  threshold: 0.5,
  absoluteFloor: 0.5,
};

// Returns the index of the first sample at or above `threshold × max`
// across the whole window, provided the max clears `absoluteFloor`.
// Returns null when the stream is empty or the entire window is below
// the floor (no meaningful motion to lock onto).
export function detectMotionOnsetIndex(
  samples: readonly number[],
  opts: MotionOnsetOptions = {},
): number | null {
  const { threshold, absoluteFloor } = { ...DEFAULTS, ...opts };
  if (samples.length === 0) return null;

  let max = -Infinity;
  for (const s of samples) if (s > max) max = s;

  // Stream is silent / blank / frozen — no motion to lock onto.
  if (max < absoluteFloor) return null;

  const cutoff = threshold * max;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] >= cutoff) return i;
  }
  // Unreachable in practice: the max itself satisfies (max ≥ cutoff)
  // for any threshold ≤ 1. Defensive null keeps the type system honest.
  return null;
}
