import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMotionOnsetIndex } from '../lib/scoring/gemini/motionOnset.ts';

// SPECK round-3 §Group-2: the DOM harness in client.ts samples per-frame
// pixel-diff magnitudes; this module decides "where did motion start?" The
// algorithm is pure so we can pin its behavior here without a browser.

describe('detectMotionOnsetIndex — happy paths', () => {
  it('flat-zero pre-roll then a clear spike onsets at the first spike index', () => {
    // 4 frames of dead air, then sustained motion. Baseline window default 3.
    const samples = [0, 0, 0, 0, 50, 50, 50];
    assert.equal(detectMotionOnsetIndex(samples), 4);
  });

  it('low-noise pre-roll then a 5× jump onsets at the jump', () => {
    const samples = [1, 1, 1, 1, 5, 5];
    assert.equal(detectMotionOnsetIndex(samples), 4);
  });

  it('jump within 3× of baseline does NOT onset', () => {
    // baseline = 1, current = 2.5 → ratio 2.5 < 3.
    const samples = [1, 1, 1, 2.5, 2.5, 2.5];
    assert.equal(detectMotionOnsetIndex(samples), null);
  });

  it('steady-state stream returns null', () => {
    const samples = [5, 5, 5, 5, 5, 5];
    assert.equal(detectMotionOnsetIndex(samples), null);
  });
});

describe('detectMotionOnsetIndex — edge cases', () => {
  it('returns null when stream is shorter than baseline window + 1', () => {
    assert.equal(detectMotionOnsetIndex([0, 0, 100]), null);
    assert.equal(detectMotionOnsetIndex([]), null);
  });

  it('does NOT fire when the current sample is below absoluteFloor even with a huge ratio', () => {
    // baseline ~0.001, current 0.3 → ratio 300× but 0.3 < default floor 0.5.
    const samples = [0.001, 0.001, 0.001, 0.3, 0.3];
    assert.equal(detectMotionOnsetIndex(samples), null);
  });

  it('fires on baseline-zero with the very first sample that clears absoluteFloor', () => {
    // True dead-air pre-roll then any motion that clears the floor.
    const samples = [0, 0, 0, 1, 1, 1];
    assert.equal(detectMotionOnsetIndex(samples), 3);
  });

  it('honors a custom multiplier when caller tunes it', () => {
    const samples = [1, 1, 1, 1.6, 1.6, 1.6];
    // default multiplier 3 → no fire
    assert.equal(detectMotionOnsetIndex(samples), null);
    // multiplier 1.5 → 1.6 > 1.5×1.0 = 1.5 → fires at 3
    assert.equal(detectMotionOnsetIndex(samples, { multiplier: 1.5 }), 3);
  });

  it('honors a custom baselineWindow', () => {
    // With window=1: baseline = previous sample only.
    // [10, 10, 50] → at i=1 baseline=10, current=10 → no; at i=2 baseline=10, current=50 → 5× → fires at 2.
    const samples = [10, 10, 50];
    assert.equal(detectMotionOnsetIndex(samples, { baselineWindow: 1 }), 2);
  });
});

describe('detectMotionOnsetIndex — realistic shapes', () => {
  it('"dancer walks to camera" shape: rising then plateau, picks the choreography start, not the walk-in noise', () => {
    // Light walking motion is steady-low; the choreography hit is a clear spike.
    const samples = [
      // walking back to camera (steady-low motion)
      2, 2, 2, 2, 2,
      // dancer settles, briefly still
      0.6, 0.6, 0.6,
      // first hit
      8, 7, 8,
    ];
    // baseline at i=8 = mean(0.6, 0.6, 0.6) = 0.6 → 8 > 1.8 → onsets at 8.
    assert.equal(detectMotionOnsetIndex(samples), 8);
  });
});
