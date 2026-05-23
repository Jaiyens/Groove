import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffScalarKeys, extractScalarKeys, formatCell } from '../app/debug/scoring/diff.ts';

// SPECK overnight Track 2 §debug-scoring: smoke tests for the pure
// helpers used by /debug/scoring. We can't mount the React page from
// node's test runner without JSDOM, but the diff/format helpers are
// the eval-harness primitive — pinning them is the highest-leverage
// thing to test.

describe('extractScalarKeys', () => {
  it('pulls keys from a raw Gemini score object', () => {
    const score = {
      is_actually_dancing: true,
      tier: 'GROOVY',
      overall_score: 88,
      timing: 90,
      body_isolation: 85,
    };
    const out = extractScalarKeys(score);
    assert.equal(out.is_actually_dancing, true);
    assert.equal(out.tier, 'GROOVY');
    assert.equal(out.overall_score, 88);
    assert.equal(out.timing, 90);
    assert.equal(out.body_isolation, 85);
  });

  it('unwraps the api { score, latencyMs } envelope', () => {
    const api = {
      score: { tier: 'SOLID', overall_score: 76 },
      latencyMs: 1300,
    };
    const out = extractScalarKeys(api);
    assert.equal(out.tier, 'SOLID');
    assert.equal(out.overall_score, 76);
  });

  it('returns an empty object for non-object input', () => {
    assert.deepEqual(extractScalarKeys(null), {});
    assert.deepEqual(extractScalarKeys('nope'), {});
    assert.deepEqual(extractScalarKeys(123), {});
  });

  it('reads scalar keys from a nested components object too', () => {
    const score = {
      tier: 'SHAKY',
      components: { timing: 60, shape_accuracy: 50 },
    };
    const out = extractScalarKeys(score);
    assert.equal(out.tier, 'SHAKY');
    assert.equal(out.timing, 60);
    assert.equal(out.shape_accuracy, 50);
  });
});

describe('diffScalarKeys', () => {
  it('marks identical payloads as unchanged across every shared key', () => {
    const a = { score: { tier: 'GROOVY', overall_score: 88 } };
    const rows = diffScalarKeys(a, a);
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.changed, false, `key ${row.key} should not be changed`);
    }
  });

  it('flags scalar changes between before/after', () => {
    const before = { score: { tier: 'GROOVY', overall_score: 88, timing: 90 } };
    const after = { score: { tier: 'SOLID', overall_score: 76, timing: 90 } };
    const rows = diffScalarKeys(before, after);
    const tier = rows.find((r) => r.key === 'tier')!;
    const overall = rows.find((r) => r.key === 'overall_score')!;
    const timing = rows.find((r) => r.key === 'timing')!;
    assert.equal(tier.changed, true);
    assert.equal(overall.changed, true);
    assert.equal(timing.changed, false);
  });

  it('keeps known scoring keys ordered ahead of unrecognised extras', () => {
    // Mix a known key with a payload extra (`weird_extra`) — known keys
    // come first regardless of alphabetical order. extractScalarKeys only
    // emits SCALAR_KEYS_OF_INTEREST entries; an unrelated key won't appear
    // unless we mock the extractor, so we test the sort by comparing two
    // known keys' relative order.
    const before = { score: { tier: 'GROOVY', overall_score: 88 } };
    const after = { score: { tier: 'SOLID', overall_score: 76 } };
    const rows = diffScalarKeys(before, after);
    const tierIdx = rows.findIndex((r) => r.key === 'tier');
    const overallIdx = rows.findIndex((r) => r.key === 'overall_score');
    assert.ok(tierIdx >= 0 && overallIdx >= 0);
    // tier (index 1 in SCALAR_KEYS_OF_INTEREST) sorts ahead of
    // overall_score (index 2).
    assert.ok(tierIdx < overallIdx, 'tier sorts ahead of overall_score');
  });

  it('handles one-sided keys (present only in before or after)', () => {
    const before = { score: { tier: 'GROOVY', overall_score: 88 } };
    const after = { score: { tier: 'GROOVY' } };
    const rows = diffScalarKeys(before, after);
    const overall = rows.find((r) => r.key === 'overall_score')!;
    assert.equal(overall.before, 88);
    assert.equal(overall.after, undefined);
    assert.equal(overall.changed, true);
  });
});

describe('formatCell', () => {
  it('renders missing values as em-dash', () => {
    assert.equal(formatCell(undefined), '—');
  });
  it('renders null explicitly so the user can tell undefined apart from null', () => {
    assert.equal(formatCell(null), 'null');
  });
  it('renders booleans + numbers as their string form', () => {
    assert.equal(formatCell(true), 'true');
    assert.equal(formatCell(42), '42');
  });
  it('renders objects as <obj> (full JSON lives in the Response tab)', () => {
    assert.equal(formatCell({ tier: 'GROOVY' }), '<obj>');
  });
});
