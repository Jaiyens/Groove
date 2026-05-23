// Deterministic scoring layer.
//
// Sits on top of Gemini's structured output (lib/scoring/gemini/types.ts)
// and computes the score the user actually sees.
//
// SPECK round-3 §Group-3: the displayed overall is the **arithmetic mean of
// the visible components**. No separate top-level boost — the breakdown is
// the source of truth and the headline is a derived value. Earlier rounds
// applied a SINCERE_BASE + trouble-spot-deduction formula on top of Gemini's
// overall; that produced a headline (e.g. 81) that didn't match the bars
// (which averaged to 51). Generosity calibration now lives in the Gemini
// prompt (Group 4), not on top of the result.
//
// Design contract:
//   - Pure function. Same input → same output. No side effects.
//   - `legsVisible: false` → `components.legs: null`. The mean is computed
//     over the three visible components. UI renders the legs pill as
//     "(UPPER BODY ONLY)" with a dim dash.
//   - Non-attempt + `legsVisible: true` → `components.legs: 0`. Gemini's
//     prompt-time default for legs has historically defaulted to ~75 even
//     when the user wasn't moving; forcing 0 here keeps the bar honest.
//     Group 4's prompt recalibration will make this redundant.
//   - Tier: NOT_DANCING when `is_actually_dancing === false`, otherwise
//     derived from the displayed score via `scoreToTier`.
//
// Debug pill: callers should also pass `geminiRawScore` along to the
// results card so validation mode can render both numbers side by side.

import type { GeminiScore } from './gemini/types';

export type DisplayTier = 'NOT_DANCING' | 'TRYING' | 'SHAKY' | 'SOLID' | 'GROOVY';

export interface DeterministicScoreComponents {
  arms: number;
  legs: number | null;
  body: number;
  timing: number;
}

export interface DeterministicScore {
  displayScore: number;
  displayTier: DisplayTier;
  geminiRawScore: number;
  isActuallyDancing: boolean;
  components: DeterministicScoreComponents;
}

// Headline number = mean of the visible components.
//   legsVisible=true  → mean of (arms, legs, body, timing). If legs is null
//                       (defensive — schema guarantees a number when visible),
//                       falls back to the 3-component mean.
//   legsVisible=false → mean of (arms, body, timing). The user filmed
//                       upper-body only; legs would be a Gemini-imputed
//                       default and would lie about the breakdown.
export function displayedOverall(
  c: DeterministicScoreComponents,
  legsVisible: boolean,
): number {
  if (legsVisible && c.legs != null) {
    return Math.round((c.arms + c.legs + c.body + c.timing) / 4);
  }
  return Math.round((c.arms + c.body + c.timing) / 3);
}

export function computeDeterministicScore(
  gemini: GeminiScore,
  legsVisible: boolean,
): DeterministicScore {
  const isActuallyDancing = gemini.is_actually_dancing;

  // Legs surface:
  //   - upper-body framing → null (excluded from mean, rendered as a dash)
  //   - non-attempt + legs visible → 0 (Gemini's ~75 default would mislead)
  //   - sincere attempt + legs visible → Gemini's actual legs component
  let legs: number | null;
  if (!legsVisible) {
    legs = null;
  } else if (!isActuallyDancing) {
    legs = 0;
  } else {
    legs = round(gemini.components.legs ?? 0);
  }

  const components: DeterministicScoreComponents = {
    arms: round(gemini.components.arms),
    legs,
    body: round(gemini.components.body),
    timing: round(gemini.components.timing),
  };

  const displayScore = displayedOverall(components, legsVisible);
  const displayTier: DisplayTier = isActuallyDancing
    ? scoreToTier(displayScore)
    : 'NOT_DANCING';

  const result: DeterministicScore = {
    displayScore,
    displayTier,
    geminiRawScore: gemini.overall_score,
    isActuallyDancing,
    components,
  };
  logComputation(gemini, result);
  return result;
}

export function scoreToTier(score: number): DisplayTier {
  if (score >= 85) return 'GROOVY';
  if (score >= 75) return 'SOLID';
  if (score >= 70) return 'SHAKY';
  if (score >= 40) return 'TRYING';
  return 'NOT_DANCING';
}

function round(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)));
}

function logComputation(gemini: GeminiScore, result: DeterministicScore): void {
  if (typeof console === 'undefined') return;
  // eslint-disable-next-line no-console
  console.log(
    `[deterministic] gemini.overall=${gemini.overall_score} dancing=${gemini.is_actually_dancing} components(arms=${result.components.arms} legs=${result.components.legs} body=${result.components.body} timing=${result.components.timing}) → display=${result.displayScore} tier=${result.displayTier}`,
  );
}
