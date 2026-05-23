// Unit tests for the deterministic scoring layer (lib/scoring/deterministic.ts).
//
// SPECK round-3 §Group-3: the displayed overall is now the arithmetic mean
// of the VISIBLE components. The earlier formula (SINCERE_BASE - trouble-
// spot penalties) is gone; trouble spots no longer move the headline. The
// breakdown is the source of truth.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDeterministicScore,
  displayedOverall,
  scoreToTier,
} from '../lib/scoring/deterministic.ts';
import type { GeminiScore } from '../lib/scoring/gemini/types.ts';

function makeGemini(overrides: Partial<GeminiScore> = {}): GeminiScore {
  return {
    is_actually_dancing: true,
    overall_score: 55,
    tier: 'SHAKY',
    components: { arms: 60, legs: 50, body: 55, timing: 60 },
    insights: ['Solid attempt.'],
    trouble_spots: [],
    ...overrides,
  };
}

describe('displayedOverall — SPECK round-3 acceptance numbers', () => {
  it('legsVisible=true uses the 4-component mean', () => {
    // SPECK acceptance: arms 50, legs 75, body 35, timing 45 → 51.
    assert.equal(
      displayedOverall({ arms: 50, legs: 75, body: 35, timing: 45 }, true),
      51,
    );
  });

  it('legsVisible=false uses the 3-component mean and ignores legs entirely', () => {
    // SPECK acceptance: same input, legsVisible=false → 43.
    assert.equal(
      displayedOverall({ arms: 50, legs: 75, body: 35, timing: 45 }, false),
      43,
    );
  });

  it('legs=null + legsVisible=true falls back to the 3-component mean (defensive)', () => {
    assert.equal(
      displayedOverall({ arms: 60, legs: null, body: 60, timing: 60 }, true),
      60,
    );
  });

  it('legs=null + legsVisible=false same as legsVisible=true with legs=null', () => {
    assert.equal(
      displayedOverall({ arms: 80, legs: null, body: 70, timing: 90 }, false),
      80,
    );
  });

  it('rounds half-up to the nearest integer', () => {
    // (10 + 10 + 11 + 11) / 4 = 10.5 → 11
    assert.equal(
      displayedOverall({ arms: 10, legs: 10, body: 11, timing: 11 }, true),
      11,
    );
  });
});

describe('computeDeterministicScore — sincere attempt (mean of components)', () => {
  it('mean of 4 components when legsVisible=true', () => {
    const gemini = makeGemini({
      overall_score: 95,
      components: { arms: 80, legs: 70, body: 90, timing: 80 },
    });
    const result = computeDeterministicScore(gemini, true);
    // (80+70+90+80)/4 = 80
    assert.equal(result.displayScore, 80);
    assert.equal(result.displayTier, 'SOLID');
    assert.equal(result.components.legs, 70);
    assert.equal(result.isActuallyDancing, true);
  });

  it('headline matches the breakdown for the original failure shape (was 81, now 51)', () => {
    // The validation data point this spec was written to fix:
    // arms 50, legs 75, body 35, timing 45 — Gemini's overall said 51,
    // a separate "boost" pushed the headline to 81. Now the headline IS 51.
    const gemini = makeGemini({
      overall_score: 51,
      components: { arms: 50, legs: 75, body: 35, timing: 45 },
    });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.displayScore, 51);
    assert.equal(result.displayTier, 'TRYING');
    // The Gemini raw is still surfaced for the debug pill.
    assert.equal(result.geminiRawScore, 51);
  });

  it('legsVisible=false excludes legs from the mean and sets components.legs to null', () => {
    const gemini = makeGemini({
      components: { arms: 80, legs: 42, body: 80, timing: 80 },
    });
    const result = computeDeterministicScore(gemini, false);
    assert.equal(result.components.legs, null);
    // (80+80+80)/3 = 80
    assert.equal(result.displayScore, 80);
    assert.equal(result.displayTier, 'SOLID');
  });

  it('legsVisible=true keeps Gemini legs in the components', () => {
    const gemini = makeGemini({
      components: { arms: 80, legs: 42, body: 80, timing: 80 },
    });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.components.legs, 42);
  });
});

