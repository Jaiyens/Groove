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

const SCORE_PROMPT = `Video 1 is the reference choreography. Video 2 is the student's attempt at the same routine.

Score the attempt 0–100 on:
- timing (on beat vs early/late)
- shape (body positions match)
- energy (sharpness, hits, pauses match)
- flow (smooth transitions)

Then give the top 3 moments to fix and 1 thing they did well. Every observation needs an MM:SS timestamp from Video 2 and must name specific body parts.

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
