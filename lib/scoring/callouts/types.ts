// Live-callout types — the in-dance dopamine layer that flashes GROOVY /
// PERFECT / GREAT / ALMOST on accent beats during a Mode B attempt.
//
// IMPORTANT: live-callout `GROOVY` is NOT the same concept as Gemini's
// post-attempt overall tier `GROOVY` (see lib/scoring/gemini/types.ts).
// Live = single-moment peak hit on one accent beat.
// Gemini = overall verdict tier 85-100 across the whole attempt.
// Don't normalize these — they're separate semantic spaces.

export type CalloutTier = 'GROOVY' | 'PERFECT' | 'GREAT' | 'ALMOST';

export interface CalloutEvent {
  tier: CalloutTier;
  beatIndex: number;
  timestamp: number;
  similarity: number;
}
