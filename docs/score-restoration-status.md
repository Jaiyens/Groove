# Score restoration — status

Branch: `score-restoration` (not pushed)
Status: ready for user validation — iteration 3.

This is the third major iteration on the `score-restoration` branch:

1. **Iteration 1** — composite prompt rewritten from scratch with the new
   five-field schema + tier vocabulary; two-video fallback preserved.
2. **Iteration 2** — diagnostics added (`__debug.errorBody`, full SDK error
   dump) after the composite call surfaced `400 INVALID_ARGUMENT`. Root
   cause confirmed: Gemini's standard `generateContent` API rejects
   `video/webm`.
3. **Iteration 3 (this commit)** — three coordinated changes (see SPECK.md
   at repo root): WebM→MP4 server-side transcode, motion-onset trimming
   replaced with a hardcoded chunk-1 1.5s offset, and live callouts
   replaced with a hardcoded beat-driven GROOVY / PERFECT / GOOD cycler.

## Baseline decision

**Fallback path taken.** No historical commit emitted the new five-field
response schema (`score`/`tier`/`did_well`/`work_on`/`visibility_notes`) or
the new tier vocabulary (GROOVY/SOLID/ALMOST/WARMING_UP/JUST_STARTED) that
SPECK.md mandates. The closest historical match — `3d7ebe8`
(generosity rewrite, hard floor 50) — had the right coaching tone but the
wrong schema and the wrong tier names.

The composite prompt was therefore written from scratch using SPECK.md as
the source of truth, following sections (a) through (g) verbatim and
embedding both worked examples + all five calibration anchors verbatim.

Full reasoning + per-commit prompt diffs:
[docs/score-restoration-investigation.md](./score-restoration-investigation.md).
Each historical prompt is preserved under
[docs/score-prompt-history/](./score-prompt-history/).

## Iteration 3 — what changed (this commit)

| File | Change |
|---|---|
| `app/api/score-gemini-composite/route.ts` | **Change 1 (transcode).** Inbound composite WebM is transcoded to MP4/H.264 yuv420p (audio stripped, `-preset ultrafast`, `+faststart`) via `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg` BEFORE the Gemini call. Resolves the `400 INVALID_ARGUMENT` from iteration 2 — Gemini accepts `video/mp4` but not `video/webm`. Already-MP4 inputs pass through. **Change 2 (prompt).** `buildCompositePrompt` no longer surfaces `motionOnsetSec`. |
| `lib/scoring/gemini/prompt.ts` | **Change 2.** Section (c) MOTION ONSET replaced with (c) PRE-TRIMMED ALIGNMENT — "Grade the entire user video against the entire reference video. Both have been pre-trimmed to align with each other." `motionOnsetSec` arg is now optional / unused. |
| `lib/scoring/gemini/client.ts` | **Change 2.** New `CHUNK_1_SCORING_OFFSET_SEC = 1.5`. `trimAttemptForOnset` now takes `chunkIndex`: for chunk 0 it slices the attempt at 1.5s (drops the walk-back); for chunks 2+ it returns the duration-repaired blob unchanged. Composite path is no longer gated on attempt motion-onset — it fires whenever the reference trim succeeded. `detectMotionOnsetInVideo` stays defined but is no longer called on the attempt. |
| `lib/scoring/callouts/calloutEngine.ts` | **Change 3.** New `makeCalloutCycler()` — pure beat-driven cycler over `['GROOVY', 'PERFECT', 'GOOD']`, randomized, never the same word twice in a row, fires every 2-3 beats. `tierForSimilarity` / `createCalloutEngine` retained (still used by tests + post-attempt fallback). |
| `lib/scoring/callouts/types.ts` | **Change 3.** `CalloutTier` union now includes `'GOOD'`. |
| `components/scoring/CalloutOverlay.tsx` | **Change 3.** Added `.callout-tier-good` styling (reuses the `callout-great` 800ms animation) and `GOOD: 800` to `TIER_DURATION_MS`. |
| `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx` | **Change 3.** Replaced `createCalloutEngine` + `ingestFrame` with a `BeatTracker.onBeat` listener that calls the cycler and synthesizes a `CalloutEvent`. The detection loop now `tick()`s the tracker with `sessionT` instead of feeding similarity. `jointAngleAngularSimilarity` import removed (no remaining consumer in this file). |
| `tests/compositePrompt.test.ts` | Section ordering updated to `(c) PRE-TRIMMED ALIGNMENT`. Motion-onset assertion replaced with positive + negative checks: "Grade the entire user video / Both have been pre-trimmed" must appear; "motion onset", "0.16s", "walking back from the camera" must NOT appear. |
| `next.config.mjs` | `experimental.serverComponentsExternalPackages` adds `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg` so Next doesn't try to bundle the native binary. |
| `package.json` | Added `fluent-ffmpeg`, `@ffmpeg-installer/ffmpeg`, `@types/fluent-ffmpeg`. |

