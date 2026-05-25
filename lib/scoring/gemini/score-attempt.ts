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

import { readFile } from 'node:fs/promises';
import { generateObject } from 'ai';
import { z } from 'zod';

const SCORE_PROMPT = `Video 1 is the reference choreography. Video 2 is the student's attempt at the same routine. You are measuring how closely Video 2 matches Video 1 — similarity to the reference, not the student's absolute dance skill.

Use these calibration anchors for every score (timing, shape, energy, flow, overall):
- 90–100: Moves match the reference's directions, body parts, and beats with clean execution. Minor stylistic differences are fine.
- 75–89: Clearly the same dance. Most moves land on the right beats with the right body parts; some timing slips or reduced amplitude. A sincere, practiced attempt by a non-professional belongs here.
- 60–74: Attempting the choreography but missing significant moves or beats. Overall shape recognizable, execution loose.
- 40–59: Moving to the music but not actually doing the reference choreography. Motion present, alignment absent.
- Below 40: Standing still, barely moving, flailing randomly, or doing something unrelated to the reference.

Score down ONLY for moves that don't match the reference: wrong direction, wrong body part, wrong beat, or skipped entirely. Personal style, slightly smaller amplitude, and minor execution imperfections are NOT errors. Do not default to 50–60 out of caution — if the student is clearly doing the same dance, the score belongs in 75–89 or higher.

Axes:
- timing: on-beat-ness of the moves
- shape: body positions and directions matching the reference
- energy: sharpness, hits, and pauses matching (not raw motion amount)
- flow: smoothness of transitions between moves
- overall: holistic similarity using the same anchors

Give the top 3 moments to fix and 1 thing they did well. Every observation needs an MM:SS timestamp from Video 2 and must name specific body parts.

Return only this JSON:

{
  "scores": { "timing": 0, "shape": 0, "energy": 0, "flow": 0, "overall": 0 },
  "fixes": [
    { "timestamp": "MM:SS", "what_happened": "", "fix": "" }
  ],
  "did_well": { "timestamp": "MM:SS", "note": "" },
  "summary": ""
}`;

export const DanceScoreSchema = z.object({
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

  const { object } = await generateObject({
    model: 'google/gemini-3.5-flash',
    schema: DanceScoreSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'file', data: referenceBuffer, mediaType: 'video/mp4' },
          { type: 'file', data: attemptBuffer, mediaType: 'video/mp4' },
          { type: 'text', text: SCORE_PROMPT },
        ],
      },
    ],
  });

  return object;
}
