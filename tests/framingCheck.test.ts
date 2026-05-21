import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNT_INTERVAL_MS,
  COUNT_START,
  CONFIDENCE_FLOOR,
  FRAMING_HOLD_MS,
  FramingGate,
  OUT_OF_FRAME_GRACE_MS,
  REQUIRED_LANDMARKS,
  SILHOUETTE_BOUNDS,
  isUpperBodyFramed,
} from '../lib/pose/framingCheck.ts';
import { LANDMARK, type PoseLandmark } from '../lib/pose/types.ts';

// Helper: build a 33-landmark array where every entry is a fully-visible
// point at the centre of the silhouette. Pass overrides to mutate specific
// indices (e.g. to drop visibility or move out of bounds).
function makeLandmarks(
  overrides: Partial<Record<number, Partial<PoseLandmark>>> = {},
): PoseLandmark[] {
  const cx = (SILHOUETTE_BOUNDS.x0 + SILHOUETTE_BOUNDS.x1) / 2;
  const cy = (SILHOUETTE_BOUNDS.y0 + SILHOUETTE_BOUNDS.y1) / 2;
  const base: PoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: cx,
    y: cy,
    z: 0,
    visibility: 1,
  }));
  for (const [k, v] of Object.entries(overrides)) {
    const idx = Number(k);
    base[idx] = { ...base[idx], ...v };
  }
  return base;
}

describe('isUpperBodyFramed', () => {
  it('passes when every required landmark is visible and inside bounds', () => {
    assert.equal(isUpperBodyFramed(makeLandmarks()), true);
  });

  it('does NOT require ankles (spec §1 — knees up is enough)', () => {
    const lms = makeLandmarks({
      [LANDMARK.LEFT_ANKLE]: { x: 99, y: 99, visibility: 0 },
      [LANDMARK.RIGHT_ANKLE]: { x: 99, y: 99, visibility: 0 },
      [LANDMARK.LEFT_FOOT_INDEX]: { visibility: 0 },
      [LANDMARK.RIGHT_FOOT_INDEX]: { visibility: 0 },
    });
    assert.equal(isUpperBodyFramed(lms), true);
  });

  it('fails when a required knee drops below the confidence floor', () => {
    const lms = makeLandmarks({
      [LANDMARK.LEFT_KNEE]: { visibility: CONFIDENCE_FLOOR - 0.01 },
    });
    assert.equal(isUpperBodyFramed(lms), false);
  });

  it('fails when a required landmark is outside the silhouette bounds', () => {
    const lms = makeLandmarks({
      [LANDMARK.NOSE]: { y: SILHOUETTE_BOUNDS.y0 - 0.01 },
    });
    assert.equal(isUpperBodyFramed(lms), false);
  });

  it('returns false for null landmarks', () => {
    assert.equal(isUpperBodyFramed(null), false);
    assert.equal(isUpperBodyFramed(undefined), false);
  });

  it('REQUIRED_LANDMARKS covers exactly 15 joints, all knees-up', () => {
    assert.equal(REQUIRED_LANDMARKS.length, 15);
    // No ankle / heel / foot indices.
    for (const idx of [
      LANDMARK.LEFT_ANKLE,
      LANDMARK.RIGHT_ANKLE,
      LANDMARK.LEFT_HEEL,
      LANDMARK.RIGHT_HEEL,
      LANDMARK.LEFT_FOOT_INDEX,
      LANDMARK.RIGHT_FOOT_INDEX,
    ]) {
      assert.ok(!REQUIRED_LANDMARKS.includes(idx), `${idx} should not be required`);
    }
  });
});

