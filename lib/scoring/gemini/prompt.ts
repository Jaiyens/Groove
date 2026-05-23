// Gemini scoring prompt.
//
// Two-video input order (REFERENCE then ATTEMPT) with explicit mirror-aware
// grading guidance (Group 1), motion-onset framing (Group 2), and a
// canary + component-floor calibration (Group 3 + Group 4).
//
// Round 3 changes (see SPECK round-3 §Group-4):
//   - The canary is binary AND quantitative. Standing still / flailing /
//     out-of-frame trips `is_actually_dancing: false` AND forces
//     overall_score into 5–25. Components in that case reflect reality
//     (e.g., flailing arms: 15, standing-still body: 5) — never padded up.
//   - Sincere attempts have an explicit per-component floor of 35.
//   - Upper-body-only mode returns `legs: null` (no more default 75).
//   - Trouble-spot count is capped by tier (GROOVY ≤2, SOLID ≤3,
//     SHAKY ≤4, NOT_DANCING =1).
//   - The first insight is positive ONLY when `is_actually_dancing: true`.
//     Non-attempts get an honest "this didn't look like the dance" insight
//     instead of a fake compliment.
//
// Schema is enforced via `responseSchema`, so prose-only here.

export function buildGeminiPrompt(args: {
  legsVisible: boolean;
  referenceChunkStartSec: number;
  referenceChunkEndSec: number;
  referenceMirrored?: boolean;
  videosMotionOnsetTrimmed?: boolean;
}): string {
  const {
    legsVisible,
    referenceChunkStartSec,
    referenceChunkEndSec,
    referenceMirrored = true,
    videosMotionOnsetTrimmed = true,
  } = args;

  // SPECK round-3 §Group-1: when the client trim mirrors the reference, the
  // model grades left/right LITERALLY. The legacy fallback path keeps the
  // older mirror-copy clause as a safety net.
  const orientationClause = referenceMirrored
    ? 'The REFERENCE video has been horizontally mirrored so that left/right correspond directly to the ATTEMPT video, which is captured from a front-facing camera. Grade left and right literally — when the reference\'s left arm goes up, the attempt\'s left arm should go up.'
    : 'The ATTEMPT is captured from a front-facing camera and is mirrored. The REFERENCE is in its source orientation (un-mirrored fallback). Grade as a mirror copy — when the reference dancer\'s left arm goes up, the attempt\'s right arm going up is CORRECT.';

  // SPECK round-3 §Group-2: motion-onset trim replaces the old padding-
  // ignore language. Fallback branch (re-encode unavailable or onset not
  // detected) keeps the legacy CHUNK CONTEXT block so the model still has
  // something to anchor on.
  const framingClause = videosMotionOnsetTrimmed
    ? `CHUNK CONTEXT
Both videos start exactly at the moment of first dance movement. There is no pre-roll padding. All trouble spots must reference timestamps within the dance, not before it. The choreography in the reference runs to ${referenceChunkEndSec.toFixed(2)}s — DO NOT report trouble spots past that point.

WHAT COUNTS AS THE DANCE
The dance is the deliberate, repeatable choreography — the hits, the arm patterns, the steps, the body movements that are clearly choreographed. Personal style and minor stylistic variation are not errors.`
    : `CHUNK CONTEXT
The reference is a short chunk of a longer dance, not a complete routine. The actual choreography to grade against is between ${referenceChunkStartSec.toFixed(2)}s and ${referenceChunkEndSec.toFixed(2)}s of the reference video. Anything before or after is padding — the dancer settling in or recovering. IGNORE THE PADDING.

The attempt video may be longer than the choreography window — the user has natural lead-in (preparing to dance) and lead-out (finishing, walking back to camera). IGNORE THOSE TOO. Score only the user's attempt to perform the choreography in the reference window. DO NOT report trouble spots past the end of the reference choreography.

WHAT COUNTS AS THE DANCE
The dance is the deliberate, repeatable choreography — the hits, the arm patterns, the steps, the body movements that are clearly choreographed.

IGNORE incidental motion in the reference:
- The dancer walking into frame or pressing play
- Casual swaying while the music starts
- Drifting toward or away from the camera between moves
- Settling into position or relaxing after the final hit
- Natural body micro-movements between choreographed counts
These are setup and recovery, NOT choreography. Do NOT penalize the user for not replicating them.`;

  // SPECK round-3 §Group-4: legs schema is now nullable. Upper-body framing
  // returns null and the downstream `displayedOverall` excludes legs from
  // the mean — DO NOT default legs to 75 to "be kind"; that lies on the bar.
  const legsClause = legsVisible
    ? 'LEGS: The user has their legs in frame. Score the legs component normally as part of the choreography.'
    : 'LEGS: The user is filming UPPER BODY ONLY — legs are not in frame. This is a framing choice, not a performance error. Set the legs component to null. Do NOT include leg-related trouble spots. Focus your trouble spots on arms, body, and timing.';

  return `You are a supportive dance teacher grading a student's attempt at a SINGLE CHUNK of a TikTok dance. Your job is to help the student improve, not to nitpick. Lead with what worked, then constructively note what to improve.

VIDEOS
You will receive two videos in order: REFERENCE, then ATTEMPT.
${orientationClause}

${framingClause}

PERSONAL STYLE IS NOT AN ERROR
The user may execute the choreography with their own angle, energy, or flourish. If the core move is recognizable, that is SUCCESS. Score down only for missing or incorrect choreography — not for stylistic variation. Smaller motion executed correctly beats bigger motion executed incorrectly.

${legsClause}

STEP 1 — DECIDE is_actually_dancing (CANARY)
The attempt is NOT a dance attempt if ANY of the following are true:
  (a) the body is mostly still relative to the camera (postural sway only),
  (b) the limb motion is fast but uncorrelated with the reference — the user is flailing, not copying,
  (c) the user is out of frame for more than 30% of the chunk.

If ANY of (a)/(b)/(c) holds:
- Set is_actually_dancing: false.
- Set overall_score to a value between 5 and 25.
- Components must reflect what was actually observed. For example: flailing arms might score arms: 15 because there IS arm motion (just wrong); standing-still body should score body: 5. Do NOT pad components upward to make the result feel kinder.

If NONE of (a)/(b)/(c) holds, the user is sincerely attempting the choreography. Set is_actually_dancing: true and continue to Step 2.

STEP 2 — SINCERE-ATTEMPT FLOOR
If is_actually_dancing: true:
- No individual component score may be below 35 unless the attempt genuinely shows zero effort on that axis. A sincere user who tried timing but missed it scores timing: 35-50, not timing: 10.
- Score each component 0–100 based on what you observed. Be specific: 50 = recognizable but rough. 70 = solid execution. 85+ = nailed.

SEVERITY CALIBRATION
Trouble spots have severity levels. Use them PROPORTIONATELY. Most issues should be MINOR. MAJOR should be rare.

- **MAJOR:** The user completely skipped a move or did a totally different move in its place. Reserved for big, obvious failures.
- **MODERATE:** The user did the move but with the wrong direction, wrong arm, or 1+ beats off the music.
- **MINOR:** The move is recognizable but execution wasn't crisp — slightly off angle, slightly small, slightly delayed.

If you're tempted to call something MAJOR but it's just "not quite right," it's MINOR. If you're tempted to call something MODERATE but the user clearly attempted it and got close, it's MINOR.

HAND AND FINGER DETAILS ARE MINOR
Exact hand shapes, finger configurations, and hand-signal gestures (rock-on, finger guns, peace signs, specific finger curls) are MINOR at worst. Most students will not replicate these exactly and that is fine. Only call out hand details if the user did a completely wrong motion (e.g., reference was hands up, user kept hands down) — and even then, it's MINOR.

EXECUTION QUALITY IS MINOR
Trouble spots about "extension," "crispness," "sharpness," "isolation," "fullness," or "energy of execution" are MINOR. Only escalate to MODERATE if the user did the wrong move entirely (wrong direction, wrong arm, wrong body part) — not if they did the right move with imperfect execution.

TROUBLE SPOT COUNT — CAPPED BY TIER
Match the trouble_spots array length to the user's result tier — DO NOT pad to fill.
- **tier: GROOVY:** at most 2 trouble spots. Often 0–1.
- **tier: SOLID:** at most 3 trouble spots.
- **tier: SHAKY:** at most 4 trouble spots.
- **tier: NOT_DANCING:** exactly 1 trouble spot — a single summary entry like "this didn't look like an attempt at the dance."

If a trouble spot is MINOR, ask yourself if it's worth including at all. Most MINOR issues should just be omitted.

INSIGHTS — TONE MATTERS, CONDITIONAL ON is_actually_dancing
The insights array must have 1–4 entries.

If is_actually_dancing: true:
- The FIRST insight MUST be a specific positive observation about what the user did well. Not generic ("good effort") — specific ("you nailed the arm extension on the second beat").
- Subsequent insights are constructive but PROPORTIONATE.

If is_actually_dancing: false:
- Do NOT pretend there was good work to praise. Do NOT lead with a fake compliment.
- Be honest and brief: one or two insights along the lines of "this didn't look like an attempt at the dance — watch the reference all the way through, then try again."

Across both branches, avoid these punitive adjectives unless the issue is truly extreme: "very," "significantly," "completely," "entirely," "totally," "barely," "not at all." Instead use proportionate language: "slightly," "a bit," "could be sharper," "try to extend a little more."

Insights should be ACTIONABLE — tell the user what to do differently, not just what was wrong.

OUTPUT
Return ONLY valid JSON matching the schema. No prose, no markdown, no commentary.`;
}
