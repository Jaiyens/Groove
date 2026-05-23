import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiPrompt } from '../lib/scoring/gemini/prompt.ts';

// These tests don't call Gemini — they verify the constructed prompt
// includes the structural clauses SPECK's acceptance criteria depend on
// (chunk windowing, leg branch, canary, generosity calibration). If a
// future edit accidentally drops one of these clauses, the failing test
// names the missing guarantee instead of just shipping a regression.

describe('buildGeminiPrompt — chunk windowing (motion-onset trimmed default)', () => {
  // SPECK round-3 §Group-2: with both videos pre-trimmed to their motion
  // onset, the prompt drops the padding-ignore language and tells the model
  // both videos START at the first dance frame.

  it('interpolates the choreography end time with 2 decimals (single value, no start)', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 2.0,
    });
    assert.ok(out.includes('2.00s'), 'expected end interpolation "2.00s"');
  });

  it('asserts "first dance movement" and no pre-roll padding', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('CHUNK CONTEXT'), 'must include CHUNK CONTEXT section');
    assert.ok(
      out.includes('start exactly at the moment of first dance movement'),
      'must announce both videos start at first movement',
    );
    assert.ok(
      out.includes('There is no pre-roll padding'),
      'must state there is no pre-roll padding',
    );
    assert.ok(
      out.includes('All trouble spots must reference timestamps within the dance, not before it'),
      'must require trouble spots to fall inside the dance',
    );
  });

  it('caps trouble spots at the choreography end (motion-onset branch)', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('DO NOT report trouble spots past that point'),
      'must keep an end-cap clause referring to the choreography end',
    );
  });

  it('drops the legacy padding-ignore clauses on the default (trimmed) branch', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      !out.includes('IGNORE THE PADDING'),
      'IGNORE THE PADDING must NOT appear in the trimmed branch',
    );
    assert.ok(
      !out.match(/\blead-in\b/),
      'attempt lead-in clause must NOT appear in the trimmed branch',
    );
    assert.ok(
      !out.match(/\blead-out\b/),
      'attempt lead-out clause must NOT appear in the trimmed branch',
    );
  });
});

describe('buildGeminiPrompt — chunk windowing (videosMotionOnsetTrimmed=false fallback)', () => {
  // When the client couldn't motion-onset-trim either video, the prompt has
  // to keep the older padding-ignore language so the model still has guidance.

  it('keeps the SHORT CHUNK / padding language', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0.5,
      referenceChunkEndSec: 2.0,
      videosMotionOnsetTrimmed: false,
    });
    assert.ok(out.includes('SINGLE CHUNK'), 'must call the reference a single chunk');
    assert.ok(out.includes('CHUNK CONTEXT'), 'must include CHUNK CONTEXT section');
    assert.ok(out.match(/padding/i), 'must mention padding seconds to ignore');
    assert.ok(out.includes('0.50s'), 'must interpolate the chunk start in fallback');
    assert.ok(out.includes('2.00s'), 'must interpolate the chunk end in fallback');
  });

  it('keeps the attempt lead-in / lead-out clauses in fallback', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
      videosMotionOnsetTrimmed: false,
    });
    assert.ok(out.includes('lead-in'), 'must instruct ignore of attempt lead-in');
    assert.ok(out.includes('lead-out'), 'must instruct ignore of attempt lead-out');
    assert.ok(out.includes('IGNORE THE PADDING'), 'must explicitly tell model to ignore reference padding');
  });

  it('keeps the no-past-the-end clause in fallback', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
      videosMotionOnsetTrimmed: false,
    });
    assert.ok(
      out.includes('DO NOT report trouble spots past the end of the reference choreography'),
      'must keep the legacy no-past-the-end clause in fallback',
    );
  });
});

describe('buildGeminiPrompt — legs visibility branch (SPECK round-3 §Group-4)', () => {
  it('legsVisible=true uses the normal-scoring branch', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('legs in frame'), 'expected legs-in-frame language');
    assert.ok(out.match(/Score the legs component normally/i), 'expected normal-scoring instruction');
    assert.ok(!out.includes('UPPER BODY ONLY'), 'upper-body branch must not fire');
  });

  it('legsVisible=false sets legs to null (no more default 75)', () => {
    const out = buildGeminiPrompt({
      legsVisible: false,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('UPPER BODY ONLY'), 'expected upper-body-only marker');
    assert.ok(
      out.includes('Set the legs component to null'),
      'must instruct legs: null rather than default 75',
    );
    assert.ok(
      !out.includes('at 75 by default'),
      'old default-75 language must be gone',
    );
    assert.ok(
      out.includes('Do NOT include leg-related trouble spots'),
      'must suppress leg-related trouble spots',
    );
  });
});

