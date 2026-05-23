import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMotionOnsetIndex } from '../lib/scoring/gemini/motionOnset.ts';

// Round-4 algorithm: "first sample at or above threshold × windowed-max,
// provided the max clears absoluteFloor." The DOM harness in
// lib/scoring/gemini/client.ts samples 64×64 luminance diffs and feeds them
// here. These cases pin both shapes the algorithm has to serve — the
// round-3 "dead-air then motion" pre-roll, and the round-4 "continuous
// motion throughout" reference clip that the old 3× baseline rule missed.

describe('detectMotionOnsetIndex — dead-air → motion (round-3 shape)', () => {
  it('flat-zero pre-roll then a spike: onset is the first spike index', () => {
    // max=50, cutoff=25 (default threshold 0.5). First sample ≥ 25 is index 4.
    const samples = [0, 0, 0, 0, 50, 50, 50];
    assert.equal(detectMotionOnsetIndex(samples), 4);
  });

  it('low-noise pre-roll then a clear lift: onset is the lift index', () => {
    // max=5, cutoff=2.5. First sample ≥ 2.5 is index 4.
    const samples = [1, 1, 1, 1, 5, 5];
    assert.equal(detectMotionOnsetIndex(samples), 4);
  });

  it('baseline-zero then any clear-the-floor motion: onsets at the motion', () => {
    // max=1, cutoff=0.5 (default). First ≥ 0.5 is index 3.
    const samples = [0, 0, 0, 1, 1, 1];
    assert.equal(detectMotionOnsetIndex(samples), 3);
  });

  it('"walk-in then settle then hit" picks the hit, not the walk-in', () => {
    // Real walk-back-to-camera shape: light steady motion (~2),
    // a brief still moment (~0.6), then the choreography hits (~8).
    // max=8, cutoff=4. First sample ≥ 4 is index 8 (the hit).
    const samples = [
      2, 2, 2, 2, 2,
      0.6, 0.6, 0.6,
      8, 7, 8,
    ];
    assert.equal(detectMotionOnsetIndex(samples), 8);
  });
});

describe('detectMotionOnsetIndex — continuous motion (round-4 shape)', () => {
  it('flat-but-high stream onsets at index 0 (no pre-roll to trim)', () => {
    // The case the old 3× rolling-baseline rule failed: real reference
    // videos are 100% motion throughout. max=5, cutoff=2.5. Every sample
    // ≥ 2.5 → onset 0.
    const samples = [5, 5, 5, 5, 5];
    assert.equal(detectMotionOnsetIndex(samples), 0);
  });

  it("noisy continuous-motion mirrors the field log shape (mean≈8, max≈15)", () => {
    // Round-4 production data: sampleMean ≈ 7.9, sampleMax ≈ 15.3. The
    // synthesized stream below has the same shape — varying but never
    // quiet. max=15, cutoff=7.5. First sample ≥ 7.5 is index 1 (value 8).
    const samples = [5, 8, 7, 12, 15, 10, 8, 9];
    assert.equal(detectMotionOnsetIndex(samples), 1);
  });

  it('gradual rise onsets when the curve first crosses half the peak', () => {
    // max=5, cutoff=2.5. First sample ≥ 2.5 is index 2 (value 3).
    const samples = [1, 2, 3, 4, 5];
    assert.equal(detectMotionOnsetIndex(samples), 2);
  });

  it('spike then dropoff onsets at the spike, not after', () => {
    // max=10, cutoff=5. First ≥ 5 is index 2.
    const samples = [1, 1, 10, 1, 1];
    assert.equal(detectMotionOnsetIndex(samples), 2);
  });
});

describe('detectMotionOnsetIndex — absoluteFloor guard', () => {
  it('returns null when the windowed max is below the absolute floor', () => {
    // Stream is essentially silent. max=0.3 < default floor 0.5 → null.
    const samples = [0.1, 0.1, 0.1, 0.2, 0.3, 0.2];
    assert.equal(detectMotionOnsetIndex(samples), null);
  });

  it('respects a caller-tuned absoluteFloor', () => {
    // max=2, but caller requires the stream's loudest moment to clear 5.
    const samples = [2, 2, 2];
    assert.equal(detectMotionOnsetIndex(samples, { absoluteFloor: 5 }), null);
  });

  it('clears the floor with a single qualifying sample', () => {
    const samples = [10];
    assert.equal(detectMotionOnsetIndex(samples), 0);
  });
});

describe('detectMotionOnsetIndex — edge cases', () => {
  it('returns null for an empty stream', () => {
    assert.equal(detectMotionOnsetIndex([]), null);
  });

  it('returns null when the single sample is below the floor', () => {
    assert.equal(detectMotionOnsetIndex([0.1]), null);
  });

  it('honors a custom threshold (0.9 = "near peak")', () => {
    // max=10, cutoff=9. First sample ≥ 9 is index 2.
    const samples = [1, 5, 10];
    assert.equal(detectMotionOnsetIndex(samples, { threshold: 0.9 }), 2);
  });

  it('honors threshold=0 → onset is index 0 if floor is cleared', () => {
    const samples = [3, 5, 10];
    assert.equal(detectMotionOnsetIndex(samples, { threshold: 0 }), 0);
  });

  it('handles two equal-max samples by picking the earlier index', () => {
    // max=10, cutoff=5. First ≥ 5 is index 0.
    const samples = [10, 5, 10, 5];
    assert.equal(detectMotionOnsetIndex(samples), 0);
  });
});
