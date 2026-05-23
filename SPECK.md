# SPEC: Hybrid Scoring — Live Callouts (MediaPipe) + Post-Attempt Verdict (Gemini)

## Context — read this first

Mode B scoring was rebuilt last night with MediaPipe (joint angles, DTW, per-joint weights, dual-skeleton overlay, drill mode, results card). All 97 tests pass. The rebuild summary lives at `/docs/scoring-rebuild-summary.md`.

The architecture decision for this PR: **two systems, two jobs.**

1. **MediaPipe drives LIVE in-dance callouts** — GROOVY / PERFECT / GREAT / ALMOST flash on screen during the dance, on accent beats, as the user moves. Per-frame, local, free, real-time. This is the dopamine layer.
2. **Gemini 2.5 Flash drives the POST-ATTEMPT verdict** — overall score, per-component breakdown, semantic insights, timestamped trouble spots. Async (5-15s after attempt ends), via inline base64 video. This is the intelligence layer.
3. **The dual-skeleton overlay is the visual language throughout** — Mode A practice, during the dance, and on the post-attempt holding screen. Built last night, reused as-is.

The two systems do not share vocabulary or compete. Live callouts are vibe; Gemini is the verdict. When they disagree, Gemini wins.

---

## What you are building

### High-level flow

1. User finishes attempt setup, countdown plays (existing).
2. **During the dance:** MediaPipe runs per-frame as it does today, but now also drives an overlay layer that flashes a callout (GROOVY / PERFECT / GREAT / ALMOST) on accent beats. Callouts are visual only, no sound, large centered glyph, fades in 150ms, holds 400ms, fades out 250ms.
3. **Attempt ends:** recording is captured to a Blob, holding screen launches immediately (minimum 3s).
4. **Holding screen:** plays back the user's attempt with the dual-skeleton overlay. Status text rotates: "Watching your timing…" → "Checking arm extension…" → "Measuring rhythm…"
5. **In parallel:** MediaPipe final scoring runs locally (existing pipeline). Gemini scoring runs via fetch to a new serverless endpoint with inline base64 video.
6. Both resolve. After minimum 3s of holding screen has elapsed AND Gemini has returned, transition to results.
7. **Results screen:** Gemini's score is the headline. Gemini's tier, components, insights, and trouble spots drive the UI. Drill mode routing uses Gemini's trouble_spots.
8. **Validation mode (`NEXT_PUBLIC_SHOW_BOTH_SCORES=true`):** MediaPipe final score appears as a small grey debug pill below Gemini's score, plus a "Why are these different?" expander.
9. **Fallback:** if Gemini fails (timeout, network, schema error), results screen renders from MediaPipe silently. No user-visible error.

---

## File-by-file plan

### NEW: `lib/scoring/callouts/types.ts`

```typescript
export type CalloutTier = 'GROOVY' | 'PERFECT' | 'GREAT' | 'ALMOST';

export type CalloutEvent = {
  tier: CalloutTier;
  beatIndex: number;      // which accent beat this fired on
  timestamp: number;      // performance.now() at fire time
  similarity: number;     // raw 0-1 similarity score from MediaPipe at this moment
};
```

### NEW: `lib/scoring/callouts/calloutEngine.ts`

The per-frame logic that decides when to fire a callout and at what tier.

Requirements:
- Accepts a stream of per-frame similarity scores (already computed by the existing scoring pipeline — do not recompute).
- Accepts a list of **accent beat timestamps** for the current chunk. For now, derive accent beats as every 2nd beat from the existing `beatTracker.ts` output. If beat tracker is unreliable, fall back to every 800ms from chunk start.
- On each accent beat, look at a small window (±150ms) of similarity scores around that beat and take the max. This rewards the user for being roughly on-beat without punishing minor timing slips.
- Map the window-max similarity to a tier using these thresholds (tunable constants at the top of the file):
  - `>= 0.88` → GROOVY
  - `>= 0.75` → PERFECT
  - `>= 0.60` → GREAT
  - `< 0.60`  → ALMOST
- **Critical: thresholds are calibrated toward generosity.** Live callouts are the dopamine layer; harsh judgment is Gemini's job. If a session is averaging mostly ALMOST, the user disengages. Tune so that a real attempt fires mostly PERFECT/GREAT with occasional GROOVY peaks and rare ALMOST.
- Emit `CalloutEvent` via callback. Do not store all events in component state — that re-renders too often.

```typescript
export function createCalloutEngine(config: {
  accentBeatTimestamps: number[];
  onCallout: (event: CalloutEvent) => void;
}): {
  ingestFrame: (frame: { timestamp: number; similarity: number }) => void;
  reset: () => void;
};
```

