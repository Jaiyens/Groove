# spec.md

# Groove scoring + callout simplification

## Context

After hours of iteration we shipped a corrected Gemini prompt pipeline (commits d6c03f8, 984eee7, aba9542 on the `score-restoration` branch). The current state:

- Composite generation works (browser produces a side-by-side WebM)
- Side-by-side prompt with calibration anchors and JSON schema is in place
- Motion-onset detection works (logs show correct onset values)
- The Gemini API rejects our composite with `400 INVALID_ARGUMENT` because we send `video/webm;codecs=vp9,opus` and the standard `generateContent` endpoint only accepts `video/mp4`, `video/mpeg`, `video/quicktime`, `video/avi`, `video/x-flv`. WebM is not on the official supported list.
- The motion-onset value never lands meaningfully in Gemini's scoring — when Gemini does respond (via legacy fallback) it still grades the camera walk-back at the start
- Live MediaPipe + DTW callouts during the attempt are inconsistent and not worth more debugging

This spec consolidates the three remaining fixes. All three ship together in a single coherent change.

## Goal

Make scoring work end-to-end with a sincere attempt landing 70-85, and make the live callouts feel responsive without depending on real-time scoring.

## Non-negotiables

- A sincere ~7s attempt MUST return a score in the 70-85 range
- The Gemini composite call MUST succeed (no more 400 INVALID_ARGUMENT)
- The first 1.5s of chunk 1 MUST be excluded from scoring (camera walk-back)
- Chunks 2+ MUST be scored from t=0 (no exclusion — the dancing is continuous)
- Live callouts MUST cycle through GROOVY / PERFECT / GOOD on a beat-driven cadence (every 2-3 beats) regardless of real scoring
- Live callouts MUST NOT repeat the same word twice in a row

## Change 1 — Transcode composite WebM to MP4 before Gemini

### The bug

Browser MediaRecorder outputs `video/webm;codecs=vp9,opus`. Gemini's standard inline-data video API does not accept WebM on `gemini-2.5-flash`. We confirmed this via direct curl probe (`__debug.errorBody` returns `INVALID_ARGUMENT` with the WebM payload but succeeds with an ffmpeg-generated MP4 in Claude Code's verification probe #3).

### The fix

In `app/api/score-gemini-composite/route.ts`, transcode the inbound base64 WebM to MP4/H.264 before calling Gemini.

Implementation steps:

1. Add dependency if not already present:
   - `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg` (the second package bundles the ffmpeg binary so this works on Vercel and locally without requiring system-installed ffmpeg)
   - If a different ffmpeg setup already exists in the project, use that instead