describe('buildGeminiPrompt — canary (binary AND quantitative)', () => {
  it('step 1 names the three trip conditions (a/b/c)', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('STEP 1 — DECIDE is_actually_dancing'),
      'must call out STEP 1 canary heading',
    );
    assert.ok(out.includes('(a)'), 'must label condition (a)');
    assert.ok(out.includes('postural sway'), 'condition (a) — postural sway only');
    assert.ok(out.includes('(b)'), 'must label condition (b)');
    assert.ok(out.includes('uncorrelated with the reference'), 'condition (b) — flailing not copying');
    assert.ok(out.includes('(c)'), 'must label condition (c)');
    assert.ok(out.match(/out of frame.*30%/), 'condition (c) — out of frame >30%');
  });

  it('forces overall_score into 5-25 on canary trip', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.match(/overall_score to a value between 5 and 25/),
      'must require overall_score in [5,25] when canary trips',
    );
  });

  it('forbids padding components upward on canary trip', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.match(/[Dd]o NOT pad components upward/),
      'must forbid padding components upward to feel kind',
    );
    // Worked examples should anchor the model.
    assert.ok(
      out.includes('arms: 15'),
      'must give the flailing arms: 15 example',
    );
    assert.ok(
      out.includes('body: 5'),
      'must give the standing-still body: 5 example',
    );
  });

  it('canary fires on both legs branches', () => {
    const outLegs = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    const outUpper = buildGeminiPrompt({
      legsVisible: false,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    for (const out of [outLegs, outUpper]) {
      assert.ok(out.includes('STEP 1 — DECIDE is_actually_dancing'));
      assert.ok(out.match(/between 5 and 25/));
    }
  });
});

describe('buildGeminiPrompt — sincere-attempt component floor (SPECK round-3 §Group-4 §2)', () => {
  it('declares the per-component floor of 35 for sincere attempts', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('STEP 2 — SINCERE-ATTEMPT FLOOR'),
      'must call out STEP 2 floor heading',
    );
    assert.ok(
      out.match(/No individual component score may be below 35/),
      'must state the 35 component floor',
    );
    assert.ok(
      out.match(/zero effort/),
      'must allow the "zero effort on that axis" escape hatch',
    );
  });
});

describe('buildGeminiPrompt — mirror grading + style tolerance', () => {
  // SPECK round-3 §Group-1: the client now horizontally flips the reference
  // in the same canvas pass that trims it, so left/right corresponds directly
  // and the model grades literally. The legacy "mirror copy" clause survives
  // only as a fallback when client-side trim/flip failed.

  it('default (referenceMirrored=true) uses the literal-left/right clause and drops mirror-copy', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('REFERENCE video has been horizontally mirrored'),
      'must announce the reference is pre-mirrored',
    );
    assert.ok(
      out.match(/Grade left and right literally/i),
      'must instruct literal left/right grading',
    );
    assert.ok(
      !out.match(/mirror copy/i),
      'old mirror-copy clause must be removed in the mirrored branch',
    );
  });

  it('explicit referenceMirrored=true matches the default', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
      referenceMirrored: true,
    });
    assert.ok(out.includes('REFERENCE video has been horizontally mirrored'));
    assert.ok(!out.match(/mirror copy/i));
  });

  it('referenceMirrored=false keeps the legacy mirror-copy clause for the un-trimmed fallback', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
      referenceMirrored: false,
    });
    assert.ok(
      out.match(/mirror copy/i),
      'fallback branch must still hand the model the mirror-copy rule',
    );
    assert.ok(
      !out.includes('REFERENCE video has been horizontally mirrored'),
      'fallback branch must NOT claim the reference was pre-mirrored',
    );
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

describe('buildGeminiPrompt — severity calibration', () => {
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
});

describe('buildGeminiPrompt — trouble-spot caps by tier (SPECK round-3 §Group-4 §4)', () => {
  it('caps the count by the result tier, not by overall_score bracket', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('TROUBLE SPOT COUNT'), 'must include trouble-spot count cap section');
    assert.ok(out.match(/tier: GROOVY.*at most 2/), 'GROOVY ≤ 2');
    assert.ok(out.match(/tier: SOLID.*at most 3/), 'SOLID ≤ 3');
    assert.ok(out.match(/tier: SHAKY.*at most 4/), 'SHAKY ≤ 4');
    assert.ok(out.match(/tier: NOT_DANCING.*exactly 1/), 'NOT_DANCING exactly 1');
  });

  it("NOT_DANCING's one trouble spot is a summary, not a nit-pick", () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.match(/didn't look like an attempt at the dance/),
      'NOT_DANCING summary copy must be present',
    );
  });

  it("drops the old overall_score-bracket caps (0-39 / 40-64 / 65-84 / 85-100)", () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(!out.match(/overall_score 0-39:\*\* 1-3/), 'old 0-39 cap must be gone');
    assert.ok(!out.match(/overall_score 40-64:\*\* 2-3/), 'old 40-64 cap must be gone');
  });
});

