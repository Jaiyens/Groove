import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeWebmDuration,
  type DurationLikeVideo,
} from '../lib/scoring/gemini/webmDuration.ts';

// MediaRecorder webm blobs surface bogus duration (0.001 / Infinity / NaN)
// until a seek-to-end forces the container index. `finalizeWebmDuration`
// takes a DI'd seek callback so we can pin its behavior without a browser
// — the mock below mutates the stub's duration on the first seek.

interface VideoStub extends DurationLikeVideo {
  duration: number;
}

function videoStub(initialDuration: number): VideoStub {
  return { duration: initialDuration };
}

// Returns a seek callback that, on first invocation, flips the stub's
// duration to `realDuration`. Subsequent seeks are no-ops. Lets us
// model the "browser finalizes the index on first seek" behavior
// without a real <video> element.
function seekThatFinalizesTo(
  stub: VideoStub,
  realDuration: number,
): (sec: number) => Promise<void> {
  let fired = false;
  return async () => {
    if (!fired) {
      stub.duration = realDuration;
      fired = true;
    }
  };
}

describe('finalizeWebmDuration — bogus durations trigger the fix', () => {
  it('duration=0.001 (the MediaRecorder field signature) is fixed by the seek-to-end trick', () => {
    const stub = videoStub(0.001);
    const seek = seekThatFinalizesTo(stub, 7.384);
    return finalizeWebmDuration(stub, seek).then((res) => {
      assert.equal(res.attempted, true);
      assert.equal(res.durationBefore, 0.001);
      assert.equal(res.durationAfter, 7.384);
      assert.equal(res.fixed, true);
    });
  });

  it('duration=Infinity is treated as bogus and fixed', () => {
    const stub = videoStub(Number.POSITIVE_INFINITY);
    const seek = seekThatFinalizesTo(stub, 12.0);
    return finalizeWebmDuration(stub, seek).then((res) => {
      assert.equal(res.attempted, true);
      assert.equal(res.durationBefore, Number.POSITIVE_INFINITY);
      assert.equal(res.durationAfter, 12.0);
      assert.equal(res.fixed, true);
    });
  });

  it('duration=NaN is treated as bogus and fixed', () => {
    const stub = videoStub(Number.NaN);
    const seek = seekThatFinalizesTo(stub, 5.5);
    return finalizeWebmDuration(stub, seek).then((res) => {
      assert.equal(res.attempted, true);
      assert.equal(Number.isNaN(res.durationBefore), true);
      assert.equal(res.durationAfter, 5.5);
      assert.equal(res.fixed, true);
    });
  });
});

describe('finalizeWebmDuration — sane durations are left alone', () => {
  it('duration=7.4 (already finalized) skips the seek entirely', async () => {
    const stub = videoStub(7.4);
    let seekCalls = 0;
    const seek = async () => {
      seekCalls += 1;
    };
    const res = await finalizeWebmDuration(stub, seek);
    assert.equal(res.attempted, false);
    assert.equal(res.durationBefore, 7.4);
    assert.equal(res.durationAfter, 7.4);
    assert.equal(res.fixed, true);
    assert.equal(seekCalls, 0);
  });

  it('duration exactly at the min-plausible threshold (0.5) is left alone', async () => {
    const stub = videoStub(0.5);
    let seekCalls = 0;
    const seek = async () => {
      seekCalls += 1;
    };
    const res = await finalizeWebmDuration(stub, seek);
    assert.equal(res.attempted, false);
    assert.equal(seekCalls, 0);
  });

  it('honors a caller-tuned min-plausible threshold', async () => {
    // duration 1.5 looks fine by default but the caller demands >= 5.
    const stub = videoStub(1.5);
    const seek = seekThatFinalizesTo(stub, 30);
    const res = await finalizeWebmDuration(stub, seek, {
      minPlausibleDurationSec: 5,
    });
    assert.equal(res.attempted, true);
    assert.equal(res.durationAfter, 30);
    assert.equal(res.fixed, true);
  });
});

describe('finalizeWebmDuration — degraded paths', () => {
  it('returns fixed=false when the seek runs but the duration is still bogus afterward', async () => {
    const stub = videoStub(0.001);
    // Seek that does NOT finalize the index — duration stays bad.
    const seek = async () => {
      /* no-op */
    };
    const res = await finalizeWebmDuration(stub, seek);
    assert.equal(res.attempted, true);
    assert.equal(res.durationBefore, 0.001);
    assert.equal(res.durationAfter, 0.001);
    assert.equal(res.fixed, false);
  });

  it("swallows rejections from the seek callback (best-effort)", async () => {
    const stub = videoStub(0.001);
    const seek = async () => {
      throw new Error('seek failed');
    };
    // Should NOT throw — even a failing seek may have finalized the
    // index on some browsers; we report fixed=false and let the caller
    // decide what to do.
    const res = await finalizeWebmDuration(stub, seek);
    assert.equal(res.attempted, true);
    assert.equal(res.fixed, false);
  });

  it('honors a caller-tuned seekTargetSec', async () => {
    const stub = videoStub(0.001);
    let seekTargets: number[] = [];
    const seek = async (sec: number) => {
      seekTargets.push(sec);
      if (seekTargets.length === 1) stub.duration = 8;
    };
    await finalizeWebmDuration(stub, seek, { seekTargetSec: 999 });
    assert.deepEqual(seekTargets, [999, 0]);
  });
});
