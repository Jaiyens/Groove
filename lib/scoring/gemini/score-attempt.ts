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

// Templated prompt — `{{SKILLS_JSON}}` is replaced at call time with the
// JSON-encoded `[{ id, name, description }]` array of the dance's required
// skills, so Gemini can attribute each `fix` to a concrete skill id.
const SCORE_PROMPT_TEMPLATE = `Video 1 is the reference choreography. Video 2 is the student's attempt at the same routine. Score how closely Video 2 matches Video 1.

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

Top 3 moments to fix, 1 thing they did well. Every observation needs an MM:SS timestamp from Video 2 and must name specific body parts.

For each fix, set \`attributed_skill_id\` to the id of the skill from this list whose execution most directly caused the miss, or null if no single skill clearly owns the miss. The skill's description is the rubric — pick the one whose criterion was broken by what you saw at that timestamp:

{{SKILLS_JSON}}

Be conservative: if a fix is about general timing slippage or whole-routine flow rather than one skill's specific failure mode, leave attributed_skill_id as null. Picking the wrong skill is worse than picking none.`;

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
        // The skill (from the dance's required_skills) whose criterion this
        // fix most directly violates. Null when no single skill clearly owns
        // the miss — see prompt for the conservativeness rule. Null is also
        // the fallback when scoring a dance that has no required_skills.
        attributed_skill_id: z.string().nullable(),
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

export interface AttributableSkill {
  id: string;
  name: string;
  description: string;
}

export async function scoreDanceAttempt(
  referenceVideoPath: string,
  attemptVideoPath: string,
  requiredSkills: AttributableSkill[] = [],
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

  const skillsJson = JSON.stringify(
    requiredSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    })),
  );
  const prompt = SCORE_PROMPT_TEMPLATE.replace('{{SKILLS_JSON}}', skillsJson);

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
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  // Defensive: Gemini occasionally returns a skill id that wasn't in the
  // list (hallucinated, slightly misspelled, or attributing across routines).
  // Treat any non-listed id as null so the recommender doesn't try to look
  // it up on the graph.
  const allowed = new Set(requiredSkills.map((s) => s.id));
  for (const fix of object.fixes) {
    if (fix.attributed_skill_id && !allowed.has(fix.attributed_skill_id)) {
      fix.attributed_skill_id = null;
    }
  }

  // Raw Gemini scores pass through here. The user-facing +10 boost
  // lives in lib/scoring/displayBoost.ts and is applied at render time
  // in ScoreRevealCard, so mastery + the per-skill projection track
  // the true signal.
  return object;
}
