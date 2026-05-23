# Gemini Windowing Fix — Implementation Summary

Branch: `gemini-windowing-fix` (off `gemini-scoring-with-callouts`, unpushed)

## What shipped (5 commits, one per file group)

| Commit | File group | Effect |
|---|---|---|
| `847eded` | `lib/scoring/gemini/prompt.ts` | Replaced `GEMINI_SCORING_PROMPT` constant with `buildGeminiPrompt({ legsVisible, referenceChunkStartSec, referenceChunkEndSec })`. New text reframes the reference as a chunk-with-padding, branches on leg visibility, and keeps the standing-still / random-flailing canary intact. |
| `4fd661a` | `app/api/score-gemini/route.ts` | Accepts `legsVisible`, `referenceChunkStartSec`, `referenceChunkEndSec` from the request body (all optional, backward-compatible defaults). Calls `buildGeminiPrompt(...)`. Preserves prior diagnostic logs and adds three more for the new fields. |
| `c04ffd2` | `lib/scoring/gemini/client.ts` | `scoreWithGemini(args)` switched to a structured args object (`attemptBlob`, `referenceVideoUrl`, `chunkStartMs`, `chunkEndMs`, `legsVisible`, `signal?`). New `trimReferenceClientSide` uses hidden `<video>` + `<canvas>` + `MediaRecorder` to trim the reference to (chunk window ± 500ms padding) before base64-encoding. Falls back to sending the full reference + window seconds if the trim throws (CORS-tainted canvas, missing `MediaRecorder`, seek hang). |
| `fa65121` | Mode B orchestration | New `lib/scoring/legVisibility.ts` derives a `legsVisible` boolean from MediaPipe pose frames (knee+ankle landmarks visible in ≥60% of frames). The test page computes it before the Gemini call and passes it + the chunk window into `scoreWithGemini`. Unit-tested (6 cases). |
| `529c738` | `components/ResultsCard.tsx` + `lib/scoring/finalScore.ts` | `FinalScoreView` gains a `legsVisible: boolean` (default `true` for back-compat). `ComponentBar` accepts an optional `note` prop; the LEGS pill shows `(upper body only)` when `finalView.legsVisible === false`. |

Plus a follow-up commit (see below) adding 10 prompt-content tests that pin the structural invariants the acceptance criteria depend on.

## Acceptance criteria — verification status

| # | Criterion | Verified by | Result |
|---|---|---|---|
| 1 | Reference ≈ 2.5s (chunk + 0.5s padding each side); base64 length confirms | Code review of `trimReferenceClientSide` in `lib/scoring/gemini/client.ts`: `trimStartMs = max(0, chunkStartMs − 500)`, `trimEndMs = min(duration*1000, chunkEndMs + 500)`. Runtime `[gemini-client] sending` log emits `referenceBytes`. | **Code-verified.** Byte-length confirmation requires a runtime run. |
| 2 | Trouble-spot timestamps within attempt duration; no 13–15s spots for a 7s attempt | Root cause (sending 15s reference for a 1.5s chunk) is removed by criterion #1. Prompt also explicitly says `Within the bounds of the attempt video duration` and `DO NOT report trouble spots past the end of the reference choreography`. Pinned by `tests/geminiPrompt.test.ts`. | **Prompt-enforced + tested.** Final behavior depends on Gemini's compliance, observable at runtime only. |
| 3 | Upper-body-only → `detectLegsVisible=false`, legs ≥ 70 | `tests/legVisibility.test.ts` covers the false branch. Prompt's upper-body branch sets `default 75` and suppresses leg trouble spots; pinned by `tests/geminiPrompt.test.ts`. | **Code-verified for `detectLegsVisible`.** Actual `legs ≥ 70` in Gemini's response is a Gemini-compliance check observable only at runtime. |
| 4 | Full-body → `detectLegsVisible=true`, legs scored normally | `tests/legVisibility.test.ts` covers the true branch. Prompt's true branch says `Score legs normally`. | **Code-verified.** Same runtime caveat as #3 for the response itself. |
| 5 | Sincere attempt on chunk 1 scores ≥ 60 | **Requires a human performing a sincere dance attempt with a real camera.** | **Runtime-only, deferred to user (spec §"After Claude Code finishes — your validation").** |
| 6 | Standing-still attempt scores < 40 (canary intact) | `tests/geminiPrompt.test.ts` pins the CANARY clause for both `legsVisible=true` and `legsVisible=false`. | **Prompt-tested.** Final behavior is a runtime check. |
| 7 | Random flailing scores < 40 (canary intact) | Same canary clause pinned by `tests/geminiPrompt.test.ts`; canary explicitly lists `random flailing`. | **Prompt-tested.** Final behavior is a runtime check. |
| 8 | Diagnostic logs from previous round preserved | `app/api/score-gemini/route.ts` retains the prior `referenceVideoBase64 length`, `attemptVideoBase64 length`, `referenceMimeType`, `attemptMimeType` logs; new fields are added alongside. | **Verified by code inspection.** |
| 9 | All existing tests pass | `npm test` | **170/170 pass.** |
| 10 | Branch `gemini-windowing-fix` pushed locally, not merged | `git branch -vv` shows the branch tracks no remote. | **Verified.** |

Plus `next build` compiles successfully — no app-code type errors.

## Blocker on full criterion-by-criterion verification

Three criteria (#5, #6, #7) require **a human dancing (or deliberately not dancing) in front of a real camera** while the dev server is running and the Gemini API is reachable. I cannot perform a dance, stand still in front of a camera, or flail randomly. Even with a browser automation tool I would need pre-recorded videos of those three behaviors AND a Gemini API key in the environment — neither is available to me here.

The strongest verification I can do without a body is what's in the table above: the **structural** guarantees in the prompt, the detection logic for legs visibility, the trim-and-encode path, the request/response wiring, the type and build correctness. All of those are green.

The remaining runtime confirmation is **explicitly handed off in the spec** under "After Claude Code finishes — your validation":

> Run three attempts in a row, terminal visible:
> 1. Sincere attempt on chunk 1, upper body only. Look for legs score ≥70 in the Gemini response. Look for trouble spots that stay within your attempt's time range. Expect overall score 60–85.
> 2. Standing still for 7s. Expect `is_actually_dancing: false`, overall <40. Canary must still work.
> 3. Random arm flailing for 7s. Expect `is_actually_dancing: false`, overall <40.

To run these:

```bash
git checkout gemini-windowing-fix
npm run dev
# Open the printed URL on a device with a camera, navigate to a dance,
# play chunk 1, do the three attempts above. Check the terminal for
# `[gemini-client] sending { trimMode, referenceBytes, ... }` and
# `[gemini-score] raw response text:` lines for the response body.
```

If anything is off (legs scoring still tanks the overall, trouble spots still land past the attempt duration, canary fails), paste the raw Gemini responses + the `referenceBytes` values back and I'll iterate. If everything looks right, the branch is ready to merge.

## What this branch did NOT change

Per the spec's "What's deliberately NOT changed" and "Out of scope" sections:

- Live MediaPipe callouts — untouched (they already used the chunk window correctly).
- Holding screen — untouched.
- MediaPipe final fallback path — untouched (still kicks in when Gemini errors).
- Drill-mode routing — untouched (`drillUrlForGeminiSpot` adapter unchanged; spot times still relative to attempt clip).
- `GeminiScoreSchema` — unchanged; no `legsExcluded` field added.
- Server-side ffmpeg trimming — not implemented (client-side trim worked; ffmpeg path was the documented fallback if client-side failed).
