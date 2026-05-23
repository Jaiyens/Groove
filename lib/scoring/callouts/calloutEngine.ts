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
  // Per-frame ingestion counter. We log every 30th frame so the terminal
  // sees similarity values without flooding (the detection loop runs at
  // 30-60Hz; sampling at 30 gives ~1 line/sec at 30fps).
  let frameCount = 0;

  // SPECK §callout-investigation: layer 1 — init log. After running one
  // attempt, this line MUST appear in the terminal. If it doesn't, the
  // engine isn't being instantiated at all.
  // eslint-disable-next-line no-console
  console.log('[callout-engine][init] accentBeats=', beats.length);

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
        const tier = tierForSimilarity(maxSim);
        // SPECK §callout-investigation: layer 3 — per-beat decision log
        // (kept from previous spec). If [init] fires but no [beat] logs
        // appear, the engine isn't receiving frames at all OR beats are
        // outside the frame timestamps. Expected mix on a real attempt:
        // mostly PERFECT/GREAT with occasional GROOVY peaks and rare
        // ALMOST. Every-beat-GROOVY means a normalization bug upstream.
        // eslint-disable-next-line no-console
        console.log(
          `[callout-engine][beat] index=${nextBeatToCommit} windowMax=${maxSim.toFixed(3)} tier=${tier}`,
        );
        const event: CalloutEvent = {
          tier,
          beatIndex: nextBeatToCommit,
          timestamp: beatTs,
          similarity: maxSim,
        };
        // SPECK §callout-investigation: layer 4 — callback fire log.
        // Confirms the consumer (overlay) actually receives the event.
        // eslint-disable-next-line no-console
        console.log(
          `[callout-engine][fire] tier=${event.tier} at=${event.timestamp.toFixed(0)}`,
        );
        config.onCallout(event);
      }
      nextBeatToCommit += 1;
    }
  };

  return {
    ingestFrame: ({ timestamp, similarity }) => {
      // SPECK §callout-investigation: layer 2 — per-frame ingestion log,
      // sampled at 1-in-30 so we don't flood. If [init] fires but no
      // [frame] logs appear, the engine is created but no frames reach
      // it — bug is at the orchestrator's ingestFrame call site.
      frameCount += 1;
      if (frameCount % 30 === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[callout-engine][frame] ts=${timestamp.toFixed(0)} similarity=${similarity.toFixed(3)}`,
        );
      }
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

// SPEC: score-restoration §Change 3. Hardcoded callout cycler — replaces
// the live MediaPipe + DTW callout path. The cycler is purely beat-driven:
// every 2-3 beats it emits one of GROOVY / PERFECT / GOOD, never repeating
// the same word twice in a row. The DTW scoring code itself stays in this
// module (tierForSimilarity / createCalloutEngine) because the post-attempt
// fallback scoring still uses it; only the live callout UI changed source.
const CALLOUT_WORDS = ['GROOVY', 'PERFECT', 'GOOD'] as const;
type CyclerWord = (typeof CALLOUT_WORDS)[number];
const BEATS_PER_CALLOUT_MIN = 2;
const BEATS_PER_CALLOUT_MAX = 3;

export function makeCalloutCycler(): (beatIdx: number) => CyclerWord | null {
  let lastWord: CyclerWord | null = null;
  let beatsUntilNext = 0;

  return function onBeat(): CyclerWord | null {
    if (beatsUntilNext > 0) {
      beatsUntilNext -= 1;
      return null;
    }

    const candidates = CALLOUT_WORDS.filter((w) => w !== lastWord);
    const word = candidates[Math.floor(Math.random() * candidates.length)]!;

    lastWord = word;
    beatsUntilNext =
      BEATS_PER_CALLOUT_MIN +
      Math.floor(Math.random() * (BEATS_PER_CALLOUT_MAX - BEATS_PER_CALLOUT_MIN + 1)) -
      1;

    return word;
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
