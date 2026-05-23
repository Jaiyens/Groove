# Overnight rebuild — status report

Branch: `overnight-data-rebuild` (off `gemini-timeout-and-webm-repair`).
Working tree clean. All 311 tests passing. Nothing pushed to main.

## Shipped

Seven commits, in order:

| Commit  | Subject                                                                            |
|---------|------------------------------------------------------------------------------------|
| fea8557 | chore(speck): replace gemini-timeout/webm-repair spec with overnight data rebuild spec |
| ad52aab | fix(duration-source): trust webm-repair inferred duration over browser seek        |
| f29765a | feat(mirror): unify mirror state across mode A, holding screen, gemini input       |
| f220ba1 | feat(repair-webm): server-side ffmpeg fallback for broken webm duration            |
| e63eaa0 | feat(composite): side-by-side video composition + new prompt branch                |
| 1756301 | docs(callout-tier): overnight diagnosis of always-GROOVY behavior                  |
| 8316eb8 | experimental(callout-tier): swap cosineSimilarity for per-joint angular agreement  |

One-line summaries:

- **Group 1 (ad52aab):** `trimAttemptForOnset` now uses the EBML-inferred duration as authoritative when it's a finite number ≥ 0.5s. `finalizeWebmDuration` (the seek-to-MAX_SAFE_INTEGER trick) is fallback only. The data layer should now feed Gemini a real ~7s blob on a sincere attempt instead of the truncated ~1s slice that was triggering `is_actually_dancing: false`.
- **Group 2 (f29765a):** `lib/preferences/mirror.ts` is the single source of truth for mirror state — Mode A copy page, the holding-screen REF panel, and the Gemini composite reference all read from it and subscribe to broadcast changes. `referenceMirrored` on the API payload now reflects the actual capture state, not a hardcoded `true`.
- **Group 3 (f220ba1):** `POST /api/repair-webm` re-muxes a webm container via ffmpeg (`-c copy -fflags +genpts`). Client invokes it only when both `repairWebmDuration` and `finalizeWebmDuration` failed to produce a plausible duration. Adds `'server-repair'` as a third `DurationSource` tag with full diagnostic logging.
- **Group 4 (e63eaa0):** `renderSideBySideVideo` (`lib/scoring/gemini/composite.ts`) renders REF on the left half + ATTEMPT on the right half of a 1280×720 canvas, captures via MediaRecorder, sends to a new `/api/score-gemini-composite` endpoint with a new `buildCompositePrompt`. Falls back silently to the two-video pipeline on any failure.
- **Group 5 (1756301 + 8316eb8):** Diagnosis (A) — `cosineSimilarity` over `JointAngleVector` saturates at 0.95–0.999. Doc commit captures the math; experimental commit ships a `jointAngleAngularSimilarity` replacement wired into the live callout call site only.

## Skipped

Nothing was skipped per spec. Both required artifacts (5 groups + Group 5 spare-time pickup) landed.

## Surprises

1. **`@ffmpeg/ffmpeg` v0.12+ dropped Node.js support.** The spec's Plan A for `/api/repair-webm` was to use `FFmpeg.load()` from `@ffmpeg/ffmpeg` server-side. The package now throws `"ffmpeg.wasm does not support nodejs"` from the `FFmpeg()` constructor — verified by smoke-test, then uninstalled. Fell back to the spec's Plan B (`child_process.spawn('ffmpeg', …)`). Works locally on the dev machine (homebrew ffmpeg). **Won't work on Vercel's default Node runtime** — the route's `spawn-enoent` reason will fire there. See "Needs human validation" → repair-webm production deployment.

2. **The composite renderer's `mirror` arg is doubly-meaningful.** Spec wording suggests the composite renderer applies the flip; but `trimReferenceClientSide` already mirrors at trim time when the preference is on. To avoid double-flipping, the integration in `scoreWithGemini` passes the already-trimmed reference blob with `mirror: false` to the renderer, and forwards the *actual* mirror state separately to the composite-route prompt. This is documented in the `[gemini-client] sending composite` log line.

3. **Composite renderer fires only when both motion-onset trims produced a slice.** Spec didn't explicitly call out this gating, but composite-with-untrimmed-inputs would defeat the whole "alignment is built in" framing in the new prompt. Logged as `[gemini-client] composite skipped (preconditions not met)` when it doesn't run. If the field run shows composite never firing, look at this log first.

4. **`RepairWebmResult.inferredDurationSec` changed from `number` (with 0 as the no-inference sentinel) to `number | null`.** The spec said "if the field is already there, this group does nothing in this file" — technically the field WAS there as `number` with 0 sentinel, but the spec's example client code uses `typeof === 'number'` which doesn't distinguish 0 from a real value, so I tightened the type to `null` for clarity. Updated existing tests accordingly.

5. **Tests for the route handlers don't exercise ffmpeg.** `tests/repairWebmRoute.test.ts` mocks `node:child_process.spawn` so the suite stays hermetic and offline. The real ffmpeg invocation is unvalidated until a sincere attempt actually trips the fallback.