describe('FramingGate', () => {
  it('starts in searching with count = 5', () => {
    const g = new FramingGate();
    const r = g.tick(false, 0);
    assert.equal(r.phase, 'searching');
    assert.equal(r.count, COUNT_START);
    assert.equal(r.tickFired, undefined);
  });

  it('transitions searching → arming when framing first appears', () => {
    const g = new FramingGate();
    const r = g.tick(true, 0);
    assert.equal(r.phase, 'arming');
    assert.equal(r.tickFired, undefined);
  });

  it('stays in arming below the 1.5s hold', () => {
    const g = new FramingGate();
    g.tick(true, 0);
    const r = g.tick(true, FRAMING_HOLD_MS - 1);
    assert.equal(r.phase, 'arming');
    assert.equal(r.tickFired, undefined);
  });

  it('reverts to searching if framing breaks during arming', () => {
    const g = new FramingGate();
    g.tick(true, 0);
    g.tick(true, 500);
    const r = g.tick(false, 600);
    assert.equal(r.phase, 'searching');
  });

  it('counts 5 → 4 → 3 → 2 → 1 → GO at 800ms intervals with one tick each', () => {
    const g = new FramingGate();
    g.tick(true, 0);
    const t0 = FRAMING_HOLD_MS;
    const ticks: (number | 'go')[] = [];
    const r0 = g.tick(true, t0);
    if (r0.tickFired !== undefined) ticks.push(r0.tickFired);
    for (let step = 1; step <= 5; step++) {
      const t = t0 + step * COUNT_INTERVAL_MS;
      const r = g.tick(true, t);
      if (r.tickFired !== undefined) ticks.push(r.tickFired);
    }
    assert.deepEqual(ticks, [5, 4, 3, 2, 1, 'go']);
  });

  it('does not double-fire a tick across multiple animation frames at the same count', () => {
    const g = new FramingGate();
    g.tick(true, 0);
    // Same count=5 step revisited many times within the 800ms window.
    g.tick(true, FRAMING_HOLD_MS);
    let extra = 0;
    for (let i = 1; i < 50; i++) {
      const r = g.tick(true, FRAMING_HOLD_MS + i * 10);
      if (r.tickFired !== undefined) extra++;
    }
    assert.equal(extra, 0);
  });

  it('reaches fired exactly once with fired=true on the GO step', () => {
    const g = new FramingGate();
    g.tick(true, 0);
    g.tick(true, FRAMING_HOLD_MS);
    let fires = 0;
    for (let step = 1; step <= 10; step++) {
      const r = g.tick(true, FRAMING_HOLD_MS + step * COUNT_INTERVAL_MS);
      if (r.fired) fires++;
    }
    assert.equal(fires, 1);
  });

  it('keeps counting through a brief (<0.5s) out-of-frame blip', () => {
    const g = new FramingGate();
    g.tick(true, 0);
    g.tick(true, FRAMING_HOLD_MS); // count=5
    const r = g.tick(false, FRAMING_HOLD_MS + 100); // 100ms out
    assert.equal(r.phase, 'counting');
  });

  it('resets to searching after a ≥0.5s out-of-frame', () => {
    const g = new FramingGate();
    g.tick(true, 0);
    g.tick(true, FRAMING_HOLD_MS); // count=5
    g.tick(false, FRAMING_HOLD_MS + 10);
    const r = g.tick(false, FRAMING_HOLD_MS + 10 + OUT_OF_FRAME_GRACE_MS);
    assert.equal(r.phase, 'searching');
  });

  it('restarts the countdown from 5 after a reset + re-frame + re-arm', () => {
    const g = new FramingGate();
    // first attempt → count=5 → step out → reset
    g.tick(true, 0);
    g.tick(true, FRAMING_HOLD_MS);
    g.tick(false, FRAMING_HOLD_MS + 10);
    g.tick(false, FRAMING_HOLD_MS + 10 + OUT_OF_FRAME_GRACE_MS);

    // step back in → arm → count
    const t1 = 10_000;
    g.tick(true, t1);
    const r = g.tick(true, t1 + FRAMING_HOLD_MS);
    assert.equal(r.phase, 'counting');
    assert.equal(r.count, COUNT_START);
    assert.equal(r.tickFired, COUNT_START);
  });

  it('staying in fired produces no further fire events', () => {
    const g = new FramingGate();
    g.tick(true, 0);
    g.tick(true, FRAMING_HOLD_MS);
    // Walk to GO.
    for (let step = 1; step <= 5; step++) {
      g.tick(true, FRAMING_HOLD_MS + step * COUNT_INTERVAL_MS);
    }
    assert.equal(g.getPhase(), 'fired');
    const after = g.tick(true, FRAMING_HOLD_MS + 10 * COUNT_INTERVAL_MS);
    assert.equal(after.fired, undefined);
    assert.equal(after.phase, 'fired');
  });
});
