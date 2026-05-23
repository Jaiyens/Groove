import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCompositePrompt } from '../lib/scoring/gemini/prompt.ts';

// SPEC: score-restoration. The composite prompt was rewritten from scratch
// using SPECK.md as source of truth (see docs/score-restoration-investigation.md
// for the picked-good-vs-fallback decision). These tests lock down the
// non-negotiables from the spec so a future prompt edit can't quietly drop
// the side-by-side framing, calibration anchors, motion-onset value, or
// JSON-schema instructions.

describe('buildCompositePrompt — section ordering (spec §Implementation phase a→g)', () => {
  it('emits sections (a) through (g) in spec order', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0.16,
    });
    const sectionOrder = [
      '(a) SIDE-BY-SIDE FRAMING',
      '(b) WHAT TO COMPARE',
      '(c) MOTION ONSET',
      '(d) PARTIAL VISIBILITY',
      '(e) CALIBRATION ANCHORS',
      '(f) PHILOSOPHICAL FRAMING',
      '(g) RESPONSE SCHEMA',
    ];
    let cursor = 0;
    for (const section of sectionOrder) {
      const idx = p.indexOf(section, cursor);
      assert.notEqual(idx, -1, `missing section: ${section}`);
      cursor = idx;
    }
  });
});

describe('buildCompositePrompt — side-by-side framing (section a)', () => {
  it('opens with the side-by-side comparison framing', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /side-by-side comparison video/i);
    assert.match(p, /LEFT half is the reference dancer/);
    assert.match(p, /RIGHT half is a user attempting/);
    assert.match(p, /how well the user .right. matches the reference .left./i);
  });
});

describe('buildCompositePrompt — what to compare / what to ignore (section b)', () => {
  it('lists the body-mechanic things to compare and the irrelevant things to ignore', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /timing on the beat/);
    assert.match(p, /direction of weight transfer/);
    assert.match(p, /arm position/);
    assert.match(p, /Do NOT score based on: facial expression, outfit, lighting, background/);
  });
});

describe('buildCompositePrompt — motion onset (section c)', () => {
  it('inlines the motionOnsetSec value with 2-decimal formatting', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0.16,
    });
    assert.match(p, /first frame of real dance movement is at 0\.16s/);
    assert.match(p, /Begin grading from 0\.16s onward/);
  });
});

describe('buildCompositePrompt — partial visibility (section d)', () => {
  it('legsVisible=true: tells the model the user is fully in frame', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /full body in frame/);
  });

  it('legsVisible=false: routes the model to visibility_notes and avoids zeroing the score', () => {
    const p = buildCompositePrompt({
      legsVisible: false,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /UPPER BODY ONLY/);
    assert.match(p, /Note this in visibility_notes/);
    assert.match(p, /do NOT penalize for the missing legs/);
  });
});

describe('buildCompositePrompt — calibration anchors (section e)', () => {
  it('includes all five tier descriptions verbatim from the spec', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /\*\*90-100 \(GROOVY\):\*\*/);
    assert.match(p, /\*\*75-89 \(SOLID\):\*\*/);
    assert.match(p, /\*\*60-74 \(ALMOST\):\*\*/);
    assert.match(p, /\*\*40-59 \(WARMING UP\):\*\*/);
    assert.match(p, /\*\*Below 40 \(JUST STARTED\):\*\*/);
  });

  it('reminds the model to use the underscored tier identifiers in JSON', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /WARMING_UP/);
    assert.match(p, /JUST_STARTED/);
  });
});

describe('buildCompositePrompt — philosophical framing (section f)', () => {
  it('includes the "be honest, but be kind" framing', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /similarity to a professional reference, not on absolute dance skill/);
    assert.match(p, /Be honest, but be kind/);
  });

  it('requires did_well + work_on to cite a specific body part or beat', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /did_well MUST cite a specific body part or beat/);
    assert.match(p, /drillable in roughly 90 seconds/);
  });
});

describe('buildCompositePrompt — response schema (section g)', () => {
  it('includes the JSON response schema and BOTH worked examples verbatim', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /"score": <integer 0-100>/);
    assert.match(p, /"tier": "GROOVY" \| "SOLID" \| "ALMOST" \| "WARMING_UP" \| "JUST_STARTED"/);
    assert.match(p, /"score": 78/);
    assert.match(p, /left-to-right hip shift/);
    assert.match(p, /"score": 72/);
    assert.match(p, /Legs were not visible in frame/);
  });

  it('forbids markdown fences and prose preamble', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /No markdown fences, no prose preamble/);
  });
});

describe('buildCompositePrompt — mirror branch', () => {
  it('mirror=true: declares direct left/right correspondence', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: true,
      motionOnsetSec: 0,
    });
    assert.match(p, /LEFT half has been horizontally mirrored/);
    assert.match(p, /correspond DIRECTLY/);
  });

  it('mirror=false: declares mirror-copy semantics', () => {
    const p = buildCompositePrompt({
      legsVisible: true,
      mirror: false,
      motionOnsetSec: 0,
    });
    assert.match(p, /Grade as a mirror copy/);
  });
});
