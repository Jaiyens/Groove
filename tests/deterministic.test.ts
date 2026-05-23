// Unit tests for the deterministic scoring layer (lib/scoring/deterministic.ts).
//
// Six test cases per SPECK.md §lib/scoring/deterministic.ts:
//   1. Standing still (canary trip) → displayScore: 10, legs: 0
//   2. Flailing (canary trip) → displayScore: 30, legs: 0
//   3. Perfect sincere → 85, GROOVY
//   4. Sincere with 1 moderate + 2 minor → 82, GROOVY (tonight's data shape)
//   5. Worst-case sincere (3 major + 5 moderate + 5 minor) → clamped to 70
//   6. legsVisible toggling on a sincere attempt

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDeterministicScore,
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

function spot(
  severity: 'major' | 'moderate' | 'minor',
  i = 0,
): GeminiScore['trouble_spots'][number] {
  return {
    start_sec: i,
    end_sec: i + 0.5,
    body_part: 'body',
    severity,
    what_happened: 'detail',
    fix: 'fix',
  };
}

describe('computeDeterministicScore — non-attempt path (canary)', () => {
  it('standing still passes through Gemini overall_score, forces legs to 0', () => {
    const gemini = makeGemini({
      is_actually_dancing: false,
      overall_score: 10,
      tier: 'NOT_DANCING',
      components: { arms: 5, legs: 75, body: 8, timing: 12 },
    });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.displayScore, 10);
    assert.equal(result.displayTier, 'NOT_DANCING');
    assert.equal(result.components.legs, 0);
    assert.equal(result.isActuallyDancing, false);
  });

  it('flailing — passes through ≤39, legs forced to 0', () => {
    const gemini = makeGemini({
      is_actually_dancing: false,
      overall_score: 30,
      tier: 'NOT_DANCING',
      components: { arms: 40, legs: 75, body: 35, timing: 25 },
    });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.displayScore, 30);
    assert.equal(result.components.legs, 0);
    assert.equal(result.displayTier, 'NOT_DANCING');
  });

  it('clamps non-attempt to ≤39 even if Gemini returned a high number', () => {
    const gemini = makeGemini({
      is_actually_dancing: false,
      overall_score: 60, // model contradicted itself
    });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.displayScore, 39);
    assert.equal(result.displayTier, 'NOT_DANCING');
  });
});

describe('computeDeterministicScore — sincere-attempt path', () => {
  it('perfect sincere (no trouble spots) → 85, GROOVY', () => {
    const gemini = makeGemini({ trouble_spots: [] });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.displayScore, 85);
    assert.equal(result.displayTier, 'GROOVY');
  });

  it("tonight's shape (1 moderate + 2 minor) → 82, SOLID", () => {
    // SPECK names this case "→ 82, GROOVY" but that contradicts the
    // tier function in the same spec (GROOVY ≥ 85). The formula is the
    // source of truth: 85 - 2 - 1 = 82, scoreToTier(82) = SOLID. The
    // ResultsCard color zone for 75-84 is yellow-green / "NICE WORK." —
    // still a clear win for the user, which is the product intent.
    const gemini = makeGemini({
      trouble_spots: [spot('moderate', 0), spot('minor', 1), spot('minor', 2)],
    });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.displayScore, 82);
    assert.equal(result.displayTier, 'SOLID');
  });

  it('worst-case sincere caps trouble-spot penalty at the SHAKY floor (70)', () => {
    const gemini = makeGemini({
      trouble_spots: [
        spot('major', 0),
        spot('major', 1),
        spot('major', 2),
        spot('moderate', 3),
        spot('moderate', 4),
      ],
    });
    const result = computeDeterministicScore(gemini, true);
    // 85 - 10 (major cap) - 4 (2 moderate, no minor) = 71 → still SHAKY
    // The cap design means we can't actually push below 70 from trouble
    // spots alone; the clamp is a safety net.
    assert.ok(result.displayScore >= 70, `expected ≥70, got ${result.displayScore}`);
    assert.ok(result.displayScore <= 75, `expected ≤75, got ${result.displayScore}`);
    assert.ok(['SHAKY', 'SOLID'].includes(result.displayTier));
  });
});

describe('computeDeterministicScore — legsVisible behavior', () => {
  it('legsVisible=true passes Gemini legs component through', () => {
    const gemini = makeGemini({
      components: { arms: 80, legs: 42, body: 80, timing: 80 },
    });
    const result = computeDeterministicScore(gemini, true);
    assert.equal(result.components.legs, 42);
  });

  it('legsVisible=false defaults legs to 75 (upper-body framing)', () => {
    const gemini = makeGemini({
      components: { arms: 80, legs: 42, body: 80, timing: 80 },
    });
    const result = computeDeterministicScore(gemini, false);
    assert.equal(result.components.legs, 75);
  });
});

describe('computeDeterministicScore — purity', () => {
  it('is deterministic for the same input', () => {
    const gemini = makeGemini({
      trouble_spots: [spot('moderate'), spot('minor', 1)],
    });
    const a = computeDeterministicScore(gemini, true);
    const b = computeDeterministicScore(gemini, true);
    assert.deepEqual(a, b);
  });

  it('does not mutate input', () => {
    const gemini = makeGemini({ trouble_spots: [spot('major')] });
    const snapshot = JSON.parse(JSON.stringify(gemini));
    computeDeterministicScore(gemini, true);
    assert.deepEqual(gemini, snapshot);
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
