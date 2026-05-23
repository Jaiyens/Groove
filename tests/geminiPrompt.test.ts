import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiPrompt } from '../lib/scoring/gemini/prompt.ts';

// These tests don't call Gemini — they verify the constructed prompt
// includes the structural clauses SPECK's acceptance criteria depend on
// (chunk windowing, leg branch, canary, generosity calibration). If a
// future edit accidentally drops one of these clauses, the failing test
// names the missing guarantee instead of just shipping a regression.

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

  it('keeps the attempt-padding-ignore clauses (lead-in / lead-out)', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('lead-in'), 'must instruct ignore of attempt lead-in');
    assert.ok(out.includes('lead-out'), 'must instruct ignore of attempt lead-out');
    assert.ok(out.includes('IGNORE THE PADDING'), 'must explicitly tell model to ignore reference padding');
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
    assert.ok(out.includes('at 75 by default'), 'expected generous leg default of 75');
    assert.ok(
      out.includes('Do NOT include leg-related trouble spots'),
      'must suppress leg-related trouble spots',
    );
  });
});

describe('buildGeminiPrompt — canary intact (legs branch agnostic)', () => {
  it('preserves the standing-still / random-flailing canary for legsVisible=true', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('CANARY'), 'CANARY section missing');
    assert.ok(out.includes('is_actually_dancing is false'), 'canary must reference is_actually_dancing is false');
    assert.ok(out.match(/MUST be below 40/), 'canary must require score below 40');
    assert.ok(out.includes('Standing still'), 'canary must catch standing still');
    assert.ok(out.match(/random flailing/i), 'canary must catch random flailing');
  });

  it('preserves the canary even when legsVisible=false (generosity does not apply to non-attempts)', () => {
    const out = buildGeminiPrompt({
      legsVisible: false,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('CANARY'), 'CANARY section missing');
    assert.ok(out.includes('is_actually_dancing is false'), 'canary must reference is_actually_dancing is false');
    assert.ok(out.match(/MUST be below 40/), 'canary must require score below 40');
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
    assert.ok(
      out.includes('Smaller motion executed correctly beats bigger motion executed incorrectly'),
      'must include the accuracy-over-energy line',
    );
  });
});

describe('buildGeminiPrompt — generosity calibration', () => {
  it('contains the floor-50 hard rule for sincere attempts', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('overall_score MUST be at least 50'), 'must state floor-50 hard rule');
    assert.ok(out.includes('Floor is 50, no exceptions'), 'must reinforce floor-50 inside zone breakdown');
  });

  it('tightens the definition of a "sincere attempt"', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.match(/sincere attempt/i), 'must define "sincere attempt"');
    assert.ok(
      out.includes('Random arm-waving with no relation to the reference is NOT a sincere attempt'),
      'must explicitly disqualify random arm-waving as sincere',
    );
  });

  it('defines all four zones (0-39 / 40-49 / 50-100, plus SHAKY/SOLID/GROOVY brackets)', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('0-39'), 'must define 0-39 zone');
    assert.ok(out.includes('40-49'), 'must define 40-49 zone');
    assert.ok(out.includes('50-100'), 'must define 50-100 zone');
    assert.ok(out.includes('50-64 SHAKY'), 'must label SHAKY bracket');
    assert.ok(out.includes('65-84 SOLID'), 'must label SOLID bracket');
    assert.ok(out.includes('85-100 GROOVY'), 'must label GROOVY bracket');
  });

  it('includes severity calibration paragraph (most issues MINOR, MAJOR rare)', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('SEVERITY CALIBRATION'), 'must include SEVERITY CALIBRATION section');
    assert.ok(out.includes('Most issues should be MINOR'), 'must say most issues should be MINOR');
    assert.ok(out.match(/MAJOR should be rare/i), 'must say MAJOR should be rare');
    assert.ok(out.includes('MAJOR:'), 'must define MAJOR');
    assert.ok(out.includes('MODERATE:'), 'must define MODERATE');
    assert.ok(out.includes('MINOR:'), 'must define MINOR');
  });

  it('caps trouble spot counts by score bracket', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('TROUBLE SPOT COUNT'), 'must include trouble-spot count cap section');
    assert.ok(out.includes('DO NOT PAD'), 'must explicitly forbid padding the list');
    assert.ok(out.match(/0-39:\*\* 1-3/), 'must cap 0-39 at 1-3');
    assert.ok(out.match(/40-64:\*\* 2-3/), 'must cap 40-64 at 2-3');
    assert.ok(out.match(/65-84:\*\* 1-2/), 'must cap 65-84 at 1-2');
    assert.ok(out.match(/85-100:\*\* 0-1/), 'must cap 85-100 at 0-1');
  });

  it('requires the first insight to be a specific positive observation', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('INSIGHTS'), 'must include INSIGHTS section');
    assert.ok(
      out.includes('FIRST insight MUST be a specific positive observation'),
      'must require first insight is a specific positive observation',
    );
  });

  it('warns against punitive adjectives in insights', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    // The list of disallowed adjectives must appear so future Gemini calls
    // can be lint-checked against this exact set.
    for (const adj of ['"very,"', '"significantly,"', '"completely,"', '"entirely,"', '"totally,"', '"barely,"']) {
      assert.ok(out.includes(adj), `must list ${adj} as a punitive adjective to avoid`);
    }
    assert.ok(out.includes('proportionate language'), 'must direct toward proportionate language');
    assert.ok(out.match(/ACTIONABLE/i), 'insights should be ACTIONABLE');
  });
});
