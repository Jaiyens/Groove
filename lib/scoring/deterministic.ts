// Deterministic scoring layer.
//
// Sits on top of Gemini's structured output (lib/scoring/gemini/types.ts)
// and computes the score the user actually sees. Gemini's `overall_score`
// is reliable enough as a canary signal (is_actually_dancing) but its raw
// 0-100 ratings drift low even on sincere attempts — every prompt revision
// we've shipped clusters sincere runs around 55, which reads as failure in
// the UI. Rather than keep wrestling with the model, we trust the qualitative
// signal (trouble-spot count + severity) and compute the displayed number
// from a formula calibrated for product psychology.
//
// Design contract:
//   - Pure function. Same input → same output. No side effects.
//   - Non-attempt path trusts Gemini (canary is solid). `legs` forced to 0
//     because Gemini defaults the legs component to ~75 even when the
//     user isn't moving, which leaks through the UI as a phantom "75 LEGS"
//     bar.
//   - Sincere-attempt path produces a score in [70, 98]. The 70 floor is
//     deliberate — even a sloppy-but-recognizable attempt should still
//     feel rewarding (SHAKY headline, amber color, not red).
//
// Headline copy / color zones live in components/ResultsCard.tsx and key
// off `displayTier` / `displayScore`. Keep this file framework-free; it
// runs on both the client (Mode B orchestrator) and inside unit tests.
//
// Debug pill: callers should also pass `geminiRawScore` along to the
// results card so validation mode can render both numbers side by side.

import type { GeminiScore } from './gemini/types';

export type DisplayTier = 'NOT_DANCING' | 'TRYING' | 'SHAKY' | 'SOLID' | 'GROOVY';

export interface DeterministicScore {
  displayScore: number;
  displayTier: DisplayTier;
  geminiRawScore: number;
  isActuallyDancing: boolean;
  components: {
    arms: number;
    legs: number;
    body: number;
    timing: number;
  };
}

const SINCERE_BASE = 85;
const SINCERE_FLOOR = 70;
const SINCERE_CEILING = 98;
const NON_ATTEMPT_CEILING = 39;
const UPPER_BODY_LEG_DEFAULT = 75;

export function computeDeterministicScore(
  gemini: GeminiScore,
  legsVisible: boolean,
): DeterministicScore {
  if (!gemini.is_actually_dancing) {
    const displayScore = clamp(Math.round(gemini.overall_score), 0, NON_ATTEMPT_CEILING);
    const result: DeterministicScore = {
      displayScore,
      displayTier: 'NOT_DANCING',
      geminiRawScore: gemini.overall_score,
      isActuallyDancing: false,
      components: {
        arms: round(gemini.components.arms),
        // Force legs to 0 on non-attempts. Gemini's components.legs
        // defaults to ~75 when the user isn't moving — that bar reads
        // as a UI bug to users who just stood still.
        legs: 0,
        body: round(gemini.components.body),
        timing: round(gemini.components.timing),
      },
    };
    logComputation(gemini, result);
    return result;
  }

  let score = SINCERE_BASE;

  const major = countSeverity(gemini.trouble_spots, 'major');
  const moderate = countSeverity(gemini.trouble_spots, 'moderate');
  const minor = countSeverity(gemini.trouble_spots, 'minor');

  // Caps on each severity bucket so a long trouble-spot list (max 5 per
  // the schema) can't compound into a score below the SHAKY floor.
  score -= Math.min(major, 2) * 5;     // -10 max from MAJOR
  score -= Math.min(moderate, 3) * 2;  // -6 max from MODERATE
  score -= Math.min(minor, 4) * 0.5;   // -2 max from MINOR

  score = clamp(score, SINCERE_FLOOR, SINCERE_CEILING);
  score = Math.round(score);

  const result: DeterministicScore = {
    displayScore: score,
    displayTier: scoreToTier(score),
    geminiRawScore: gemini.overall_score,
    isActuallyDancing: true,
    components: {
      arms: round(gemini.components.arms),
      // legsVisible=false means the user filmed upper-body only. Gemini's
      // legs score is meaningless in that case — fall back to the
      // upper-body default (75) so the bar isn't misleading.
      legs: legsVisible ? round(gemini.components.legs) : UPPER_BODY_LEG_DEFAULT,
      body: round(gemini.components.body),
      timing: round(gemini.components.timing),
    },
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

function countSeverity(
  spots: GeminiScore['trouble_spots'],
  severity: GeminiScore['trouble_spots'][number]['severity'],
): number {
  let n = 0;
  for (const s of spots) if (s.severity === severity) n += 1;
  return n;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)));
}

function logComputation(gemini: GeminiScore, result: DeterministicScore): void {
  if (typeof console === 'undefined') return;
  const major = countSeverity(gemini.trouble_spots, 'major');
  const moderate = countSeverity(gemini.trouble_spots, 'moderate');
  const minor = countSeverity(gemini.trouble_spots, 'minor');
  // eslint-disable-next-line no-console
  console.log(
    `[deterministic] gemini.overall_score=${gemini.overall_score} dancing=${gemini.is_actually_dancing} major=${major} moderate=${moderate} minor=${minor} → display=${result.displayScore} tier=${result.displayTier}`,
  );
}
