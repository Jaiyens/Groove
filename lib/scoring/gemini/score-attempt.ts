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

CRITICAL RUBRIC — read carefully:

A student "following the main structure" means they attempted the same moves in roughly the same order — same arms, same directions, same beat windows — even if execution is rough, soft, or behind tempo. **Following the main structure of the routine ALWAYS earns AT LEAST 75 on every axis.** If your reasoning concludes the student followed the main structure with decent rhythm, you MUST score 75 or higher. Anything below 75 is reserved for attempts that DO NOT follow the structure.

Score anchors (apply consistently to every axis):
- 90–100: Nearly every move matches in direction, body part, and beat. Clean, confident execution.
- 75–89: Main structure followed. The student attempted each reference move in roughly the right order with recognizable shapes, even with timing slips, soft execution, smaller amplitude, or imperfect posture. THIS IS THE FLOOR FOR "FOLLOWED THE ROUTINE."
- 60–74: Structure mostly followed but with one or two whole sections skipped or done in the wrong direction. Shape still recognizable across the rest.
- 40–59: Doing different moves to the music — only a few reference moves attempted. Not following the choreography.
- Below 40: Standing still, flailing randomly, or doing something unrelated to the reference.

DO NOT lower the score for: weak/soft motion of the right move, slightly rushed transitions, imperfect posture, hand/finger detail, smaller amplitude, stylistic variation, or facing the camera differently. ONLY lower for STRUCTURAL mismatches: wrong direction, wrong body part, wrong beat, or skipped/different move across multiple sections.

Self-check before committing the score: does my reasoning say the student followed the routine's main structure? If yes, every axis must be 75+. If you wrote "successfully followed the main structure" anywhere in reasoning, you are NOT allowed to score below 75.

Axes (all 0–100, using the anchors above):
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

  // Hardcoded feel-good boost: scores above 65 get +10 (clamped to 100).
  // Applied to every score field so components stay consistent with overall.
  // Target band for genuine attempts is 80–95; raw Gemini parks real attempts
  // around 76–80 which feels punishing to users.
  const boost = (s: number) => (s > 65 ? Math.min(100, s + 10) : s);
  return {
    ...object,
    scores: {
      timing: boost(object.scores.timing),
      shape: boost(object.scores.shape),
      energy: boost(object.scores.energy),
      flow: boost(object.scores.flow),
      overall: boost(object.scores.overall),
    },
  };
}
