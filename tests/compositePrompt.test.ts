import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCompositePrompt } from '../lib/scoring/gemini/prompt.ts';

// SPECK overnight Group 4 §composite-prompt: buildCompositePrompt is the
// side-by-side variant of buildGeminiPrompt. The Group 4 spec says the
// existing invariants STAY:
//   - canary clause
//   - sincere-attempt floor of 35
//   - severity calibration (MAJOR/MODERATE/MINOR)
//   - tier-capped trouble spots
//   - conditional-positive-insight (first insight conditional on
//     is_actually_dancing)
//   - DO-NOT-INCLUDE for hand details / execution sharpness
// What's NEW is the two-halves framing + mirror-state declaration.

describe('buildCompositePrompt — new framing for the composite case', () => {
  it('frames the input as a single side-by-side video, not two videos', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    // Must NOT use the two-video phrasing from buildGeminiPrompt.
    assert.doesNotMatch(p, /two videos in order/i);
    // Must explicitly tell the model the LEFT/RIGHT halves correspondence.
    assert.match(p, /LEFT half/);
    assert.match(p, /RIGHT half/);
    assert.match(p, /side by side/i);
  });

  it('tells the model that alignment is built in (no temporal inference needed)', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /alignment is built into the video/i);
  });

  it('mirror=true declares direct left/right correspondence', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /Mirror state: ENABLED/);
    assert.match(p, /correspond DIRECTLY/);
  });

  it('mirror=false declares mirror-copy semantics', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: false });
    assert.match(p, /Mirror state: DISABLED/);
    assert.match(p, /mirror copy/);
  });
});

describe('buildCompositePrompt — preserved invariants from buildGeminiPrompt', () => {
  it('preserves the is_actually_dancing canary with the same trigger conditions', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /is_actually_dancing/);
    assert.match(p, /CANARY/);
    assert.match(p, /flailing/i);
    assert.match(p, /out of frame for more than 30%/i);
  });

  it('preserves the sincere-attempt floor of 35', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /No individual component score may be below 35/);
  });

  it('preserves the MAJOR/MODERATE/MINOR severity calibration', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /\*\*MAJOR:\*\*/);
    assert.match(p, /\*\*MODERATE:\*\*/);
    assert.match(p, /\*\*MINOR:\*\*/);
  });

  it('preserves tier-capped trouble-spot counts', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /tier: GROOVY:\*\* at most 2 trouble spots/);
    assert.match(p, /tier: SOLID:\*\* at most 3 trouble spots/);
    assert.match(p, /tier: SHAKY:\*\* at most 4 trouble spots/);
    assert.match(p, /tier: NOT_DANCING:\*\* exactly 1 trouble spot/);
  });

  it('preserves the DO-NOT-INCLUDE for hand details', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /HAND AND FINGER DETAILS ARE MINOR/);
  });

  it('preserves the EXECUTION QUALITY IS MINOR clause', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /EXECUTION QUALITY IS MINOR/);
  });

  it('preserves the conditional-positive-insight rule', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /FIRST insight MUST be a specific positive observation/);
    assert.match(p, /Do NOT lead with a fake compliment/);
  });

  it('preserves the JSON-only output instruction', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /Return ONLY valid JSON/);
    assert.match(p, /No prose, no markdown/);
  });
});

describe('buildCompositePrompt — legsVisible branching', () => {
  it('legsVisible=true tells the model to score legs normally', () => {
    const p = buildCompositePrompt({ legsVisible: true, mirror: true });
    assert.match(p, /Score the legs component normally/);
    assert.doesNotMatch(p, /Set the legs component to null/);
  });

  it('legsVisible=false tells the model to set legs to null', () => {
    const p = buildCompositePrompt({ legsVisible: false, mirror: true });
    assert.match(p, /Set the legs component to null/);
    assert.match(p, /UPPER BODY ONLY/);
  });
});
