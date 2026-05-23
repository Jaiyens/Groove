import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { repairWebmDuration } from '../lib/scoring/gemini/webmFix.ts';

// SPECK round-5 fix 2: MediaRecorder webm blobs ship with broken Duration
// metadata. repairWebmDuration rewrites the EBML header so a downstream
// <video> element reports the real duration.
//
// Test scope: unit tests cover the wrapper's CONTRACT (return shape,
// graceful degradation, type preservation). The round-trip assertion
// against a real broken-MediaRecorder fixture lives in the browser
// validation pass — recording one with MediaRecorder requires a browser
// harness this project doesn't ship, and constructing a synthetic
// fixture by hand requires more EBML encoder knowledge than is worth
// embedding in tests.
//
// The graceful-degradation cases here pin the most important field
// failure mode: the EBML byte-scan finds no cluster or fix-webm-duration
// throws → caller falls back to the original blob without an unhandled
// rejection or a corrupt return value.

describe('repairWebmDuration — graceful degradation', () => {
  it('returns the original blob unchanged when the input is unparseable garbage', async () => {
    const garbage = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'video/webm' });
    const result = await repairWebmDuration(garbage);
    assert.equal(result.repaired, false, 'cannot repair garbage');
    assert.equal(result.blob, garbage, 'original blob returned by reference');
    assert.equal(result.blobBytesBefore, garbage.size);
    assert.equal(result.blobBytesAfter, garbage.size, 'no byte-count change on fallback');
  });

  it('returns the original blob unchanged when the input is empty', async () => {
    const empty = new Blob([], { type: 'video/webm' });
    const result = await repairWebmDuration(empty);
    assert.equal(result.repaired, false);
    assert.equal(result.blob, empty);
    assert.equal(result.blobBytesBefore, 0);
    assert.equal(result.blobBytesAfter, 0);
  });

  it('preserves the input blob.type on the fallback path', async () => {
    const garbage = new Blob([new Uint8Array([0xff])], { type: 'video/webm;codecs=vp9' });
    const result = await repairWebmDuration(garbage);
    assert.equal(result.blob.type, 'video/webm;codecs=vp9');
  });

  it("preserves the input blob.type for default 'video/webm'", async () => {
    const garbage = new Blob([new Uint8Array([0xab, 0xcd])], { type: 'video/webm' });
    const result = await repairWebmDuration(garbage);
    assert.equal(result.blob.type, 'video/webm');
  });

  it('reports inferredDurationSec=null when the EBML scan could not find a cluster', async () => {
    // SPECK overnight Group 1: scan-fail now surfaces as `null` rather
    // than a 0 sentinel so the client can branch on `typeof === 'number'`
    // when deciding whether to use the inferred value as authoritative.
    const garbage = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' });
    const result = await repairWebmDuration(garbage);
    assert.equal(result.inferredDurationSec, null);
  });
});

describe('repairWebmDuration — result shape', () => {
  it('returns the expected RepairWebmResult fields', async () => {
    const blob = new Blob([new Uint8Array([0, 0, 0])], { type: 'video/webm' });
    const result = await repairWebmDuration(blob);
    // Pin every documented field so a future schema change doesn't
    // silently drop a field the caller logs.
    assert.equal(typeof result.repaired, 'boolean');
    assert.equal(typeof result.blobBytesBefore, 'number');
    assert.equal(typeof result.blobBytesAfter, 'number');
    // inferredDurationSec: number | null per RepairWebmResult contract.
    // Garbage input → null; valid webm → number. Either is fine here;
    // we just pin that the field is present and the right shape.
    assert.ok(
      result.inferredDurationSec === null || typeof result.inferredDurationSec === 'number',
      `expected number|null, got ${typeof result.inferredDurationSec}`,
    );
    assert.ok(result.blob instanceof Blob, 'result.blob is a Blob');
  });

  it('does not throw on a non-webm blob (resilient to wrong-typed input)', async () => {
    // Caller could mistakenly hand in an mp4 or something else; the
    // wrapper must not crash the surrounding pipeline.
    const mp4Like = new Blob([new Uint8Array([0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])], {
      type: 'video/mp4',
    });
    await assert.doesNotReject(() => repairWebmDuration(mp4Like));
  });
});
