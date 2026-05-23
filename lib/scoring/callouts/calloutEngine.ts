// Callout engine — consumes the per-frame similarity stream the existing
// scoring pipeline already produces and emits a CalloutEvent on each accent
// beat. Pure logic, no React.
//
// Tuning: thresholds are deliberately generous because live callouts are the
// dopamine layer, not the verdict. A sincere attempt should fire mostly
// PERFECT/GREAT with occasional GROOVY peaks; ALMOST stays rare. Harsh
// judgement is Gemini's job (lib/scoring/gemini/*).
//
// Beat strategy: caller passes in accent beat timestamps (every 2nd beat from
// the existing BeatTracker, derived from BPM). On each accent beat we look at
// a ±150ms window of similarity samples and take the max — rewards on-beat
// hitting without punishing minor slips. If beat data is unavailable the
// caller is expected to fall back to every-800ms timestamps and note it in
// the call site.

import type { CalloutEvent, CalloutTier } from './types';

// Thresholds tuned toward generosity. Adjust here if real attempts cluster
// in ALMOST/GREAT — keep PERFECT as the modal tier for a sincere run.
export const CALLOUT_THRESHOLDS = {
  GROOVY: 0.88,
  PERFECT: 0.75,
  GREAT: 0.6,
} as const;

// ±WINDOW_MS around an accent beat — frames inside this band are candidates
// for the beat's max similarity.
export const WINDOW_MS = 150;

export function tierForSimilarity(similarity: number): CalloutTier {
  if (similarity >= CALLOUT_THRESHOLDS.GROOVY) return 'GROOVY';
  if (similarity >= CALLOUT_THRESHOLDS.PERFECT) return 'PERFECT';
  if (similarity >= CALLOUT_THRESHOLDS.GREAT) return 'GREAT';
  return 'ALMOST';
}

export interface CalloutEngineConfig {
  accentBeatTimestamps: number[];
  onCallout: (event: CalloutEvent) => void;
}

export interface CalloutEngine {
  ingestFrame: (frame: { timestamp: number; similarity: number }) => void;
  reset: () => void;
}

export function createCalloutEngine(config: CalloutEngineConfig): CalloutEngine {
  const beats = [...config.accentBeatTimestamps].sort((a, b) => a - b);
  // Per-beat running max of similarity within the window. We commit the beat
  // and emit once the running clock has moved past the upper edge of its
  // window — that's the earliest moment we know no later frame can improve
  // the max.
  const beatMax: number[] = beats.map(() => -Infinity);
  let nextBeatToCommit = 0;

  const commitUpTo = (latestFrameTs: number) => {
    while (nextBeatToCommit < beats.length) {
      const beatTs = beats[nextBeatToCommit]!;
      const windowEnd = beatTs + WINDOW_MS;
      if (latestFrameTs < windowEnd) return;
      const maxSim = beatMax[nextBeatToCommit]!;
      // Only emit if at least one frame landed inside the window — otherwise
      // the user wasn't being scored at this beat (pose lost, pre-roll, etc.)
      // and a phantom ALMOST would be misleading.
      if (Number.isFinite(maxSim)) {
        config.onCallout({
          tier: tierForSimilarity(maxSim),
          beatIndex: nextBeatToCommit,
          timestamp: beatTs,
          similarity: maxSim,
        });
      }
      nextBeatToCommit += 1;
    }
  };

  return {
    ingestFrame: ({ timestamp, similarity }) => {
      // Sweep any beats whose window has already closed before this frame.
      commitUpTo(timestamp);
      // Then accumulate into the current and immediately-upcoming beat
      // windows. A single frame can only fall into one beat's ±WINDOW_MS
      // window because consecutive accent-beat spacing (BPM-based, ≥ ~250ms
      // at extreme tempos and typically >500ms) exceeds 2 * WINDOW_MS.
      for (let i = nextBeatToCommit; i < beats.length; i += 1) {
        const beatTs = beats[i]!;
        if (timestamp < beatTs - WINDOW_MS) break;
        if (timestamp > beatTs + WINDOW_MS) continue;
        if (similarity > beatMax[i]!) beatMax[i] = similarity;
      }
    },
    reset: () => {
      for (let i = 0; i < beatMax.length; i += 1) beatMax[i] = -Infinity;
      nextBeatToCommit = 0;
    },
  };
}

// Helper for callers that don't have a beat tracker handy. Spec says fall
// back to every 800ms from chunk start if BeatTracker output isn't reliable.
export function deriveAccentBeatsFromBpm(
  startMs: number,
  endMs: number,
  bpm: number,
): number[] {
  if (bpm > 0) {
    const periodMs = 60_000 / bpm;
    // Every 2nd beat.
    const accentPeriodMs = periodMs * 2;
    const out: number[] = [];
    for (let t = startMs; t < endMs; t += accentPeriodMs) out.push(t);
    return out;
  }
  const out: number[] = [];
  for (let t = startMs; t < endMs; t += 800) out.push(t);
  return out;
}
