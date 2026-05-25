// Post-attempt dance scoring via Vercel AI SDK + AI Gateway.
//
// Server-only. Sends two full mp4 videos (reference + attempt) to
// google/gemini-3.5-flash in one call and returns a validated score.
//
// Constraints:
//   - Inline upload caps the whole request body at ~100MB (Gemini limit).
//     Dance-chunk mp4s are typically 1–10MB so this is fine.
//   - Both inputs must be H.264 mp4. Gemini rejects video/webm.
//   - No retries or fallbacks here — raw model behavior is the point.
//
// Why `reasoning` is the first schema field: Gemini emits properties in
// declaration order, so putting reasoning first forces a chain-of-thought
// pass before any numeric score is committed. Free-form CoT inside
// structured output substantially improves multimodal scoring accuracy.

import { readFile } from 'node:fs/promises';
import { generateObject } from 'ai';
import { z } from 'zod';

const SCORE_PROMPT = `Video 1 is the reference choreography. Video 2 is the student's attempt at the same routine. Score how closely Video 2 matches Video 1.

First, in the \`reasoning\` field, walk through the reference's moves in order. For each move, state whether the student did roughly the same move (right body part, right direction, right beat) or missed it / did something different. Use MM:SS timestamps and name specific body parts. This grounds the score — do it before assigning numbers.

Then score using these anchors:
- 90–100: Nearly every move matches in direction, body part, and beat. Clean execution.
- 75–89: Most moves match. A practiced attempt with timing slips or soft execution belongs here.
- 60–74: Several moves missing or in the wrong direction. Shape still recognizable.
- 40–59: Doing different moves to the music, not the reference's choreography.
- Below 40: Standing still, flailing randomly, or doing something unrelated to the reference.

DO NOT lower the score for: weak/soft motion of the right move, slightly rushed transitions, imperfect posture, hand/finger detail, smaller amplitude, or stylistic variation. ONLY lower for STRUCTURAL mismatches: wrong direction, wrong body part, wrong beat, or skipped/different move.

Axes (all 0–100, using the same anchors):
- timing: on-beat-ness
- shape: body positions and directions matching (not how cleanly executed)
- energy: sharpness/hits/pauses matching (not raw motion amount)
- flow: smoothness of transitions
- overall: holistic similarity

Top 3 moments to fix, 1 thing they did well. Every observation needs an MM:SS timestamp from Video 2 and must name specific body parts.`;

export const DanceScoreSchema = z.object({
  reasoning: z.string(),
  scores: z.object({
    timing: z.number().min(0).max(100),
    shape: z.number().min(0).max(100),
    energy: z.number().min(0).max(100),
    flow: z.number().min(0).max(100),
    overall: z.number().min(0).max(100),
  }),
  fixes: z
    .array(
      z.object({
        timestamp: z.string(),
        what_happened: z.string(),
        fix: z.string(),
      }),
    )
    .min(1)
    .max(5),
  did_well: z.object({
    timestamp: z.string(),
    note: z.string(),
  }),
  summary: z.string(),
});

export type DanceScore = z.infer<typeof DanceScoreSchema>;

export async function scoreDanceAttempt(
  referenceVideoPath: string,
  attemptVideoPath: string,
): Promise<DanceScore> {
  const [referenceBuffer, attemptBuffer] = await Promise.all([
    readFile(referenceVideoPath),
    readFile(attemptVideoPath),
  ]);

  // FPS=2 on each video part: default sampling is 1 FPS, which only captures
  // every-other-beat for dance. Doubling it materially improves fine motion
  // discrimination per Gemini's own recommendation for fast-action content.
  const videoProviderOptions = {
    google: { videoMetadata: { fps: 2 } },
  };

  const { object } = await generateObject({
    model: 'google/gemini-3.5-flash',
    schema: DanceScoreSchema,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            data: referenceBuffer,
            mediaType: 'video/mp4',
            providerOptions: videoProviderOptions,
          },
          {
            type: 'file',
            data: attemptBuffer,
            mediaType: 'video/mp4',
            providerOptions: videoProviderOptions,
          },
          { type: 'text', text: SCORE_PROMPT },
        ],
      },
    ],
  });

  return object;
}