2. In the route handler, BEFORE the Gemini call:
   - Detect if `compositeMimeType` starts with `video/webm`
   - If yes, transcode:
     - Decode `compositeVideoBase64` to a Buffer
     - Write to `os.tmpdir() + crypto.randomUUID() + '.webm'`
     - Run ffmpeg with these settings:
       - Video codec: `libx264`
       - Pixel format: `yuv420p` (broad compatibility, required by many decoders)
       - Audio: `-an` (strip audio entirely — Gemini doesn't need it for dance scoring, saves bytes, removes a failure mode)
       - Preset: `ultrafast` (latency matters more than file size here)
       - Movflags: `+faststart` (so the file is parseable without seeking, which Gemini may require)
     - Read the MP4 output back as a Buffer, re-encode to base64
     - Delete both temp files
   - Replace `compositeVideoBase64` with the new MP4 base64
   - Replace `compositeMimeType` with `video/mp4`

3. Wrap the transcode in try/catch. On failure, log via `[composite-route-error]` with `errorMessage="webm to mp4 transcode failed: <reason>"` and return the existing `__debug` structure with `reason: 'transcode_failed'`.

4. Add log lines:
   - Before: `[composite-route-transcode] start mime=<x> bytes=<n>`
   - After: `[composite-route-transcode] done newBytes=<n> elapsedMs=<n>`

5. If `compositeMimeType` is already `video/mp4` or any other MP4-compatible MIME, skip the transcode and call Gemini directly. (Future-proofing for when composite.ts might output MP4 natively.)

### Verification

After implementation, run:

```bash
ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -c:v libvpx -b:v 500k -an -y /tmp/test.webm
B64=$(base64 -i /tmp/test.webm)
curl -X POST http://localhost:3000/api/score-gemini-composite \
  -H "Content-Type: application/json" \
  -d "{\"compositeVideoBase64\":\"$B64\",\"compositeMimeType\":\"video/webm\",\"motionOnsetSec\":0.1,\"legsVisible\":true,\"mirror\":false}"
```

Expected: HTTP 200 with a valid `GeminiSpecScore` response. If Gemini returns a real score on a test pattern WebM that gets transcoded to MP4, the fix is working.

## Change 2 — Replace motion-onset trimming with hardcoded chunk-1 offset

### The bug

Motion onset detection technically works (logs show `onsetSec: 0.16` etc.) but the trimming-then-passing-to-Gemini path is fragile, and even when it works Gemini still grades content before the onset. The user's walk-back from camera at the start of chunk 1 keeps tanking scores.

Additionally, this is a chunk-1-specific problem. Chunks 2+ start with the user already in dancing position — there's no walk-back to skip.

### The fix

Stop trimming based on motion onset. Hardcode a fixed offset that applies only to chunk 1.

Implementation steps:

1. In `lib/scoring/gemini/client.ts` `scoreWithGemini`:
   - Remove the motion-onset-based trim logic for the user attempt video
   - Add a new constant near the top of the file:
     ```ts
     const CHUNK_1_SCORING_OFFSET_SEC = 1.5;
     ```
   - If `chunkIndex === 0` (first chunk, zero-indexed), trim the user attempt video to start at `CHUNK_1_SCORING_OFFSET_SEC` instead of motion onset
   - For all other chunks (`chunkIndex >= 1`), do NOT trim — pass the video to composite generation as-is from t=0

2. The reference video trimming logic stays as-is (reference videos don't have walk-back issues — they're pro footage that starts on the beat).

3. In `composite.ts`, no changes needed — it just composites whatever bytes it receives.

4. In the route's `buildCompositePrompt`, REMOVE the motion onset section entirely:
   - Delete the `{motionOnsetSec}s` interpolation
   - Delete the "Ignore everything in the user's video before that timestamp" paragraph
   - The composite is now pre-trimmed (for chunk 1) or untrimmed (for chunks 2+), so the prompt should simply say:
     ```
     Grade the entire user video against the entire reference video.
     Both have been pre-trimmed to align with each other.
     ```

5. The motion-onset DETECTION code in `client.ts` lines 265-389 stays in place. We may want it for debug capture or future use. Just stop FEEDING it into the scoring pipeline.

6. Update or delete the `motionOnsetSec` parameter from the request body / route. The route should no longer require it. If kept for backward compat, ignore the value.

### Verification

- For chunk 1: composite generation should produce a video where the user's first 1.5s is missing, and the composite is correctly aligned with the (also trimmed) reference video.
- For chunks 2+: composite generation should use the full attempt video.
- The prompt sent to Gemini should NOT mention motion onset anywhere.

## Change 3 — Hardcoded live callouts on beat cadence

### The bug

Live MediaPipe + DTW scoring during the attempt is inconsistent — `createCalloutEngine` either shows nothing, shows the same callout repeatedly, or shows "GROOVY" regardless of what the user is doing. The infrastructure exists but the signal is unreliable, and we've sunk hours trying to fix it.

### The fix

Bypass real-time scoring for the live callouts. Drive them purely off the beat clock with a randomized cycle through three positive words.

Implementation steps:

1. Find where live callouts are dispatched. This is likely in:
   - `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx`, OR
   - `lib/scoring/calloutEngine.ts` (or wherever `createCalloutEngine` lives)

2. Replace the existing real-time callout logic with this:
   ```ts
   const CALLOUT_WORDS = ['GROOVY', 'PERFECT', 'GOOD'] as const;
   const BEATS_PER_CALLOUT_MIN = 2;
   const BEATS_PER_CALLOUT_MAX = 3;
   
   function makeCalloutCycler() {
     let lastWord: string | null = null;
     let beatsUntilNext = 0;
     
     return function onBeat(): string | null {
       if (beatsUntilNext > 0) {
         beatsUntilNext -= 1;
         return null;
       }
       
       // Pick a word that's not the same as the last one
       const candidates = CALLOUT_WORDS.filter(w => w !== lastWord);
       const word = candidates[Math.floor(Math.random() * candidates.length)];
       
       lastWord = word;
       beatsUntilNext = BEATS_PER_CALLOUT_MIN + Math.floor(
         Math.random() * (BEATS_PER_CALLOUT_MAX - BEATS_PER_CALLOUT_MIN + 1)
       ) - 1; // -1 because this beat counts as the display beat
       
       return word;
     };
   }
   ```

3. Wire `makeCalloutCycler()` into the `BeatTracker`'s `onBeat` callback (or wherever beat events fire during the test page). When the cycler returns a word, dispatch it to whatever component shows the callout overlay.

4. The cycler maintains state:
   - `lastWord`: ensures no two callouts in a row are the same word
   - `beatsUntilNext`: skips 2-3 beats between displays, randomized
   - Words are chosen randomly from the candidates set

5. Visual treatment: keep whatever animation/timing the existing callout UI uses. Just change the SOURCE of the word from "DTW score → tier" to "cycler → randomized word."

6. REMOVE the existing real-time DTW scoring path for callouts. The DTW score computation can stay (it's used elsewhere for fallback scoring), but its output should no longer drive the live callout UI.

### Verification

During a test attempt:
- Callout overlay shows GROOVY, PERFECT, or GOOD
- Each callout appears every 2-3 beats, not on every beat
- The same word never appears twice in a row
- The user can stand completely still and still see positive callouts (this is the trade-off — we accept it because the post-attempt Gemini score is what actually matters)

## What NOT to touch

- The Gemini prompt's side-by-side framing, calibration anchors, JSON schema, and tier definitions. All correct, all working in probe #3.
- `composite.ts` — the WebM output stays WebM at the composite layer. Only the route transcodes to MP4 before Gemini.
- The MediaPipe fallback scoring path. We want Gemini to succeed; we want the fallback as a safety net.
- The debug capture infrastructure.
- The motion-onset detection code itself (we just stop USING it for scoring).
- The reference video trimming (only attempt trimming changes).
- The 5-field response schema (`score`, `tier`, `did_well`, `work_on`, `visibility_notes`).
- Any UI in `ResultsCard.tsx` or downstream.

## Implementation order

The changes are independent but should ship together. Recommended order within a single commit:

1. Change 1 first (transcode) — this is the actual unlock. Without it, nothing else matters.
2. Change 2 second (chunk-1 offset + remove motion-onset from prompt) — once transcode works, this makes the scoring not get tanked.
3. Change 3 last (hardcoded callouts) — pure UX, doesn't affect scoring at all.

## Validation flow

After all three changes commit on the `score-restoration` branch:

1. Restart dev server (`Ctrl+C`, then `npm run dev`)
2. Run the curl verification from Change 1 — expect HTTP 200 with a real score
3. Open the app in the browser
4. Do a sincere ~7s attempt on chunk 1
5. During the attempt: verify callouts cycle through GROOVY/PERFECT/GOOD every 2-3 beats, no repeats
6. After the attempt: verify score lands 70-85
7. Repeat for chunk 2 (if available) — verify no first-1.5s trim happens, scoring still works
8. If any step fails, capture the `__debug` from the network tab response and report back

## Failure modes to report

- Score below 60 on a sincere chunk 1 attempt → calibration anchors not landing despite working transcode
- Score above 95 on a flailing attempt → anchors too lenient
- HTTP 200 from composite endpoint but score is suspiciously low → check that chunk-1 offset is being applied
- Callouts not cycling → beat clock not firing, or cycler not wired up
- Same callout twice in a row → `lastWord` filter not working
- 502 still firing on composite endpoint → transcode failed silently; check `[composite-route-transcode]` logs for completion line
- New error type from Gemini in `__debug.errorBody` → MP4 still has something Gemini doesn't like (codec params, container, duration). Report errorBody contents.

## Deliverables

- Updated `app/api/score-gemini-composite/route.ts` with transcode logic
- Updated `lib/scoring/gemini/client.ts` with chunk-1 offset logic and removed motion-onset path
- Updated `buildCompositePrompt` in `lib/scoring/gemini/prompt.ts` (or wherever it lives) with motion-onset section removed
- Updated `BeatTracker` / `createCalloutEngine` / test page (wherever live callouts dispatch) with the hardcoded cycler
- Single commit on `score-restoration` branch with message: "feat(score-restoration): mp4 transcode + chunk-1 offset + hardcoded callouts"
- Status doc at `docs/score-restoration-status.md` updated to reflect this is the third major iteration on the score-restoration branch
- Do not push