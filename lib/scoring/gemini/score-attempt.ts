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

const SCORE_PROMPT = `Video 1 is the reference choreography. Video 2 is the student's attempt at the same routine. You are measuring how closely Video 2 matches Video 1 — similarity to the reference, not the student's absolute dance skill or execution polish.

SCORING PROCEDURE
Decide the score by counting MOVE MATCHES, not by judging execution polish.
1. Walk through the reference's choreography and identify the distinct moves (each hit, arm pattern, hip motion, body roll, etc.).
2. For each move, check whether the student did roughly the same move, with roughly the right body part, in roughly the right direction, on roughly the right beat.
3. Pick the tier based on what fraction of moves match:

- 90–100: Nearly every move matches in direction, body part, and beat. Clean execution.
- 75–89: Most moves match. Some timing slips, reduced amplitude, or soft execution. THIS IS THE DEFAULT for a student who clearly learned the dance and is performing it — start here and only move DOWN if moves are actually missing, wrong, or in the wrong order.
- 60–74: Several moves missing or in the wrong direction. Overall shape still recognizable.
- 40–59: Moving to the music but not actually doing the reference choreography. Wrong moves, wrong order, or improvising.
- Below 40: Standing still, barely moving, flailing randomly, or doing something unrelated.

EXECUTION QUALITY IS NOT AN ERROR
Do NOT lower the score for any of these:
- Weak, soft, or small motion when the correct move is happening
- Slightly rushed or collapsed transitions when the correct move is being attempted
- Imperfect posture, "lacking sharpness", "lacking distinct angles", "lacking crispness"
- Hand or finger details (exact finger curls, hand shapes, gestures)
- Amplitude differences (smaller version of the right move)
- Stylistic choices that don't change which move is being done

Only lower the score for STRUCTURAL mismatches: wrong direction, wrong body part, wrong beat, or skipped move entirely. A student who does all the right moves with soft execution scores in the 80s, NOT the 60s.

Axes (all 0-100, all using the same anchors above):
- timing: on-beat-ness of the moves
- shape: body positions and directions matching the reference (not how cleanly executed)
- energy: how well sharpness, hits, and pauses match the reference's energy profile (not raw motion amount)
- flow: smoothness of transitions between moves
- overall: holistic similarity

Give the top 3 moments to fix and 1 thing they did well. Fixes may be polish-level (sharpness, extension, finger detail) — that's coaching, not a reason to lower the score. Every observation needs an MM:SS timestamp from Video 2 and must name specific body parts.

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
