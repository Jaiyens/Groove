import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_MS,
  SERVER_BUDGET_FLOOR_MS,
} from '../lib/scoring/gemini/client.ts';

// SPECK: bump the /api/score-gemini client timeout above the server's total
// retry budget so a transient 503 + server-side retry can complete before
// the client gives up. Server budget today: first attempt ~11s + retry ~26s
// + overhead ≈ 37s worst case. The floor enforced here is 35s (one full
// server budget); we currently sit at 40s for a few seconds of headroom.

describe('scoreWithGemini client timeout', () => {
  it('DEFAULT_TIMEOUT_MS is at least SERVER_BUDGET_FLOOR_MS', () => {
    // The whole reason the previous run failed: client timeout 30s, server
    // retry succeeded at 13.6s — but only AFTER the client had already
    // aborted at 30s. If this assert fails again, the regression is
    // exactly that race.
    assert.ok(
      DEFAULT_TIMEOUT_MS >= SERVER_BUDGET_FLOOR_MS,
      `client timeout ${DEFAULT_TIMEOUT_MS}ms must be ≥ server budget floor ${SERVER_BUDGET_FLOOR_MS}ms`,
    );
  });

  it('SERVER_BUDGET_FLOOR_MS is at least 35s (one full server retry budget)', () => {
    assert.ok(
      SERVER_BUDGET_FLOOR_MS >= 35_000,
      `server budget floor ${SERVER_BUDGET_FLOOR_MS}ms must be ≥ 35000ms`,
    );
  });

  it('DEFAULT_TIMEOUT_MS pins to the spec-mandated 40s', () => {
    // The spec asks for exactly 40s — small headroom over the 37s server
    // worst case. If this test fails because the value was raised, that
    // is fine but the spec referenced this constant; review carefully.
    assert.equal(DEFAULT_TIMEOUT_MS, 40_000);
  });
});