describe('computeDeterministicScore — non-attempt path', () => {
  it('non-attempt + legsVisible=true: legs forced to 0; mean includes that 0', () => {
    const gemini = makeGemini({
      is_actually_dancing: false,
      overall_score: 12,
      tier: 'NOT_DANCING',
      // Gemini's legs would default ~75 here — Group 3 forces it to 0
      // so the bar matches reality.
      components: { arms: 5, legs: 75, body: 8, timing: 12 },
    });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.components.legs, 0);
    // (5+0+8+12)/4 = 6.25 → 6
    assert.equal(result.displayScore, 6);
    assert.equal(result.displayTier, 'NOT_DANCING');
    assert.equal(result.isActuallyDancing, false);
  });

  it('non-attempt + legsVisible=false: legs is null; mean excludes legs', () => {
    const gemini = makeGemini({
      is_actually_dancing: false,
      overall_score: 10,
      components: { arms: 10, legs: 75, body: 15, timing: 5 },
    });
    const result = computeDeterministicScore(gemini, false);
    assert.equal(result.components.legs, null);
    // (10+15+5)/3 = 10
    assert.equal(result.displayScore, 10);
    assert.equal(result.displayTier, 'NOT_DANCING');
  });

  it('non-attempt tier is always NOT_DANCING even when components mean to >=40', () => {
    // Group 4 will tighten Gemini so this doesn't happen, but if it does
    // (model contradicts itself), tier must still reflect the canary.
    const gemini = makeGemini({
      is_actually_dancing: false,
      overall_score: 30,
      components: { arms: 60, legs: 50, body: 50, timing: 50 },
    });
    const result = computeDeterministicScore(gemini, true);
    // legs forced to 0 → (60+0+50+50)/4 = 40
    assert.equal(result.displayScore, 40);
    assert.equal(result.displayTier, 'NOT_DANCING');
  });
});

describe('computeDeterministicScore — purity', () => {
  it('is deterministic for the same input', () => {
    const gemini = makeGemini({
      components: { arms: 70, legs: 60, body: 65, timing: 75 },
    });
    const a = computeDeterministicScore(gemini, true);
    const b = computeDeterministicScore(gemini, true);
    assert.deepEqual(a, b);
  });

  it('does not mutate input', () => {
    const gemini = makeGemini();
    const snapshot = JSON.parse(JSON.stringify(gemini));
    computeDeterministicScore(gemini, true);
    assert.deepEqual(gemini, snapshot);
  });

  it('trouble_spots no longer affect the headline', () => {
    // Round 2 dialed displayScore by trouble-spot count; round 3 does not.
    const noSpots = computeDeterministicScore(
      makeGemini({ trouble_spots: [] }),
      true,
    );
    const manySpots = computeDeterministicScore(
      makeGemini({
        trouble_spots: [
          { start_sec: 0, end_sec: 0.5, body_part: 'body', severity: 'major', what_happened: 'x', fix: 'x' },
          { start_sec: 0.5, end_sec: 1, body_part: 'arms', severity: 'major', what_happened: 'x', fix: 'x' },
          { start_sec: 1, end_sec: 1.5, body_part: 'arms', severity: 'moderate', what_happened: 'x', fix: 'x' },
          { start_sec: 1.5, end_sec: 2, body_part: 'arms', severity: 'minor', what_happened: 'x', fix: 'x' },
        ],
      }),
      true,
    );
    assert.equal(noSpots.displayScore, manySpots.displayScore);
  });
});

describe('scoreToTier — boundary cases', () => {
  it('maps scores to tiers at the documented breakpoints', () => {
    assert.equal(scoreToTier(95), 'GROOVY');
    assert.equal(scoreToTier(85), 'GROOVY');
    assert.equal(scoreToTier(84), 'SOLID');
    assert.equal(scoreToTier(75), 'SOLID');
    assert.equal(scoreToTier(74), 'SHAKY');
    assert.equal(scoreToTier(70), 'SHAKY');
    assert.equal(scoreToTier(69), 'TRYING');
    assert.equal(scoreToTier(40), 'TRYING');
    assert.equal(scoreToTier(39), 'NOT_DANCING');
    assert.equal(scoreToTier(0), 'NOT_DANCING');
  });
});
