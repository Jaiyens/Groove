import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  CALLOUT_THRESHOLDS,
  createCalloutEngine,
  deriveAccentBeatsFromBpm,
  tierForSimilarity,
} from '../lib/scoring/callouts/calloutEngine';
import type { CalloutEvent } from '../lib/scoring/callouts/types';

test('tierForSimilarity maps to the right tier at thresholds', () => {
  assert.equal(tierForSimilarity(0.95), 'GROOVY');
  assert.equal(tierForSimilarity(CALLOUT_THRESHOLDS.GROOVY), 'GROOVY');
  assert.equal(tierForSimilarity(0.8), 'PERFECT');
  assert.equal(tierForSimilarity(CALLOUT_THRESHOLDS.PERFECT), 'PERFECT');
  assert.equal(tierForSimilarity(0.65), 'GREAT');
  assert.equal(tierForSimilarity(CALLOUT_THRESHOLDS.GREAT), 'GREAT');
  assert.equal(tierForSimilarity(0.4), 'ALMOST');
  assert.equal(tierForSimilarity(0), 'ALMOST');
});

test('engine fires GROOVY for a 0.92 hit at an accent beat', () => {
  const events: CalloutEvent[] = [];
  const engine = createCalloutEngine({
    accentBeatTimestamps: [1000, 2000],
    onCallout: (e) => events.push(e),
  });

  // Stream frames every 50ms; spike similarity at t=1000.
  for (let t = 0; t <= 2500; t += 50) {
    const sim = t === 1000 ? 0.92 : 0.3;
    engine.ingestFrame({ timestamp: t, similarity: sim });
  }

  assert.ok(events.length >= 1, 'at least one callout should fire');
  const first = events.find((e) => e.beatIndex === 0)!;
  assert.equal(first.tier, 'GROOVY');
  assert.equal(first.beatIndex, 0);
  assert.ok(first.similarity >= 0.92 - 1e-9);
});

test('engine fires ALMOST when all frames are low similarity', () => {
  const events: CalloutEvent[] = [];
  const engine = createCalloutEngine({
    accentBeatTimestamps: [500],
    onCallout: (e) => events.push(e),
  });
  for (let t = 0; t <= 1000; t += 50) {
    engine.ingestFrame({ timestamp: t, similarity: 0.4 });
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]!.tier, 'ALMOST');
});

test('no callouts fire between accent beats', () => {
  const events: CalloutEvent[] = [];
  const engine = createCalloutEngine({
    accentBeatTimestamps: [1000, 3000],
    onCallout: (e) => events.push(e),
  });
  // Stream a high-similarity frame at t=1500 (between beats, outside both
  // windows). No callouts should fire from that frame alone — the only
  // callouts must be tied to the two accent beats.
  for (let t = 0; t <= 4000; t += 100) {
    const sim = t === 1500 ? 0.99 : 0.3;
    engine.ingestFrame({ timestamp: t, similarity: sim });
  }
  assert.equal(events.length, 2);
  for (const e of events) {
    // Each event's reported timestamp must be one of the accent beats.
    assert.ok(e.timestamp === 1000 || e.timestamp === 3000);
  }
  // And neither event should reflect the 0.99 spike at t=1500.
  for (const e of events) {
    assert.ok(e.similarity < 0.5, `event sim ${e.similarity} should not pick up the off-beat spike`);
  }
});

test('engine takes window max, not the value AT the beat', () => {
  const events: CalloutEvent[] = [];
  const engine = createCalloutEngine({
    accentBeatTimestamps: [1000],
    onCallout: (e) => events.push(e),
  });
  // Spike inside window (+100ms after beat) should win even if the exact
  // beat moment is low — the user was on-beat-ish, reward them.
  engine.ingestFrame({ timestamp: 950, similarity: 0.3 });
  engine.ingestFrame({ timestamp: 1000, similarity: 0.3 });
  engine.ingestFrame({ timestamp: 1100, similarity: 0.9 });
  engine.ingestFrame({ timestamp: 1500, similarity: 0.4 }); // closes window
  assert.equal(events.length, 1);
  assert.equal(events[0]!.tier, 'GROOVY');
});

test('engine does NOT emit for beats with no frames in window', () => {
  const events: CalloutEvent[] = [];
  const engine = createCalloutEngine({
    accentBeatTimestamps: [1000, 5000],
    onCallout: (e) => events.push(e),
  });
  // Only stream frames near the first beat. The second beat's window never
  // receives a frame — emitting a phantom ALMOST there would be misleading
  // (pose was lost / pre-roll). Engine should stay silent for beat 1.
  for (let t = 800; t <= 1300; t += 50) {
    engine.ingestFrame({ timestamp: t, similarity: 0.8 });
  }
  // Advance clock far past beat 2's window to give the engine a chance to
  // commit, but never delivered a frame inside its window.
  engine.ingestFrame({ timestamp: 10_000, similarity: 0.0 });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.beatIndex, 0);
});

test('reset clears state', () => {
  const events: CalloutEvent[] = [];
  const engine = createCalloutEngine({
    accentBeatTimestamps: [1000],
    onCallout: (e) => events.push(e),
  });
  engine.ingestFrame({ timestamp: 1000, similarity: 0.95 });
  engine.ingestFrame({ timestamp: 1200, similarity: 0.3 });
  assert.equal(events.length, 1);
  engine.reset();
  // After reset, replaying the same stream should fire the same callout
  // again rather than being suppressed by stale committed state.
  engine.ingestFrame({ timestamp: 1000, similarity: 0.95 });
  engine.ingestFrame({ timestamp: 1200, similarity: 0.3 });
  assert.equal(events.length, 2);
});

test('deriveAccentBeatsFromBpm: every-2nd-beat at 120 bpm', () => {
  // 120 bpm → 500ms period → accent every 1000ms.
  const beats = deriveAccentBeatsFromBpm(0, 4000, 120);
  assert.deepEqual(beats, [0, 1000, 2000, 3000]);
});

test('deriveAccentBeatsFromBpm: falls back to every 800ms when bpm is bogus', () => {
  const beats = deriveAccentBeatsFromBpm(0, 2500, 0);
  assert.deepEqual(beats, [0, 800, 1600, 2400]);
});
