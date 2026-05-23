# SPECK.md — Chunk Windowing + Leg Visibility + Generosity Calibration

## Context

Previous PR (gemini-scoring-with-callouts) shipped the hybrid scoring architecture: MediaPipe drives live callouts during the dance, Gemini drives the post-attempt verdict. Architecture is correct. Pipeline works end-to-end.

But validation revealed three correctness bugs in what we're sending Gemini:

1. **Reference video is way too long.** Logs showed a ~15s reference being sent for a chunk window of `from=1500&to=3000` (1.5s of choreography). Gemini hallucinated trouble spots at `start_sec: 13.0–15.0` for a 7-10s user attempt — it was describing reference events past the end of the user's recording as "you stood still."

2. **Gemini doesn't know the reference is a chunk, not a full routine.** Prompt frames it as "a TikTok dance," so Gemini assumes a full performance and penalizes the user for everything in the reference, including incidental motion.

3. **Legs get punished when they're not in frame.** User often films upper-body only; reference shows legs; Gemini scores legs at 0 and tanks overall. MediaPipe knows whether legs are visible — we should pass that to Gemini.

This PR fixes all three. Branch off latest `main` (after merging the previous PR) into `gemini-windowing-fix`.

---

## Hard rules

1. The two scoring paths (MediaPipe live callouts, MediaPipe final fallback, Gemini final) all remain. We are not changing the architecture, only the inputs and the prompt.
2. Do not modify the callout engine or the holding screen.
3. Backward compatibility: if `legsVisible` is undefined (older clients), default to `true` (current behavior).
4. Branch: `gemini-windowing-fix`. One commit per file group. Do not push to main.

---

## File-by-file plan

### MODIFIED: `lib/scoring/gemini/client.ts`

The browser client currently sends the full reference video and the full attempt blob. Two changes:

**Change 1: Trim the reference to the chunk window with padding.**

Currently the client either fetches the full reference URL or fetches a pre-trimmed reference. Going forward, the client receives the chunk start and end timestamps as parameters and trims the reference video in the browser before encoding.

```typescript
export type ScoreWithGeminiArgs = {
  attemptBlob: Blob;
  referenceVideoUrl: string;
  chunkStartMs: number;        // NEW: e.g. 1500
  chunkEndMs: number;          // NEW: e.g. 3000
  legsVisible: boolean;        // NEW: from MediaPipe
  signal?: AbortSignal;
};
```

Padding: **500ms on each side** of the chunk window. So for `chunkStartMs=1500, chunkEndMs=3000`, the reference sent to Gemini covers `1000ms → 3500ms` (2.5s total). Clamp to `[0, referenceDuration]`.

Implementation: use a hidden `<video>` element + canvas + MediaRecorder to extract the padded chunk window into a new Blob client-side. There is a known pattern for this; if it gets hairy, the alternative is to add a server-side trim endpoint that uses ffmpeg — but try client-side first. If client-side trimming fails or is unreliable, fall back to sending the full reference with explicit `referenceChunkStartSec` and `referenceChunkEndSec` fields in the API call and let Gemini handle the windowing via prompt (less ideal, flag in PR).

**Change 2: Pass `legsVisible` and chunk timing to the API route.**

```typescript
body: JSON.stringify({
  referenceVideoBase64,
  attemptVideoBase64,
  referenceMimeType,
  attemptMimeType,
  legsVisible,                  // NEW
  referenceChunkStartSec: 0,    // NEW: where in the padded reference the actual chunk begins (0.5s if padded)
  referenceChunkEndSec: 2.0,    // NEW: where it ends
})
```

These last two fields tell Gemini *within the padded reference video* where the actual choreography lives — so it knows "the first 0.5s and last 0.5s are padding, score against the middle."

**Acceptance:** Given a `referenceVideoUrl`, `chunkStartMs=1500`, `chunkEndMs=3000`, the function trims the reference to a 2.5s clip (1000ms–3500ms in original), encodes to base64, and the resulting base64 length is roughly 1/6 of what it was before for the same source video.

### MODIFIED: `app/api/score-gemini/route.ts`

Accept the new fields. Validate. Pass through to the prompt template.

```typescript
const {
  referenceVideoBase64,
  attemptVideoBase64,
  referenceMimeType,
  attemptMimeType,
  legsVisible = true,                // NEW with default
  referenceChunkStartSec = 0,        // NEW with default
  referenceChunkEndSec,              // NEW, derived if missing
} = body;
```

When building the Gemini request, interpolate the new context into the prompt (see prompt update below). Leave the diagnostic logging from last round in place — it's been useful, keep it.

**Acceptance:** Route accepts new fields without breaking. Old clients sending no `legsVisible` still work (treated as visible).

