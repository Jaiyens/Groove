import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiPrompt } from '../lib/scoring/gemini/prompt.ts';

// These tests don't call Gemini — they verify the constructed prompt
// includes the structural clauses SPECK's acceptance criteria depend on
// (chunk windowing, leg branch, canary). If a future edit accidentally
// drops one of these clauses, the failing test names the missing
// guarantee instead of just shipping a regression.

describe('buildGeminiPrompt — chunk windowing', () => {
  it('interpolates referenceChunkStartSec / referenceChunkEndSec with 2 decimals', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0.5,
      referenceChunkEndSec: 2.0,
    });
    assert.ok(out.includes('0.50s'), 'expected start interpolation "0.50s"');
    assert.ok(out.includes('2.00s'), 'expected end interpolation "2.00s"');
  });

  it('frames the reference as a SHORT CHUNK with padding to ignore', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('SINGLE CHUNK'), 'must call the reference a single chunk');
    assert.ok(out.includes('CHUNK CONTEXT'), 'must include CHUNK CONTEXT section');
    assert.ok(out.match(/padding/i), 'must mention padding seconds to ignore');
  });

  it('instructs the model not to report trouble spots past the choreography end', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('DO NOT report trouble spots past the end of the reference choreography'),
      'must keep the no-past-the-end clause',
    );
  });

  it('keeps trouble-spot timestamps tied to the attempt video duration', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('Within the bounds of the attempt video duration'),
      'must keep the attempt-duration bound on trouble spots',
    );
  });
});

describe('buildGeminiPrompt — legs visibility branch', () => {
  it('legsVisible=true uses the normal-scoring branch', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('legs in frame'), 'expected legs-in-frame language');
    assert.ok(out.includes('Score legs normally'), 'expected normal-scoring instruction');
    assert.ok(!out.includes('UPPER BODY ONLY'), 'upper-body branch must not fire');
  });

  it('legsVisible=false uses the upper-body-only branch with default 75', () => {
    const out = buildGeminiPrompt({
      legsVisible: false,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('UPPER BODY ONLY'), 'expected upper-body-only marker');
    assert.ok(out.includes('default 75'), 'expected generous leg default of 75');
    assert.ok(
      out.includes('Do NOT include leg-related trouble spots'),
      'must suppress leg-related trouble spots',
    );
  });
});

describe('buildGeminiPrompt — canary intact', () => {
  it('preserves the standing-still / random-flailing canary for legsVisible=true', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('CANARY'), 'CANARY section missing');
    assert.ok(out.includes('is_actually_dancing=false'), 'canary must set is_actually_dancing=false');
    assert.ok(out.match(/score below 40/i), 'canary must require score below 40');
    assert.ok(out.includes('standing completely still'), 'canary must catch standing still');
    assert.ok(out.includes('random flailing'), 'canary must catch random flailing');
  });

  it('preserves the canary even when legsVisible=false (generosity does not apply to non-attempts)', () => {
    const out = buildGeminiPrompt({
      legsVisible: false,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('CANARY'), 'CANARY section missing');
    assert.ok(out.includes('is_actually_dancing=false'), 'canary must set is_actually_dancing=false');
    assert.ok(
      out.includes('generosity guidance above does NOT apply to non-attempts'),
      'must explicitly disclaim that legs-generosity does not save a non-attempt',
    );
  });
});

describe('buildGeminiPrompt — mirror grading + style tolerance', () => {
  it('keeps the mirror-copy grading clause', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.match(/mirror copy/i), 'mirror-copy clause missing');
  });

  it('keeps personal-style tolerance so sincere attempts score generously', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('PERSONAL STYLE'), 'PERSONAL STYLE section missing');
    assert.ok(
      out.match(/stylistic variation/i),
      'must not penalize stylistic variation',
    );
  });
});