## Needs human validation

This is the punch list for tomorrow morning. Items marked **(camera)** need a live attempt; items marked **(visual)** need a screen-by-screen check.

1. **Group 1 — composite duration trace (camera).** Record a sincere ~7-second attempt. Look in the terminal for:
   ```
   [gemini-client] motion-onset trimAttempt: duration-source
       { source: 'webm-repair-inferred', durationSec: ~6.7, … }
   [gemini-client] motion-onset trimAttempt: scanning { durationSec: ~6.7, durationSource: 'webm-repair-inferred' }
   [gemini-client] motion-onset trimAttempt: done { blobBytes: 1.5MB-2MB, durationSource: 'webm-repair-inferred' }
   ```
   If `source` is `'browser-finalize'` and `durationSec` is ~1.4s, the data-layer fix didn't trip — the EBML scan didn't find a cluster. Surface the `inferredDurationSec` log value to triage.

2. **Group 2 — mirror visual coherence (visual).**
   - Mode A copy page (`/dance/[id]/chunk/[i]/copy`): toggle the mirror button. REF video flips immediately. REF skeleton overlay (white) stays glued to the video.
   - Holding screen (the side-by-side hold while Gemini resolves): REF panel reflects the same toggle state. Hopper here is the same `groov_mirror_enabled` localStorage key.
   - Refresh the page. State persists.
   - Check the `[gemini-client] sending` log — `referenceMirrored` should match the toggle.

3. **Group 3 — repair-webm production deployment.** The current implementation requires a system `ffmpeg` binary on PATH. **Vercel's default Node runtime does not ship ffmpeg.** Options for production:
   - Add a `vercel-ffmpeg` build step / lambda layer that bundles a static ffmpeg binary.
   - Move the repair to an off-platform worker (Cloudflare Workers + WASM, fly.io, etc.).
   - Accept that the server-side fallback never fires in prod and rely solely on the two client-side paths (Groups 1 + 0).
   - The route already distinguishes `spawn-enoent` from other failure modes so a production log will show the missing-binary case clearly.

4. **Group 4 — composite trip + Gemini quality (camera).** Record a sincere attempt. Look for:
   ```
   [composite] entry { … }
   [composite] success { blobBytes: …, mimeType: 'video/webm;codecs=…', durationSec: <=7 }
   [gemini-client] sending composite { … }
   ```
   If `[composite] failure` fires, the renderer bailed — the reason tag pinpoints which step. If the Gemini response on the composite is meaningfully better than the two-video baseline (more honest `is_actually_dancing`, more proportionate components), keep composite as primary. If not, consider gating the composite path behind a feature flag.

5. **Group 5 — callout tier distribution (camera).** On a sincere attempt, the `[callout-engine][beat]` log lines should now show `windowMax` values spanning roughly 0.5–0.95, with a tier mix of mostly PERFECT, occasional GROOVY/GREAT, rare ALMOST. If every beat still reads GROOVY, the experimental fix's response curve is too steep — revert commit 8316eb8 and the diagnosis stays.

## What I'd do next

In rough priority order:

1. **Run a sincere validation attempt** to confirm Group 1 + Group 4. If composite improves Gemini's `is_actually_dancing` reliability on a real performance, this whole night was worth it; if it doesn't, the data-layer fix in Group 1 alone justifies the work.
2. **Solve the Vercel ffmpeg gap** before relying on the server-side repair for anything user-facing. A `vercel-ffmpeg-binary` package or equivalent is the most direct path; a layered lambda is heavier-handed but bulletproof.
3. **Calibrate the callout tier metric** against a real attempt. The diagnosis is solid, but the `1 - |Δangle|/π` mapping is the simplest sensible curve, not the only one. A piecewise-linear or sigmoid scaling tuned against the actual band distribution might give a snappier-feeling live tier mix. Worth trying after Group 5's experimental commit is verified or reverted.
4. **Decide what to do about the score-gemini → score-gemini-composite duplication.** The two routes share ~80% of their body (retry budget, classifyError, callGeminiOnce shape). A shared helper would be cleaner, but every refactor here risks the retry/budget invariant the existing route has been validated against. If both routes stay around long-term, factor at that point — not before.
5. **The reference also goes through the EBML repair pipeline now.** Group 1 didn't touch `trimReferenceClientSide`, but a CDN-served mp4 reference might in future benefit from the same duration-source decision. Worth checking field logs for any `[gemini-client] motion-onset trimReference: duration-finalize` lines with implausible values.

## Working agreement check

Per the spec's working agreement section: I tried alternatives whenever Plan A failed, documented every deviation here. Nothing was bypassed silently. The diagnostic logging from rounds 1–5 is intact; new log lines are scoped under their existing `[gemini-client]`, `[composite]`, `[callout-engine]`, `[repair-webm]` prefixes.

Final tree state: `overnight-data-rebuild` is 7 commits ahead of `gemini-timeout-and-webm-repair`, working tree clean, tests passing. `git push origin overnight-data-rebuild` is up to you.