**Acceptance:** Unit test with a synthetic similarity stream where a known accent beat has similarity 0.92 → fires GROOVY. Stream with similarity 0.4 → fires ALMOST. No callouts fire between accent beats.

### NEW: `components/scoring/CalloutOverlay.tsx`

The visual layer that renders the callout text.

Requirements:
- Listens to `CalloutEvent`s and renders the most recent one, large, centered over the video.
- Animation: scale-in from 0.7 → 1.0 with 150ms ease-out, hold 400ms, fade-out with 250ms ease-in. Total on-screen time ~800ms.
- Color per tier:
  - GROOVY: brand pink (#FF1F8E), with a subtle radial glow
  - PERFECT: white with pink stroke
  - GREAT: white
  - ALMOST: muted grey (#BBB) — visible but not punishing
- Typography: heavy display sans, 64px on mobile, all caps, tight letter-spacing.
- **Z-index above the skeleton overlay but below any modal/results layer.**
- If a new callout fires while a previous is still animating, the new one immediately replaces it (no queueing, no stacking).
- No sound. Vibe is visual only for now.

**Acceptance:** Manually fire callouts via dev panel, verify timing feels good (snappy, not laggy). On mobile (390px), text is readable but doesn't dominate the screen.

### NEW: `lib/scoring/gemini/types.ts`

Define the structured-output schema Gemini returns. Use Zod for runtime validation.

```typescript
import { z } from 'zod';

export const TroubleSpotSchema = z.object({
  start_sec: z.number(),
  end_sec: z.number(),
  body_part: z.enum(['arms', 'legs', 'body', 'timing']),
  severity: z.enum(['minor', 'moderate', 'major']),
  what_happened: z.string(),
  fix: z.string(),
});

export const GeminiScoreSchema = z.object({
  is_actually_dancing: z.boolean(),
  overall_score: z.number().min(0).max(100),
  tier: z.enum(['GROOVY', 'SOLID', 'SHAKY', 'NOT_DANCING']),
  components: z.object({
    arms: z.number().min(0).max(100),
    legs: z.number().min(0).max(100),
    body: z.number().min(0).max(100),
    timing: z.number().min(0).max(100),
  }),
  insights: z.array(z.string()).min(1).max(4),
  trouble_spots: z.array(TroubleSpotSchema).max(5),
});

export type GeminiScore = z.infer<typeof GeminiScoreSchema>;
```

**Note on vocabulary overlap:** Gemini's tier `GROOVY` and the live-callout tier `GROOVY` share a name but are different concepts. Gemini's GROOVY = overall verdict tier 85-100. Live callout GROOVY = single-moment peak hit. Do not normalize these; they're separate semantic spaces. Add a comment to that effect in the types file.

### NEW: `lib/scoring/gemini/prompt.ts`

```typescript
export const GEMINI_SCORING_PROMPT = `You are a dance teacher grading a student's attempt at a TikTok dance.

You will receive two videos in order: REFERENCE, then ATTEMPT.
The ATTEMPT is captured from a front-facing camera and is mirrored. Grade it as a mirror copy — when the reference dancer's left arm goes up, the attempt's right arm going up is CORRECT.

Score four components 0-100: ARMS, LEGS, BODY, TIMING.
Assign OVERALL TIER:
- GROOVY (85-100): full performance, on the beat, full extension
- SOLID (65-84): clearly attempting the dance, mostly correct
- SHAKY (40-64): attempting but missing key moves or off-beat
- NOT_DANCING (0-39): standing still, flailing randomly, or off-camera

CRITICAL CANARY: If the attempt is not actually a dance attempt (standing still, hands flailing randomly, walking out of frame), set is_actually_dancing=false and score below 40.

Trouble spots must be specific and timestamped. "Your right arm extension on the chorus accent didn't reach full extension" is good. "Keep practicing" is not.

Insights should be 1-4 specific, actionable observations. Lead with the biggest issue.

Return ONLY valid JSON matching the schema. No prose, no markdown.`;
```

### NEW: `app/api/score-gemini/route.ts`

Next.js API route. POST with `referenceVideoBase64`, `attemptVideoBase64`, mime types. Calls Gemini 2.5 Flash with inline video (NOT Files API — known reliability issues). Validates response with `GeminiScoreSchema`. Returns `{score, latencyMs}` or `{error}`.

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_SCORING_PROMPT } from '@/lib/scoring/gemini/prompt';
import { GeminiScoreSchema } from '@/lib/scoring/gemini/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { referenceVideoBase64, attemptVideoBase64, referenceMimeType, attemptMimeType } = body;

  if (!referenceVideoBase64 || !attemptVideoBase64) {
    return NextResponse.json({ error: 'Missing videos' }, { status: 400 });
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { text: GEMINI_SCORING_PROMPT },
          { text: 'REFERENCE:' },
          { inlineData: { mimeType: referenceMimeType || 'video/mp4', data: referenceVideoBase64 } },
          { text: 'ATTEMPT:' },
          { inlineData: { mimeType: attemptMimeType || 'video/mp4', data: attemptVideoBase64 } },
        ],
      }],
      config: {
        responseMimeType: 'application/json',
        // Hand-write the JSON schema matching GeminiScoreSchema, or use zod-to-json-schema package
        responseSchema: /* TODO: JSON Schema */,
      },
    });

    const latencyMs = Date.now() - startTime;
    const parsed = GeminiScoreSchema.parse(JSON.parse(response.text));
    return NextResponse.json({ score: parsed, latencyMs });
  } catch (err) {
    console.error('[gemini-score] failed', err);
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
```

**Acceptance:** `POST /api/score-gemini` with real video pair returns valid `{score, latencyMs}`. Test once with curl before wiring UI.

### NEW: `lib/scoring/gemini/client.ts`

Browser client. Takes attempt Blob + reference video URL, encodes both to base64, POSTs to `/api/score-gemini`, validates response, returns tagged union. 30s timeout. Never throws.

```typescript
export type GeminiResult =
  | { kind: 'success'; score: GeminiScore; latencyMs: number }
  | { kind: 'error'; reason: string };

export async function scoreWithGemini(
  attemptBlob: Blob,
  referenceVideoUrl: string,
  signal?: AbortSignal,
): Promise<GeminiResult>;
```

**Note on payload size:** Vercel API routes cap request bodies (~4.5MB Hobby, 5MB Pro). Two 15s 720p clips base64-encoded can hit that ceiling. If you hit it: change the API contract so the reference is passed as a URL (server fetches it) and only the attempt goes as base64. Flag this in a comment but don't pre-optimize — measure first.

**Acceptance:** Given an attempt Blob + reference URL, returns success or tagged error in under 30s. Never throws to caller.

### NEW: `components/scoring/HoldingScreen.tsx`

Shown after attempt ends, before results.

Requirements:
- Plays back the user's recorded attempt from the Blob URL.
- Renders the dual-skeleton overlay on top (reuse the component from last night's rebuild — find and import it, do not rebuild).
- Status text below the video, rotating every 2 seconds: "Watching your timing…" → "Checking arm extension…" → "Measuring rhythm…" → "Almost there…"
- Subtle progress shimmer at bottom (no percentage).
- **Stays mounted for minimum 3 seconds** even if Gemini returns faster.
- When both `minTimeElapsed && geminiResolved` → fade to results.

**Acceptance:** Immediately renders after attempt. Video replays with dual skeletons. Status text rotates. Transition to results is smooth, never less than 3s.

### MODIFIED: Mode B orchestration

Wire the new pieces in. Find where MediaPipe scoring currently kicks off in Mode B.

**During the dance (new):**
- Initialize `createCalloutEngine` at countdown end, passing in the accent beat timestamps for this chunk.
- The existing per-frame scoring loop already computes a similarity score per frame. Pipe each frame into `calloutEngine.ingestFrame({timestamp, similarity})`.
- `CalloutOverlay` mounts above the video, listens to the callout events, renders them.

**After attempt ends (modified):**
```typescript
const [mediapipeFinal, geminiResult] = await Promise.all([
  scoreMediaPipeFinal(attemptFrames, referencePoseTrack),  // existing
  scoreWithGemini(attemptBlob, referenceVideoUrl),         // new
]);

const finalScore = geminiResult.kind === 'success'
  ? { primary: geminiResult.score, backup: mediapipeFinal, source: 'gemini' as const }
  : { primary: mediapipeFinalToGeminiShape(mediapipeFinal), backup: null, source: 'mediapipe-fallback' as const };
```

Build the `mediapipeFinalToGeminiShape` adapter so results card has one shape to render. Stub insights/trouble_spots from MediaPipe's existing per-joint output — quality lower but loop unbroken.

**Acceptance:** Live callouts fire during the dance. Both final scoring paths run in parallel. Gemini success drives UI; failure falls back to MediaPipe silently with `console.warn`.

### MODIFIED: `components/scoring/ResultsCard.tsx`

Add validation-mode rendering using `process.env.NEXT_PUBLIC_SHOW_BOTH_SCORES`.

- `true`: Gemini score is the headline. MediaPipe shows as small grey debug pill `"MediaPipe (debug): 67"`. "Why are these different?" expander shows side-by-side per-component comparison.
- `false`: Only Gemini. MediaPipe never visible.
- Insights and trouble spots always come from Gemini (or the adapter when Gemini failed).
- Drill mode routing reads `finalScore.primary.trouble_spots` — same field name in both cases.

**Acceptance:** Toggle env var, both modes render correctly.

### NEW: `.env.local` keys

```
GEMINI_API_KEY=
NEXT_PUBLIC_SHOW_BOTH_SCORES=true
```

`SHOW_BOTH_SCORES=true` during validation. Flip to `false` after 10-20 real attempts confirm Gemini is the better signal.

---

## Hard rules

1. **Live callouts are VIBE only.** They do not influence the final score, are not aggregated, are not reported to Gemini, do not affect drill routing. Gemini is the verdict.
2. **Calibrate callouts toward generosity.** Real attempts should fire mostly PERFECT/GREAT. ALMOST is rare. If testing shows ALMOST firing more than 30% of the time on a sincere attempt, lower the thresholds.
3. **Do not modify the MediaPipe scoring code from last night.** Add to it (the callout engine consumes its similarity stream), do not change it.
4. **Use inline base64 for Gemini, NOT the Files API.**
5. **Dual-skeleton overlay is reused, not rebuilt.** Import the existing component.
6. **Schema is the contract.** Invalid Gemini response → MediaPipe fallback. No regex repair attempts.
7. **30s timeout on Gemini → fallback.**
8. **Branch:** `gemini-scoring-with-callouts`. Do not push to main. One commit per file group.
9. **Holding screen minimum 3s** even if Gemini is faster.

---

## Out of scope

- Sound effects for callouts (later PR — design + asset work).
- Streaming Gemini responses.
- Caching Gemini results.
- Removing MediaPipe final scoring (separate PR after validation).
- Changes to Mode A.
- Changes to knowledge graph or drill routing logic.
- Analytics, auth, rate limiting.
- Multi-language callout text.

---

## Working agreement

- After each file group, pause and post a diff summary.
- Flag any conflict with existing code before restructuring silently.
- Mobile-first: verify callouts, holding screen, and results card at 390px.
- If Gemini's structured output is reliably malformed, stop and flag — do not paper over with repairs.
- If accent-beat timestamps aren't reliably available from the existing beat tracker, fall back to the every-800ms strategy and note it in the PR.

---

## Acceptance summary (all must pass)

- [ ] `/api/score-gemini` returns validated `GeminiScore` for real video pair via curl.
- [ ] `scoreWithGemini` browser client returns success or tagged error, never throws.
- [ ] **Live callouts fire during the dance on accent beats** with correct tier mapping.
- [ ] Callout overlay animation feels snappy on mobile, doesn't overlap with skeleton overlay.
- [ ] Mode B kicks off MediaPipe final + Gemini final in parallel after attempt.
- [ ] Holding screen displays for minimum 3s with replay + dual-skeleton + rotating status.
- [ ] Results card renders Gemini score as primary; MediaPipe shows as debug pill when `SHOW_BOTH_SCORES=true`.
- [ ] Gemini failure (force by killing network mid-call) → results card shows MediaPipe score, no visible error.
- [ ] Drill mode still works using Gemini's trouble_spots.
- [ ] All existing 97 tests still pass.
- [ ] Branch `gemini-scoring-with-callouts` pushed, no merge to main.

---

## After Claude Code finishes — your validation pass

Run 5 real attempts on the same dance:

1. **Real sincere attempt.** Live callouts should fire mostly PERFECT/GREAT, occasional GROOVY peaks, rare ALMOST. Gemini score 65-85.
2. **Standing still.** Live callouts should fire mostly ALMOST. Gemini `is_actually_dancing: false`, score below 40.
3. **Random flailing.** Live callouts mixed ALMOST/GREAT (similarity is high for random fast motion). Gemini `is_actually_dancing: false`, score below 40 — this is the key Gemini advantage over MediaPipe.
4. **Real attempt on a different dance.** Sanity check.
5. **Deliberately off-beat real attempt.** Live callouts should drop tier (timing similarity drops). Gemini should call out timing in the insights.

If runs 1 and 3 produce wildly different Gemini scores (real high, flailing low) AND live callouts feel good on the sincere attempt, flip `SHOW_BOTH_SCORES=false` and merge.

If anything looks off, paste the JSON outputs back and we tune the prompt or thresholds.