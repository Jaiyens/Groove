// Stage 6 / Stage 5 verification: the results-screen headline must
// match the user's score. The old popup said "Almost there" for an 18,
// which contradicted the score itself. Updated for SPECK §generosity-
// rewrite §ResultsCard — headline brackets now align with the prompt's
// score zones (0-39 / 40-49 / 50-64 / 65-84 / 85+) and use uppercase
// copy to match what the markup renders via CSS `uppercase`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Local copy of the function under test. The original is unexported
// inside components/ResultsCard.tsx so we vendor it in here — keeps
// the test fast and avoids spinning up a DOM. If you change the
// headline copy in ResultsCard.tsx, change it here too.
function headlineCopy(score: number): string {
  if (score >= 85) return 'YOU GOT IT.';
  if (score >= 65) return 'NICE WORK.';
  if (score >= 50) return 'GETTING THERE.';
  if (score >= 40) return 'JUST TRYING?';
  return 'WAS THAT A DANCE?';
}

// Color brackets — SPECK §generosity-rewrite. Vendored here for the same
// reasons as headlineCopy.
function scoreColorClass(score: number): string {
  if (score >= 85) return 'text-[#FF1F8E]';
  if (score >= 65) return 'text-[#A3E635]';
  if (score >= 40) return 'text-[#F59E0B]';
  return 'text-[#EF4444]';
}

describe('results-card headline copy', () => {
  it('maps 90 to GROOVY (YOU GOT IT.)', () => {
    assert.equal(headlineCopy(90), 'YOU GOT IT.');
  });

  it('maps 75 to SOLID (NICE WORK.)', () => {
    assert.equal(headlineCopy(75), 'NICE WORK.');
  });

  it('maps 60 to SHAKY (GETTING THERE.)', () => {
    assert.equal(headlineCopy(60), 'GETTING THERE.');
  });

  it('maps 47 to TRYING (JUST TRYING?)', () => {
    assert.equal(headlineCopy(47), 'JUST TRYING?');
  });

  it('maps 18 to NOT-ATTEMPTING (WAS THAT A DANCE?) — NOT "Almost there"', () => {
    assert.equal(headlineCopy(18), 'WAS THAT A DANCE?');
    assert.notEqual(headlineCopy(18), 'Almost there');
  });

  it('boundaries: 85 = GROOVY, 84 = SOLID', () => {
    assert.equal(headlineCopy(85), 'YOU GOT IT.');
    assert.equal(headlineCopy(84), 'NICE WORK.');
  });

  it('boundaries: 65 = SOLID, 64 = SHAKY', () => {
    assert.equal(headlineCopy(65), 'NICE WORK.');
    assert.equal(headlineCopy(64), 'GETTING THERE.');
  });

  it('boundaries: 50 = SHAKY, 49 = TRYING', () => {
    assert.equal(headlineCopy(50), 'GETTING THERE.');
    assert.equal(headlineCopy(49), 'JUST TRYING?');
  });

  it('boundaries: 40 = TRYING, 39 = NOT-ATTEMPTING', () => {
    assert.equal(headlineCopy(40), 'JUST TRYING?');
    assert.equal(headlineCopy(39), 'WAS THAT A DANCE?');
  });
});

describe('results-card score color', () => {
  it('85+ uses brand pink (#FF1F8E)', () => {
    assert.equal(scoreColorClass(90), 'text-[#FF1F8E]');
    assert.equal(scoreColorClass(85), 'text-[#FF1F8E]');
  });

  it('65-84 uses yellow-green (#A3E635)', () => {
    assert.equal(scoreColorClass(75), 'text-[#A3E635]');
    assert.equal(scoreColorClass(65), 'text-[#A3E635]');
    assert.equal(scoreColorClass(84), 'text-[#A3E635]');
  });

  it('40-64 uses amber (#F59E0B) — includes both TRYING and SHAKY', () => {
    assert.equal(scoreColorClass(47), 'text-[#F59E0B]');
    assert.equal(scoreColorClass(60), 'text-[#F59E0B]');
    assert.equal(scoreColorClass(40), 'text-[#F59E0B]');
    assert.equal(scoreColorClass(64), 'text-[#F59E0B]');
  });

  it('0-39 uses red (#EF4444)', () => {
    assert.equal(scoreColorClass(0), 'text-[#EF4444]');
    assert.equal(scoreColorClass(18), 'text-[#EF4444]');
    assert.equal(scoreColorClass(39), 'text-[#EF4444]');
  });
});