### Iteration 3 verification

Curl probe from SPECK.md §Change 1:

```
ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=10 \
  -c:v libvpx -b:v 500k -an -y /tmp/test.webm
B64=$(base64 -i /tmp/test.webm)
curl -X POST http://localhost:3000/api/score-gemini-composite \
  -H "Content-Type: application/json" \
  -d "{\"compositeVideoBase64\":\"$B64\",\"compositeMimeType\":\"video/webm\",\"motionOnsetSec\":0.1,\"legsVisible\":true,\"mirror\":false}"
```

Returns HTTP 200 with a valid `GeminiSpecScore` (`JUST_STARTED` on the test
pattern, ~4.5s round-trip including transcode). Confirms transcode is no
longer blocked by Gemini's accepted-MIME list.

## Iteration 1 — what changed (historical)

| File | Change |
|---|---|
| `lib/scoring/gemini/prompt.ts` | `buildCompositePrompt` rewritten from scratch per spec §Implementation phase (sections a→g). Embeds side-by-side framing as the opening sentences, the verbatim calibration anchors, the response JSON schema + both worked examples, and the philosophical framing. Signature now takes `motionOnsetSec`. Two-video `buildGeminiPrompt` left unchanged (degraded fallback path). |
| `lib/scoring/gemini/types.ts` | New `GeminiSpecScoreSchema` + `GeminiSpecResponseJsonSchema` for the spec's five-field shape. Existing `GeminiScore` (and `GeminiResponseJsonSchema`) kept so the UI continues to consume the legacy shape. |
| `lib/scoring/gemini/client.ts` | New `specScoreToInternalScore` adapter converts Gemini's spec response → internal `GeminiScore` at the client boundary. `DEFAULT_TIMEOUT_MS` bumped 40_000 → 90_000 (`SERVER_BUDGET_FLOOR_MS` 35_000 → 80_000). Composite call now sends `motionOnsetSec` and logs `[gemini-prompt]` before send + `[gemini-response]` on receive. Composite response is parsed with the new spec schema; on schema mismatch we fall through to the legacy two-video pipeline. |
| `app/api/score-gemini-composite/route.ts` | Accepts `motionOnsetSec` in the request body, threads into `buildCompositePrompt`, validates response against `GeminiSpecScoreSchema`, returns `GeminiSpecScore`. `TOTAL_BUDGET_MS` 30_000 → 80_000, `MIN_RETRY_BUDGET_MS` 8_000 → 20_000, `maxDuration` 60 → 120. Logs `[gemini-prompt]` before send + `[gemini-response]` on receive (server-side; the user validates from the browser console where `client.ts` also logs both). |
| `tests/compositePrompt.test.ts` | Rewritten to pin the new spec invariants (section ordering a→g, calibration anchors verbatim, motion-onset value templated in, worked examples present, JSON-only output). |
| `tests/geminiClientTimeout.test.ts` | Bumped the 40s pin to `≥ 90_000ms` per spec non-negotiable. |
| `docs/score-restoration-investigation.md` | New: investigation phase output (commit table, per-commit summary, heuristics scorecard, fallback decision). |
| `docs/score-prompt-history/*.txt` | New: snapshot of every historical version of `prompt.ts`. |
| `docs/score-restoration-status.md` | This file. |

## What was deliberately NOT touched

Per spec §"What NOT to touch":
- Motion-onset detection logic (`lib/scoring/gemini/client.ts` lines 265-389) — untouched.
- Composite generation (`lib/scoring/gemini/composite.ts`) — untouched.
- MediaPipe fallback path (`buildGeminiPrompt` + `/api/score-gemini` route + `mediapipeFinalToGeminiShape`) — untouched. Only the *composite* path was migrated; the legacy two-video path still emits the old response shape and remains the degraded fallback when composite fails.
- Debug capture infrastructure (`lib/debug/attemptStore`, `app/debug/scoring/*`) — untouched.
- All UI code (`components/ResultsCard.tsx`, results page, drill routing) — untouched. The `GeminiScore` adapter in `client.ts` keeps the legacy shape flowing to the UI.