describe('buildGeminiPrompt — insights conditional on is_actually_dancing (SPECK round-3 §Group-4 §5)', () => {
  it('keeps the punitive-adjective ban', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    for (const adj of ['"very,"', '"significantly,"', '"completely,"', '"entirely,"', '"totally,"', '"barely,"']) {
      assert.ok(out.includes(adj), `must list ${adj} as a punitive adjective to avoid`);
    }
    assert.ok(out.includes('proportionate language'), 'must direct toward proportionate language');
    assert.ok(out.match(/ACTIONABLE/i), 'insights should be ACTIONABLE');
  });

  it("requires the first insight to be a specific positive observation when is_actually_dancing: true", () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(out.includes('INSIGHTS'), 'must include INSIGHTS section');
    assert.ok(
      out.match(/If is_actually_dancing: true/),
      'must have an is_actually_dancing: true branch in INSIGHTS',
    );
    assert.ok(
      out.includes('FIRST insight MUST be a specific positive observation'),
      'must require first insight is a specific positive observation',
    );
  });

  it("forbids a fake compliment when is_actually_dancing: false", () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.match(/If is_actually_dancing: false/),
      'must have an is_actually_dancing: false branch in INSIGHTS',
    );
    assert.ok(
      out.match(/Do NOT pretend there was good work/),
      'must explicitly forbid pretending there was good work to praise',
    );
    assert.ok(
      out.match(/fake compliment/i),
      'must reinforce no fake compliments',
    );
  });
});

describe('buildGeminiPrompt — hand-detail + execution-quality clauses', () => {
  // SPECK §deterministic-scoring §prompt.ts: two surgical additions to
  // stop the model from tagging stylistic noise (rock-on hand, crispness
  // notes) as MODERATE. Both clauses must fire in BOTH leg-visibility
  // branches.

  it('HAND AND FINGER DETAILS clause is present (legsVisible=true)', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('HAND AND FINGER DETAILS ARE MINOR'),
      'HAND AND FINGER DETAILS heading missing in legsVisible=true branch',
    );
    assert.ok(
      out.includes('rock-on'),
      'must explicitly name rock-on as a hand-signal example',
    );
    assert.ok(
      out.match(/finger guns/i),
      'must explicitly name finger guns as a hand-signal example',
    );
    assert.ok(
      out.match(/peace signs/i),
      'must explicitly name peace signs as a hand-signal example',
    );
  });

  it('HAND AND FINGER DETAILS clause is present (legsVisible=false)', () => {
    const out = buildGeminiPrompt({
      legsVisible: false,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('HAND AND FINGER DETAILS ARE MINOR'),
      'HAND AND FINGER DETAILS heading missing in legsVisible=false branch',
    );
    assert.ok(out.includes('rock-on'));
  });

  it('EXECUTION QUALITY clause is present (legsVisible=true)', () => {
    const out = buildGeminiPrompt({
      legsVisible: true,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('EXECUTION QUALITY IS MINOR'),
      'EXECUTION QUALITY heading missing in legsVisible=true branch',
    );
    for (const word of ['extension', 'crispness', 'sharpness', 'isolation', 'fullness']) {
      assert.ok(
        out.includes(word),
        `EXECUTION QUALITY clause must list "${word}" as a stylistic concern`,
      );
    }
    assert.ok(
      out.match(/wrong direction, wrong arm, wrong body part/i),
      'EXECUTION QUALITY must define the escalation condition (wrong move entirely)',
    );
  });

  it('EXECUTION QUALITY clause is present (legsVisible=false)', () => {
    const out = buildGeminiPrompt({
      legsVisible: false,
      referenceChunkStartSec: 0,
      referenceChunkEndSec: 1.5,
    });
    assert.ok(
      out.includes('EXECUTION QUALITY IS MINOR'),
      'EXECUTION QUALITY heading missing in legsVisible=false branch',
    );
    assert.ok(out.includes('crispness'));
  });
});
