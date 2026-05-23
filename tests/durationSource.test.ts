import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideAttemptDuration } from '../lib/scoring/gemini/client.ts';

// SPECK overnight Group 1 §duration-source: the inferred duration from
// the EBML byte scan, when valid, is now the authoritative duration —
// not what video.duration reports after the seek-to-MAX_SAFE_INTEGER
// trick. The browser had been winning that contest with a value ~5s
// shorter than the real recording, which cascaded into a 1.4s motion-
// onset slice and Gemini returning is_actually_dancing=false on real
// 7-second performances.
//
// Decision rule under test:
//   - inferredDurationSec is a finite number ≥ 0.5 → use it, no
//     browser-finalize call.
//   - else (null, NaN, < 0.5) → invoke browser-finalize, use whatever
//     it produces.
//
// We mock the finalize side so the test exercises only the decision
// branch without a DOM/<video> harness — the seek-trick math is
// covered separately in webmDuration.test.ts.

describe('decideAttemptDuration — uses webm-repair inferred when plausible', () => {
  it('inferredDurationSec=6.7 → source=webm-repair-inferred, durationSec=6.7, finalize not called', async () => {
    let finalizeCalled = false;
    const decision = await decideAttemptDuration(6.7, async () => {
      finalizeCalled = true;
      return 1.378; // the wrong value the browser would have produced
    });
    assert.equal(decision.source, 'webm-repair-inferred');
    assert.equal(decision.authoritativeDurationSec, 6.7);
    assert.equal(decision.inferredDurationSec, 6.7);
    assert.equal(decision.finalizedDurationSec, null);
    assert.equal(finalizeCalled, false, 'finalize must not run when inferred is valid');
  });

  it('inferredDurationSec exactly at floor (0.5) is accepted as plausible', async () => {
    // Boundary case — the spec says ≥ 0.5, so 0.5 itself should be used
    // without falling through to finalize.
    let finalizeCalled = false;
    const decision = await decideAttemptDuration(0.5, async () => {
      finalizeCalled = true;
      return 99;
    });
    assert.equal(decision.source, 'webm-repair-inferred');
    assert.equal(decision.authoritativeDurationSec, 0.5);
    assert.equal(finalizeCalled, false);
  });

  it('inferredDurationSec=7.0 with a tiny upstream value still picks the inferred', async () => {
    // The headline bug: EBML inferred 6.7, browser produced 1.378. The
    // larger value wins because the decision logic doesn't pick max —
    // it picks the inferred whenever it's plausible. Pin the rule.
    const decision = await decideAttemptDuration(7.0, async () => 1.378);
    assert.equal(decision.authoritativeDurationSec, 7.0);
    assert.equal(decision.source, 'webm-repair-inferred');
  });
});

describe('decideAttemptDuration — falls back to browser-finalize', () => {
  it('inferredDurationSec=null → falls back, source=browser-finalize, uses finalize value', async () => {
    const decision = await decideAttemptDuration(null, async () => 7.0);
    assert.equal(decision.source, 'browser-finalize');
    assert.equal(decision.authoritativeDurationSec, 7.0);
    assert.equal(decision.inferredDurationSec, null);
    assert.equal(decision.finalizedDurationSec, 7.0);
  });

  it('inferredDurationSec=0.2 (implausibly short) → falls back to finalize', async () => {
    // Sub-floor values are treated the same as null — the EBML scan
    // surfaced something but it's too short to be a real attempt.
    let finalizeCalled = false;
    const decision = await decideAttemptDuration(0.2, async () => {
      finalizeCalled = true;
      return 6.5;
    });
    assert.equal(decision.source, 'browser-finalize');
    assert.equal(decision.authoritativeDurationSec, 6.5);
    assert.equal(decision.inferredDurationSec, 0.2);
    assert.equal(decision.finalizedDurationSec, 6.5);
    assert.equal(finalizeCalled, true);
  });

  it('inferredDurationSec=NaN → falls back', async () => {
    // Number.isFinite(NaN) is false. Defensive case: a future change to
    // webmFix could leak NaN; we'd rather fall through than propagate it.
    const decision = await decideAttemptDuration(NaN, async () => 6.0);
    assert.equal(decision.source, 'browser-finalize');
    assert.equal(decision.authoritativeDurationSec, 6.0);
  });

  it('inferredDurationSec=Infinity → falls back', async () => {
    // Same defensive rationale — Number.isFinite catches it.
    const decision = await decideAttemptDuration(Infinity, async () => 6.0);
    assert.equal(decision.source, 'browser-finalize');
    assert.equal(decision.authoritativeDurationSec, 6.0);
  });
});