## Adapter contract: GeminiSpecScore → GeminiScore

Translation done in `specScoreToInternalScore` at
[lib/scoring/gemini/client.ts](../lib/scoring/gemini/client.ts):

- `score` → `overall_score` and all four `components` (arms/legs/body/timing)
  set to `score`. Reason: the UI's `displayedOverall` is the mean of visible
  components, so synthesizing each as `score` makes the displayed value
  equal to `score`.
- `tier` mapped:
  GROOVY → GROOVY,
  SOLID → SOLID,
  ALMOST → SOLID (internal `SOLID` floor is 75; ALMOST 60-74 sits at the
  bottom of the internal SOLID band by design — `displayedOverall` will
  still drive the visible tier via `scoreToTier`).
  WARMING_UP → SHAKY,
  JUST_STARTED → NOT_DANCING.
- `did_well` and `work_on` populate `insights[]`. `visibility_notes`
  appended as a third entry when non-empty.
- `trouble_spots` set to `[]` — the spec replaces the multi-spot list with
  a single `work_on` sentence. The trouble-spot card on `ResultsCard`
  renders empty in that case (existing render path; no UI change).
- `is_actually_dancing` derived: `tier !== 'JUST_STARTED'`.

## What to watch during validation

Open the browser console, record a sincere ~7s attempt, and look for this
log sequence:

```
[gemini-prompt] <full prompt — should start with "(a) SIDE-BY-SIDE FRAMING"
                 and contain all five calibration anchors, the motion onset
                 value (typically 0.00s on the trimmed-composite path), and
                 both worked examples>
[gemini-client] sending composite { mirror, legsVisible, compositeBytes,
                 mimeType, durationSec, motionOnsetSec, timeoutMs: 90000 }
[gemini-response] { score: <integer>, tier: <one of the five>,
                    did_well: <body-part-specific sentence>,
                    work_on: <body-part-specific, drillable sentence>,
                    visibility_notes: <string> }
```

**Pass criteria (spec §Validation):**
- score 70-85 on a sincere ~7s attempt.
- response parseable JSON; no fences, no preamble.
- `did_well` cites a body part or beat.
- `work_on` cites a body part or beat AND is drillable in 90 seconds.
- partial-frame attempts produce a non-empty `visibility_notes`.

**Failure-mode triage (spec §Failure modes to report):**
- Score below 60 on a sincere attempt → calibration anchors not landing;
  consider strengthening section (e).
- Score above 95 on a flailing attempt → thresholds too lenient or Gemini
  is ignoring section (e).
- Response doesn't reference left/right or reference/user → section (a)
  framing is not landing.
- Response not valid JSON → section (g)'s schema instruction needs to be
  more forceful, or move it to a system instruction.
- `work_on` is generic ("keep practicing") → section (f)'s
  "drillable in 90 seconds" constraint needs reinforcing.

Capture both `[gemini-prompt]` and `[gemini-response]` from the failed run
when reporting.

## Deployment caveats

- `maxDuration = 120` in `app/api/score-gemini-composite/route.ts` requires
  Vercel Pro (Hobby caps at 60s). If deployed to Hobby, drop the route's
  `TOTAL_BUDGET_MS` to ~50_000 and `maxDuration` to 60, and tighten
  `MIN_RETRY_BUDGET_MS` accordingly. Local `next dev` has no such cap.
- Composite path is the only path that received the new prompt + schema.
  If `composite.ts` fails (rare — falls through to two-video) the user
  will see the OLD scoring shape on that attempt. The console log
  `[gemini-client] composite failed, falling back to two-video` flags this.

## Verification

- Typecheck: `npx tsc --noEmit` — clean (test-file `.ts`-import errors are
  pre-existing and orthogonal).
- Tests: `npm test` — 338/338 pass after iteration 3.
- Curl probe (iteration 3): WebM test pattern → HTTP 200 + valid
  `GeminiSpecScore` (Gemini grades it `JUST_STARTED`, as expected for a
  motion-free test source).
