// MediaRecorder webm duration finalization.
//
// Round-4 diagnosis: blobs produced by MediaRecorder routinely surface a
// bogus duration (commonly `0.001` or `Infinity`) until something forces
// the container index to write. A <video> element reading such a blob
// reports the bogus value too, which kills any downstream code that needs
// real timing — including motion-onset detection, which then scans a
// 0.001-second window and silently returns null.
//
// The standard fix: seek the element to a value beyond any plausible
// duration. The browser clamps to the actual end and fires `seeked`; the
// container index gets written as part of that operation; subsequent
// reads of `video.duration` return the real value. We then seek back to
// 0 so the rest of the pipeline starts from the beginning.
//
// This helper is intentionally DOM-decoupled: it takes a minimal
// duration-reading object plus a `seek` callback. The DOM caller in
// lib/scoring/gemini/client.ts wires up `seekVideo`. Tests inject a
// mock seek that mutates a stub's duration on demand, so the logic
// pins without a browser harness.

export interface DurationLikeVideo {
  readonly duration: number;
}

export interface FinalizeOptions {
  // Threshold below which we treat the duration as bogus and trigger the
  // fix. Defaults to 0.5 seconds — small enough that a real ~1-second
  // chunk still passes, large enough that the `0.001` / `Infinity` /
  // `NaN` failure modes all trip it.
  minPlausibleDurationSec?: number;
  // Where to seek to force the index. MAX_SAFE_INTEGER works in practice
  // (the browser clamps); exposed for tests.
  seekTargetSec?: number;
}

const DEFAULTS: Required<FinalizeOptions> = {
  minPlausibleDurationSec: 0.5,
  seekTargetSec: Number.MAX_SAFE_INTEGER,
};

export interface FinalizeResult {
  // True when the duration was deemed bogus and the seek-to-end was
  // attempted. False when the initial duration already looked sane.
  attempted: boolean;
  durationBefore: number;
  durationAfter: number;
  // True when the attempted fix succeeded — duration is now finite,
  // positive, and at least the min-plausible threshold.
  fixed: boolean;
}

// Seek-to-end-then-back trick. If the initial duration looks sane we
// skip the round-trip entirely. `seek` rejections are swallowed because
// even a partial fix (e.g. only the forward seek succeeds) usually
// finalizes the index; the rewind is best-effort.
export async function finalizeWebmDuration(
  video: DurationLikeVideo,
  seek: (sec: number) => Promise<void>,
  opts: FinalizeOptions = {},
): Promise<FinalizeResult> {
  const { minPlausibleDurationSec, seekTargetSec } = { ...DEFAULTS, ...opts };
  const durationBefore = video.duration;

  if (Number.isFinite(durationBefore) && durationBefore >= minPlausibleDurationSec) {
    return {
      attempted: false,
      durationBefore,
      durationAfter: durationBefore,
      fixed: true,
    };
  }

  try {
    await seek(seekTargetSec);
  } catch {
    // Best-effort. The seek may have already finalized the index even
    // if the seeked event surfaced an error.
  }
  try {
    await seek(0);
  } catch {
    // Best-effort.
  }

  const durationAfter = video.duration;
  const fixed =
    Number.isFinite(durationAfter) && durationAfter >= minPlausibleDurationSec;
  return {
    attempted: true,
    durationBefore,
    durationAfter,
    fixed,
  };
}
