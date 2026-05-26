// Display-layer feel-good boost: raw scores >65 get +10 (clamped to 100).
// The raw Gemini scores pass through scoreDanceAttempt unmodified so
// mastery + the per-skill projection track the true signal; this boost
// is applied only at render time in ScoreRevealCard.
//
// Keep this in its own module so client components can import it
// without dragging in the server-only `node:fs` parts of score-attempt.

export function applyDisplayBoost(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return score > 65 ? Math.min(100, score + 10) : score;
}