### MODIFIED: `lib/scoring/gemini/prompt.ts`

This is the biggest substantive change. Replace the entire prompt with the version below. It must remain a single template string that interpolates `legsVisible`, `referenceChunkStartSec`, `referenceChunkEndSec`.

```typescript
export function buildGeminiPrompt(args: {
  legsVisible: boolean;
  referenceChunkStartSec: number;
  referenceChunkEndSec: number;
}): string {
  const { legsVisible, referenceChunkStartSec, referenceChunkEndSec } = args;

  return `You are a dance teacher grading a student's attempt at a SINGLE CHUNK of a TikTok dance.

VIDEOS
You will receive two videos in order: REFERENCE, then ATTEMPT.
The ATTEMPT is captured from a front-facing camera and is mirrored. Grade it as a mirror copy — when the reference dancer's left arm goes up, the attempt's right arm going up is CORRECT.

CHUNK CONTEXT
The reference video is a short chunk of a longer dance, not a complete routine.
The actual choreography to grade against is between ${referenceChunkStartSec.toFixed(2)}s and ${referenceChunkEndSec.toFixed(2)}s of the reference video. The seconds before and after are padding — the dancer settling in or recovering. IGNORE THOSE PADDING SECONDS.

The attempt video may be longer than the choreography window — the user has natural lead-in (preparing to dance) and lead-out (finishing, walking back to camera) time. IGNORE those too. Score only the user's attempt to perform the choreography in the reference window.

DO NOT report trouble spots past the end of the reference choreography. There is no more dance to compare against.

WHAT TO SCORE AND WHAT TO IGNORE
The dance is the deliberate, repeatable choreography — the hits, the arm patterns, the steps, the body movements that are clearly choreographed.

IGNORE incidental motion in the reference:
- The dancer walking into frame or pressing play
- Casual swaying while the music starts or between moves
- Drifting toward or away from the camera
- Settling into position before the choreography starts
- Relaxing after the final hit
These are setup and recovery, not choreography. Do NOT penalize the user for failing to replicate them.

PERSONAL STYLE IS NOT AN ERROR
The user may execute the choreography with their own angle, energy, or flourish. If the core move is recognizable, that is success. Score DOWN only for missing or incorrect choreography — not for stylistic variation.

${legsVisible
  ? 'LEGS: The user has their legs in frame. Score legs normally as part of the choreography.'
  : 'LEGS: The user is filming UPPER BODY ONLY — legs are not in frame. This is a framing choice, not a performance error. Score the legs component generously (default 75) and do not let leg-related issues affect overall_score significantly. Do NOT include leg-related trouble spots. Focus your trouble spots on arms, body, and timing.'}

SCORING
Score four components 0-100: ARMS, LEGS, BODY, TIMING.

Assign OVERALL TIER:
- GROOVY (85-100): full performance, on the beat, choreography recognizable and well-executed
- SOLID (65-84): clearly attempting the choreography, mostly correct, recognizable
- SHAKY (40-64): attempting but missing or wrong on key moves, or noticeably off-beat
- NOT_DANCING (0-39): standing still, random flailing, off-camera, or no attempt at the choreography

CANARY
If the user is NOT actually attempting the choreography (standing completely still, random flailing unrelated to the dance, walking out of frame the whole time), set is_actually_dancing=false and score below 40. The generosity guidance above does NOT apply to non-attempts.

TROUBLE SPOTS
1-5 trouble spots. Each must be:
- Timestamped relative to the ATTEMPT video, not the reference
- Specific: "your right arm extension on the chorus accent didn't reach full" is good; "keep practicing" is not
- Within the bounds of the attempt video duration
- About actual choreography, not incidental motion

INSIGHTS
1-4 specific, actionable observations. Lead with the most impactful one. Mix at least one positive ("your timing on the opening hit was good") with constructive feedback when the attempt was sincere.

OUTPUT
Return ONLY valid JSON matching the schema. No prose, no markdown.`;
}
```

Update the import in `route.ts` from the old constant to the new function. Pass `legsVisible`, `referenceChunkStartSec`, `referenceChunkEndSec` from the request body.

**Acceptance:** Calling `buildGeminiPrompt({legsVisible: false, referenceChunkStartSec: 0.5, referenceChunkEndSec: 2.0})` produces a string with the upper-body-only language and the correct timestamps interpolated.

### MODIFIED: Mode B orchestration (wherever `scoreWithGemini` is called)

Two changes:

**Change 1:** Pass the chunk start/end timestamps (already in the URL as `?from=&to=`) into `scoreWithGemini`.

**Change 2:** Detect leg visibility from MediaPipe pose data. Add a utility:

