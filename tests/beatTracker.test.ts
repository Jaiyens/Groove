import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BeatTracker, createBeatGrid } from '../lib/scoring/beatTracker.ts';

describe('BeatTracker', () => {
  it('at 120 BPM beat 0 is at t=0 and beat 1 is at t=500ms', () => {
    const bt = new BeatTracker(120, 0);
    assert.equal(bt.periodMs, 500);
    assert.equal(bt.getCurrentBeat(0), 0);
    assert.equal(bt.getCurrentBeat(500), 1);
    assert.equal(bt.getCurrentBeat(1000), 2);
  });

  it('rejects non-positive bpm', () => {
    assert.throws(() => new BeatTracker(0));
    assert.throws(() => new BeatTracker(-30));
  });

  it('tick emits beat events for crossed beats and is idempotent', () => {
    const bt = new BeatTracker(120, 0);
    const seen: Array<[number, number]> = [];
    bt.onBeat((b, ms) => seen.push([b, ms]));
    bt.tick(0); // beat 0
    bt.tick(250); // mid-beat, no new emit
    bt.tick(500); // beat 1
    bt.tick(1500); // crosses beats 2 and 3
    assert.deepEqual(seen, [
      [0, 0],
      [1, 500],
      [2, 1000],
      [3, 1500],
    ]);
  });

  it('startMs offsets the grid', () => {
    const bt = new BeatTracker(60, 1000);
    assert.equal(bt.getCurrentBeat(1000), 0);
    assert.equal(bt.getCurrentBeat(2000), 1);
    assert.equal(bt.msAtBeat(3), 4000);
  });

  it('asGrid conforms to BeatGrid interface', () => {
    const grid = createBeatGrid(149, 0);
    assert.equal(grid.bpm, 149);
    assert.equal(grid.startMs, 0);
    assert.ok(typeof grid.getBeatAt(123) === 'number');
    assert.ok(typeof grid.msAtBeat(4) === 'number');
  });
});
