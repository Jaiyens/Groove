import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderSideBySideVideo,
  __testing,
} from '../lib/scoring/gemini/composite.ts';

// SPECK overnight Group 4: side-by-side composite video renderer.
//
// The renderer's DOM-heavy core (canvas + MediaRecorder + hidden
// <video> elements) is not unit-testable without a browser harness.
// What we CAN pin from a node:test environment:
//   1. Pre-flight argument validation never throws and returns the
//      documented {kind:'failure', reason, detail} shape.
//   2. Environment detection (DOM unavailable, MediaRecorder
//      unavailable, canvas-unavailable) returns the documented
//      failure tags.
//   3. The exported entry point returns a CompositeResult, not a
//      thrown error, for every invalid input shape the spec calls out.
//
// The browser-side happy path is validated via field log inspection
// after a real attempt — see /docs/overnight-status.md.

const { validateArgs, checkEnvironment } = __testing;

function blob(size = 1000, type = 'video/webm'): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

describe('validateArgs — invalid-args paths', () => {
  it('empty referenceUrl returns failure with detail naming the field', () => {
    const r = validateArgs({
      referenceUrl: '',
      attemptBlob: blob(),
      mirror: true,
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 5,
    });
    assert.ok(r);
    assert.equal(r.reason, 'invalid-args');
    assert.match(r.detail!, /referenceUrl/);
  });

  it('empty attempt blob returns failure', () => {
    const r = validateArgs({
      referenceUrl: 'https://example.com/r.mp4',
      attemptBlob: new Blob([], { type: 'video/webm' }),
      mirror: true,
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 5,
    });
    assert.ok(r);
    assert.equal(r.reason, 'invalid-args');
    assert.match(r.detail!, /attemptBlob/);
  });

  it('non-boolean mirror returns failure', () => {
    const r = validateArgs({
      referenceUrl: 'x',
      attemptBlob: blob(),
      // @ts-expect-error — exercising runtime check
      mirror: 'yes',
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 5,
    });
    assert.ok(r);
    assert.equal(r.reason, 'invalid-args');
    assert.match(r.detail!, /mirror/);
  });

  it('negative motionOnsetRefSec returns failure', () => {
    const r = validateArgs({
      referenceUrl: 'x',
      attemptBlob: blob(),
      mirror: true,
      motionOnsetRefSec: -1,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 5,
    });
    assert.ok(r);
    assert.equal(r.reason, 'invalid-args');
  });

  it('chunkDurationSec ≤ 0 returns failure', () => {
    const r = validateArgs({
      referenceUrl: 'x',
      attemptBlob: blob(),
      mirror: true,
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 0,
    });
    assert.ok(r);
    assert.equal(r.reason, 'invalid-args');
  });

  it('chunkDurationSec above the 8s ceiling returns failure', () => {
    // Prevents a buggy caller from asking the renderer to record 30s
    // and burning the 10s internal timeout.
    const r = validateArgs({
      referenceUrl: 'x',
      attemptBlob: blob(),
      mirror: true,
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 30,
    });
    assert.ok(r);
    assert.equal(r.reason, 'invalid-args');
    assert.match(r.detail!, /ceiling/);
  });

  it('happy-path args pass validation (returns null)', () => {
    const r = validateArgs({
      referenceUrl: 'https://cdn.example/r.mp4',
      attemptBlob: blob(),
      mirror: true,
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 5,
    });
    assert.equal(r, null);
  });
});

describe('checkEnvironment — DOM/MediaRecorder gating', () => {
  it('returns dom-unavailable when document is undefined (server-side)', () => {
    // Under node:test there is no `document`, so checkEnvironment
    // should naturally surface this tag.
    const r = checkEnvironment();
    assert.ok(r);
    assert.equal(r.reason, 'dom-unavailable');
  });
});

describe('renderSideBySideVideo — never throws on invalid inputs', () => {
  it('returns a failure for empty referenceUrl (does not throw)', async () => {
    const r = await renderSideBySideVideo({
      referenceUrl: '',
      attemptBlob: blob(),
      mirror: true,
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 5,
    });
    assert.equal(r.kind, 'failure');
  });

  it('returns a failure for empty attempt blob (does not throw)', async () => {
    const r = await renderSideBySideVideo({
      referenceUrl: 'https://example.com/x.mp4',
      attemptBlob: new Blob([], { type: 'video/webm' }),
      mirror: true,
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 5,
    });
    assert.equal(r.kind, 'failure');
  });

  it('returns dom-unavailable in a non-DOM environment', async () => {
    // Valid args, but no DOM in node:test, so the renderer must short-
    // circuit on env check and return the documented failure tag.
    const r = await renderSideBySideVideo({
      referenceUrl: 'https://example.com/x.mp4',
      attemptBlob: blob(),
      mirror: true,
      motionOnsetRefSec: 0,
      motionOnsetAttemptSec: 0,
      chunkDurationSec: 5,
    });
    assert.equal(r.kind, 'failure');
    if (r.kind === 'failure') {
      assert.equal(r.reason, 'dom-unavailable');
    }
  });
});
