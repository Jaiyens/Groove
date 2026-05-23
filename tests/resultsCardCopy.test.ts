// Headline + color brackets for the results card. Updated for SPECK
// §deterministic-scoring §ResultsCard — new zones (75-84 yellow-green,
// 70-74 amber) and new headline copy (85+ "GROOVY!").
//
// The deterministic formula floors sincere attempts at 70, so the
// 40-69 amber band is reached only by the MediaPipe fallback.
// "JUST TRYING?" stays as the fallback-band headline so the user still
// gets coherent copy when Gemini fails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Local copy of the functions under test. Vendored here so the suite
// stays fast and node-only. If you change the brackets in
// components/ResultsCard.tsx, change them here too.
function headlineCopy(score: number): string {
  if (score >= 85) return 'GROOVY!';
  if (score >= 75) return 'NICE WORK.';
  if (score >= 70) return 'GETTING THERE.';
  if (score >= 40) return 'JUST TRYING?';
  return 'WAS THAT A DANCE?';
}

function scoreColorClass(score: number): string {
  if (score >= 85) return 'text-[#FF1F8E]';
  if (score >= 75) return 'text-[#A3E635]';
  if (score >= 40) return 'text-[#F59E0B]';
  return 'text-[#EF4444]';
}

describe('results-card headline copy — deterministic-scoring zones', () => {
  it('maps 90 to GROOVY!', () => {
    assert.equal(headlineCopy(90), 'GROOVY!');
  });

  it('maps 82 to NICE WORK. (SOLID zone)', () => {
    // 82 is the canonical "tonight's sincere" score under the
    // deterministic formula (85 - 1 moderate - 2 minor).
    assert.equal(headlineCopy(82), 'NICE WORK.');
  });

  it('maps 78 to NICE WORK.', () => {
    assert.equal(headlineCopy(78), 'NICE WORK.');
  });

  it('maps 72 to GETTING THERE. (SHAKY zone)', () => {
    assert.equal(headlineCopy(72), 'GETTING THERE.');
  });

  it('maps 50 to JUST TRYING? (fallback-only band)', () => {
    assert.equal(headlineCopy(50), 'JUST TRYING?');
  });

  it('maps 30 to WAS THAT A DANCE?', () => {
    assert.equal(headlineCopy(30), 'WAS THAT A DANCE?');
  });

  it('boundary: 85 = GROOVY!, 84 = NICE WORK.', () => {
    assert.equal(headlineCopy(85), 'GROOVY!');
    assert.equal(headlineCopy(84), 'NICE WORK.');
  });

  it('boundary: 75 = NICE WORK., 74 = GETTING THERE.', () => {
    assert.equal(headlineCopy(75), 'NICE WORK.');
    assert.equal(headlineCopy(74), 'GETTING THERE.');
  });

  it('boundary: 70 = GETTING THERE., 69 = JUST TRYING?', () => {
    assert.equal(headlineCopy(70), 'GETTING THERE.');
    assert.equal(headlineCopy(69), 'JUST TRYING?');
  });

  it('boundary: 40 = JUST TRYING?, 39 = WAS THAT A DANCE?', () => {
    assert.equal(headlineCopy(40), 'JUST TRYING?');
    assert.equal(headlineCopy(39), 'WAS THAT A DANCE?');
  });
});

describe('results-card score color — deterministic-scoring zones', () => {
  it('85+ uses brand pink (#FF1F8E)', () => {
    assert.equal(scoreColorClass(90), 'text-[#FF1F8E]');
    assert.equal(scoreColorClass(85), 'text-[#FF1F8E]');
  });

  it('75-84 uses yellow-green (#A3E635) — the SOLID band', () => {
    assert.equal(scoreColorClass(82), 'text-[#A3E635]');
    assert.equal(scoreColorClass(78), 'text-[#A3E635]');
    assert.equal(scoreColorClass(75), 'text-[#A3E635]');
    assert.equal(scoreColorClass(84), 'text-[#A3E635]');
  });

  it('70-74 uses amber (#F59E0B) — the SHAKY floor for sincere attempts', () => {
    assert.equal(scoreColorClass(72), 'text-[#F59E0B]');
    assert.equal(scoreColorClass(70), 'text-[#F59E0B]');
    assert.equal(scoreColorClass(74), 'text-[#F59E0B]');
  });

  it('40-69 still amber — fallback-band TRYING', () => {
    assert.equal(scoreColorClass(50), 'text-[#F59E0B]');
    assert.equal(scoreColorClass(40), 'text-[#F59E0B]');
    assert.equal(scoreColorClass(69), 'text-[#F59E0B]');
  });

  it('0-39 uses red (#EF4444)', () => {
    assert.equal(scoreColorClass(0), 'text-[#EF4444]');
    assert.equal(scoreColorClass(30), 'text-[#EF4444]');
    assert.equal(scoreColorClass(39), 'text-[#EF4444]');
  });
});
