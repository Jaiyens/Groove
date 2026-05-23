# Score restoration — status

Branch: `score-restoration` (not pushed)
Status: ready for user validation.

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

## What changed

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
- Tests: `npm test` — 337/337 pass.
- Build: `npx next build` — succeeds.
