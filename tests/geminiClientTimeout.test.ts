import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_MS,
  SERVER_BUDGET_FLOOR_MS,
} from '../lib/scoring/gemini/client.ts';

// SPEC: score-restoration §non-negotiables — "The Gemini timeout budget MUST
// be raised to at least 90000ms." Real-attempt traces showed 40s firing
// before Gemini returned on composite-bytes payloads, forcing silent
// MediaPipe fallbacks. The floor is now 80s server budget; client sits at
// 90s for transport headroom.

describe('scoreWithGemini client timeout', () => {
  it('DEFAULT_TIMEOUT_MS is at least SERVER_BUDGET_FLOOR_MS', () => {
    assert.ok(
      DEFAULT_TIMEOUT_MS >= SERVER_BUDGET_FLOOR_MS,
      `client timeout ${DEFAULT_TIMEOUT_MS}ms must be ≥ server budget floor ${SERVER_BUDGET_FLOOR_MS}ms`,
    );
  });

  it('DEFAULT_TIMEOUT_MS pins to the spec-mandated floor of 90000ms', () => {
    // SPEC: score-restoration non-negotiable. The previous value of 40000ms
    // was causing fallbacks to MediaPipe on real attempts because Gemini's
    // composite-bytes latency routinely exceeded it.
    assert.ok(
      DEFAULT_TIMEOUT_MS >= 90_000,
      `client timeout ${DEFAULT_TIMEOUT_MS}ms must be ≥ 90000ms per SPEC: score-restoration`,
    );
  });
});
