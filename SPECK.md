# SPEC: Fix two bugs blocking Gemini validation

## Context

Latest sincere attempt validation surfaced two distinct bugs. Branch `gemini-deterministic-and-sidebyside` shipped 8 commits successfully (FG1–FG8), motion-onset detection now fires on both reference and attempt paths, reference is mirrored. The data layer is clean. But Gemini's response is unreadable because of two new issues that this PR fixes.

### Bug 1: Client timeout shorter than server retry budget

Server logs from the latest sincere attempt:
```
[gemini-score][failure] reason=upstream_5xx attempt=1 message={"error":{"code":503,"message":"...UNAVAILABLE"}}
[gemini-score] retrying once (remainingBudgetMs=25851)
POST /api/score-gemini 200 in 13611ms
[gemini-score] latencyMs: 11058
[gemini-score] retry succeeded
```

Server retry worked and returned a real Gemini response in 13.6s total. But the client timed out before the server finished, logged `gemini failed → falling back to MediaPipe timeout`, and rendered MediaPipe fallback instead of the Gemini response. Net effect: every transient Gemini 503 → MediaPipe fallback even though the server retry succeeded.

### Bug 2: Attempt webm duration is wrong post-finalize

Same run, browser console:
```
[gemini-client] motion-onset openHiddenVideo: metadata loaded {durationSec: 0.001, ...}
[gemini-client] motion-onset trimAttempt: duration-finalize {attempted: true, durationBefore: 0.001, durationAfter: 2.151, fixed: true}
```

User actually danced for ~7 seconds (reference chunk is 7.384s, attempt was a sincere full performance). The webm blob's duration metadata post-finalize is 2.151s. The seek-to-MAX trick reported `fixed: true` but the resulting duration is still wrong by ~5 seconds.

Downstream effect: Gemini received an attempt video that's ~30% the length of the reference and correctly concluded `is_actually_dancing: false, overall_score: 10`. The model is doing the right thing given the input; the input is broken.

---

## Fix 1: Bump client-side timeout for /api/score-gemini

Find the timeout in `lib/scoring/gemini/client.ts` (search for `scoreWithGemini` and look for `AbortController` / `setTimeout` / `timeoutMs`). Current value is probably 15–20s. Bump to **40s**.

Server-side budget: original attempt up to ~11s + retry budget ~26s + small overhead = ~37s worst case. Client must be > server budget or retries are pointless. 40s gives a small margin.

**Acceptance:**
- Client `scoreWithGemini` timeout is 40000ms.
- Add a `[gemini-client] timeout` log line if it fires, showing elapsed ms — so next time we see this we know whether the client gave up or Gemini actually didn't return.
- Add unit/integration test that asserts the timeout value is at least the server's max budget (read from the same constant if it exists, otherwise hardcode 35000 as the floor).

---

## Fix 2: Re-encode the attempt video before reading duration

The `finalizeWebmDuration` seek-trick is producing a "fixed" duration that doesn't reflect the actual blob length. Root cause: MediaRecorder produces webm with cues table missing or broken duration headers, and the seek trick only repairs what's readable, not the actual frame count.

**The fix is to re-encode the blob client-side before reading duration**, using one of these approaches in order of preference:

### Option A (preferred): Use `ts-ebml` to rewrite the webm metadata

Library: `ts-ebml` (already may be in deps; if not, install it). Rewrites EBML headers including the duration based on actual cluster timestamps. This is the standard fix for MediaRecorder duration bugs and has been used in production webm pipelines for years.

```typescript
// New file: lib/scoring/gemini/webmFix.ts
import { Decoder, Encoder, tools, Reader } from 'ts-ebml';

export async function repairWebmDuration(blob: Blob): Promise<Blob> {
  const buf = await blob.arrayBuffer();
  const decoder = new Decoder();
  const reader = new Reader();
  reader.logging = false;

  const elements = decoder.decode(buf);
  elements.forEach((el) => reader.read(el));
  reader.stop();

  const refinedMetadataBuf = tools.makeMetadataSeekable(
    reader.metadatas,
    reader.duration,
    reader.cues
  );
  const body = buf.slice(reader.metadataSize);

  return new Blob([refinedMetadataBuf, body], { type: blob.type });
}
```

Wire this into `trimAttemptForOnset` *before* `openHiddenVideo`:

```typescript
// In client.ts trimAttemptForOnset, before openHiddenVideo:
const repairedBlob = await repairWebmDuration(blob);
// ... pass repairedBlob to URL.createObjectURL and openHiddenVideo
```

### Option B (fallback if ts-ebml fails to install): Sanity-check guard

If for any reason ts-ebml can't be added, add a sanity guard: if the attempt duration post-finalize is less than 70% of `referenceChunkEndSec - referenceChunkStartSec`, log a warning and **do not send to Gemini** — return a structured error that the UI surfaces as "recording was corrupted, please try again." Better to fail loud than send a broken video and get a meaningless score.

Prefer Option A. Only fall back to B if Option A genuinely can't ship.

**Acceptance:**
- `repairWebmDuration` is called in `trimAttemptForOnset` before `openHiddenVideo` and before the duration finalize.
- New `[gemini-client] motion-onset trimAttempt: webm-repair` log line showing `{ blobBytesBefore, blobBytesAfter, durationBefore, durationAfter }`.
- For a 7-second sincere attempt on the same test chunk, post-repair `durationAfter` should be ≥ 6.5s (allowing for normal MediaRecorder rounding).
- Add unit test with a fixture webm that has broken duration metadata (you can construct one with MediaRecorder in a jest-dom environment, or use one of the existing test fixtures); assert that `repairWebmDuration` returns a blob with finite, non-trivial duration.

---

## What to do after both fixes

Same protocol:
1. Confirm branch is `gemini-timeout-and-webm-repair` (new branch off `gemini-deterministic-and-sidebyside`).
2. Run one sincere attempt on the same chunk (`9fff5b9b-7a84-4316-94ed-9ebf943343c4`, chunk 0).
3. Paste back:
   - The new `[gemini-client] motion-onset trimAttempt: webm-repair` line
   - The `[gemini-client] motion-onset trimAttempt: duration-finalize` line (should now show `durationBefore` close to `durationAfter`, both ~7s)
   - The full server `[gemini-score]` block
   - The Gemini raw response JSON
   - Whether the result card showed Gemini output or MediaPipe fallback (should be Gemini)

If both fixes land clean, the sincere attempt should finally produce a real Gemini score on a 7-second attempt video matching the 7-second reference. That's the score we've been trying to see for four rounds.