```typescript
// lib/scoring/legVisibility.ts (NEW)

/**
 * Determines if the user's legs were visible in their attempt.
 * Returns true if knee/ankle landmarks were detected with confidence > 0.5
 * in at least 60% of frames where pose was detected at all.
 */
export function detectLegsVisible(poseFrames: PoseFrame[]): boolean {
  if (poseFrames.length === 0) return true; // default generous

  const LEG_LANDMARKS = [25, 26, 27, 28]; // L_KNEE, R_KNEE, L_ANKLE, R_ANKLE in MediaPipe
  const VISIBILITY_THRESHOLD = 0.5;
  const FRAME_RATIO_THRESHOLD = 0.6;

  const framesWithLegsVisible = poseFrames.filter(frame => {
    if (!frame.landmarks) return false;
    const visibleLegLandmarks = LEG_LANDMARKS.filter(idx => {
      const lm = frame.landmarks[idx];
      return lm && (lm.visibility ?? 0) > VISIBILITY_THRESHOLD;
    });
    return visibleLegLandmarks.length >= 3; // at least 3 of 4 leg points visible
  });

  return (framesWithLegsVisible.length / poseFrames.length) >= FRAME_RATIO_THRESHOLD;
}
```

Then in the orchestrator:

```typescript
const legsVisible = detectLegsVisible(capturedPoseFrames);
const geminiResult = await scoreWithGemini({
  attemptBlob,
  referenceVideoUrl,
  chunkStartMs: chunk.fromMs,
  chunkEndMs: chunk.toMs,
  legsVisible,
});
```

**Acceptance:** Running on a clip where the user has legs in frame, `detectLegsVisible` returns `true`. On a clip where the user is upper-body only, returns `false`. Mode B passes the right value to Gemini.

### MODIFIED: `components/ResultsCard.tsx` (small change)

When `legsVisible: false` was sent, the legs score in the response will be ~75 (per prompt guidance). Add a small subtle indicator on the LEGS component pill: a tooltip or "(upper body only)" subtext so the user understands why the leg score is what it is. Do NOT hide the pill — just contextualize.

Pull the `legsVisible` info through the result object (add it to whatever shape comes back from the orchestrator). Optional polish, not blocking.

**Acceptance:** When user films upper-body only, the LEGS pill on the results card shows a small "(upper body only)" annotation.

---

## What's deliberately NOT changed

- Live callouts (MediaPipe) — unchanged. They already use the chunk window correctly.
- Holding screen — unchanged.
- MediaPipe final fallback path — unchanged.
- Drill mode routing — unchanged. Gemini's trouble_spot timestamps are still relative to the attempt video, the existing `drillUrlForGeminiSpot` adapter still works.
- Schema — unchanged. We're not adding a `legsExcluded` field because the prompt already handles it via a generous default score.

---

## Out of scope (do NOT do)

- Server-side video trimming with ffmpeg (try client-side first, only fall back if needed and flag it)
- Auto-detecting other framing issues (zoomed in too far, off-center, etc.) — legs only for now
- Changing the schema or component shape
- Tuning callout thresholds — separate problem
- Adding analytics on `legsVisible` — separate PR

---

## Acceptance summary

- [ ] Reference video sent to Gemini is approximately 2.5s (chunk + 0.5s padding each side), confirmed by base64 length in logs (roughly 600KB–1.2MB raw depending on resolution).
- [ ] Gemini's trouble spot timestamps fall within the attempt video duration — no more 13–15s timestamps for a 7s attempt.
- [ ] When user films upper-body only, `detectLegsVisible` returns `false`, Gemini gets the upper-body-only prompt, and legs scores in the response are ≥70.
- [ ] When user films full-body, `detectLegsVisible` returns `true`, Gemini scores legs normally.
- [ ] Sincere attempt on chunk 1 scores ≥60 (validating the generosity calibration works).
- [ ] Standing-still attempt still scores <40 (canary intact).
- [ ] Random flailing still scores <40 (canary intact).
- [ ] Diagnostic logs from previous round are preserved.
- [ ] All existing tests pass.
- [ ] Branch `gemini-windowing-fix` pushed locally, not merged.

---

## After Claude Code finishes — your validation

Run three attempts in a row, terminal visible:

1. **Sincere attempt on chunk 1, upper body only.** Look for legs score ≥70 in the Gemini response. Look for trouble spots that stay within your attempt's time range. Expect overall score 60–85.

2. **Standing still for 7s.** Expect `is_actually_dancing: false`, overall <40. Canary must still work.

3. **Random arm flailing for 7s.** Expect `is_actually_dancing: false`, overall <40. This is the test that Gemini still catches non-dances even with generosity calibration.

Paste the three raw Gemini responses + base64 lengths back if anything looks off.