# Callout Engine Investigation — Diagnostic Logging Plan

Validation of the previous PR (`gemini-generosity-and-ui`) reported that
live callouts always fire `GROOVY` and that the per-beat diagnostic log
added in that PR never appeared in the terminal. Two explanations are
possible:

1. The callout engine isn't instantiated on the active code path.
2. The engine IS created but never receives frames (or beats are
   outside the frame timestamps).

This PR is **diagnostic only**. No thresholds are tuned. The next spec
uses these logs to fix the actual bug.

## What the logs say

The following lines are added in this PR. They MUST appear in this order
on a successful attempt:

| Layer | Tag | Location | Condition |
| --- | --- | --- | --- |
| 1 | `[callout-engine][init] accentBeats=N` | `lib/scoring/callouts/calloutEngine.ts` `createCalloutEngine()` | Always — fires on every call to `createCalloutEngine`. |
| 2 | `[mode-b][callout-wired] engine created { accentBeatCount, sessionDurationMs, bpm }` | `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx` `handleOverlayGo` | Fires once the GO countdown hits zero. |
| 3 | `[callout-engine][frame] ts=… similarity=…` | `ingestFrame` (sampled 1-in-30) | Fires once the detection loop starts producing similarity values. |
| 4 | `[callout-engine][beat] index=… windowMax=… tier=…` | per-beat commit | Fires after a beat's `±150ms` window closes. |
| 5 | `[callout-engine][fire] tier=… at=…` | right before `onCallout` invocation | Confirms the consumer (overlay) receives the event. |

## Interpreting what you see

Read the terminal output after one attempt:

| Observation | Diagnosis |
| --- | --- |
| Neither `[init]` nor `[callout-wired]` appears | The engine isn't being instantiated. Probably the `handleOverlayGo` path isn't reached — check the camera/StartOverlay chain. |
| `[init]` appears but `[callout-wired]` doesn't | `createCalloutEngine` is called from somewhere else (a stale leftover code path). The orchestrator is not wiring up callouts. |
| Both `[init]` and `[callout-wired]` appear; no `[frame]` logs | Engine is created but `ingestFrame` never gets called. Most likely cause: the detection loop's `if (res.landmarks.length >= 33)` guard never trips (pose extractor is failing). Look for `[mode-b] PoseExtractor.init() failed` or the `pose tracking lost` toast in the UI. |
| `[init]` + `[callout-wired]` + `[frame]`; no `[beat]` logs | Frames are arriving but their timestamps never reach the first accent-beat window. Two sub-cases: (a) beats are spaced wider than the attempt's duration (unlikely at typical BPMs); (b) timestamps are in the wrong unit — `ingestFrame` expects session-relative ms, beats are session-relative ms; if either got swapped for absolute routine ms the windows never intersect. Sanity-check `[frame]` log values against `[callout-engine][init] accentBeats=N` — at 120 BPM and `every-2nd-beat`, accent beats are 1000ms apart, so frame `ts` should bracket each beat. |
| `[beat]` logs appear but every beat shows `tier=GROOVY` (windowMax ≥ 0.88) | Similarity values are inflated upstream — that's the next spec, not this one. The per-frame `[frame]` log makes the inflation visible. |
| `[beat]` logs appear but no `[fire]` logs | `onCallout` is undefined or the engine's `Number.isFinite(maxSim)` guard is tripping for every beat (no frames in window). |

## Where to look next

Once a real attempt is run, the validator should paste the first ~30
log lines from the terminal. Common patterns:

- A long stream of `[frame]` logs with similarity clustered above 0.88
  → thresholds are too loose; tune `CALLOUT_THRESHOLDS` in
  `lib/scoring/callouts/calloutEngine.ts` in the next PR.
- `[init]` count >> 1 across one attempt → `createCalloutEngine` is
  being re-instantiated mid-run, which would wipe `beatMax` and explain
  the "always GROOVY" behavior.
- `[mode-b][callout-wired]` shows `accentBeatCount=0` → the BPM is
  unset for the dance and `deriveAccentBeatsFromBpm` is returning empty;
  fall back to the every-800ms branch.

## What is NOT done in this PR

- No threshold tuning.
- No bug fix.
- No engine restructuring.

The deliverable here is the visibility itself: after one validation run,
we can answer "is the engine running?" with certainty instead of guessing.
