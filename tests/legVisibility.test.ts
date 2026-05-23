import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLegsVisible } from '../lib/scoring/legVisibility.ts';
import type { LandmarkFrame, PoseLandmark } from '../lib/pose/types.ts';

// Build a 33-landmark frame. By default every landmark has visibility 1
// at center coords; pass `legsHidden: true` to drop the leg landmark
// visibilities to 0 (simulating an upper-body-only capture where the
// detector still emits placeholders but their confidence is 0).
function frame(
  timestampMs: number,
  { legsHidden = false }: { legsHidden?: boolean } = {},
): LandmarkFrame {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 1,
  }));
  if (legsHidden) {
    for (const idx of [25, 26, 27, 28]) {
      landmarks[idx] = { ...landmarks[idx]!, visibility: 0 };
    }
  }
  return { timestampMs, landmarks };
}

describe('detectLegsVisible', () => {
  it('returns true (generous default) when no frames are provided', () => {
    assert.equal(detectLegsVisible([]), true);
  });

  it('returns true when every frame shows fully-visible legs', () => {
    const frames = Array.from({ length: 60 }, (_, i) => frame(i * 33));
    assert.equal(detectLegsVisible(frames), true);
  });

  it('returns false when every frame hides the leg landmarks', () => {
    const frames = Array.from({ length: 60 }, (_, i) => frame(i * 33, { legsHidden: true }));
    assert.equal(detectLegsVisible(frames), false);
  });

  it('returns false when fewer than 60% of frames have visible legs', () => {
    // 30% visible, 70% hidden — below threshold.
    const frames = [
      ...Array.from({ length: 30 }, (_, i) => frame(i * 33)),
      ...Array.from({ length: 70 }, (_, i) => frame((i + 30) * 33, { legsHidden: true })),
    ];
    assert.equal(detectLegsVisible(frames), false);
  });

  it('returns true when ≥60% of frames have visible legs', () => {
    const frames = [
      ...Array.from({ length: 70 }, (_, i) => frame(i * 33)),
      ...Array.from({ length: 30 }, (_, i) => frame((i + 70) * 33, { legsHidden: true })),
    ];
    assert.equal(detectLegsVisible(frames), true);
  });

  it('tolerates a single low-confidence leg landmark per frame', () => {
    // 3 of 4 leg landmarks visible per frame should still count as "legs in frame".
    const frames = Array.from({ length: 30 }, (_, i) => {
      const f = frame(i * 33);
      f.landmarks[28] = { ...f.landmarks[28]!, visibility: 0 };
      return f;
    });
    assert.equal(detectLegsVisible(frames), true);
  });
});
