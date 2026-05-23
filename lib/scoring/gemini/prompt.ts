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

// SPEC: score-restoration. The composite-video Gemini prompt, rewritten from
// scratch using SPECK.md (top of repo) as the source of truth. See
// `docs/score-restoration-investigation.md` for the picked-good-vs-fallback
// decision — short version: no historical commit emits the new five-field
// schema (score/tier/did_well/work_on/visibility_notes) or the new tier
// vocabulary (GROOVY/SOLID/ALMOST/WARMING_UP/JUST_STARTED), so this prompt
// is written from scratch following the spec's section ordering and embeds
// the calibration anchors + JSON schema worked examples verbatim.
//
// Section order:
//   a. Side-by-side framing (opening lines)
//   b. What to compare / what to ignore
//   c. Pre-trimmed alignment note (replaces the old motion-onset clause —
//      SPEC: score-restoration §Change 2, the composite is now pre-trimmed
//      on both halves so Gemini grades the entire video)
//   d. Partial visibility handling
//   e. Calibration anchors (verbatim from spec)
//   f. Philosophical framing (penultimate paragraph)
//   g. Response schema with worked examples (final lines)
//
// `motionOnsetSec` is accepted for backwards-compat but unused — the prompt
// no longer mentions motion onset.
export function buildCompositePrompt(args: {
  legsVisible: boolean;
  mirror: boolean;
  motionOnsetSec?: number;
}): string {
  const { legsVisible, mirror } = args;

  // Mirror-orientation note slotted into section (b). The spec is silent on
  // mirror handling, but the composite renderer can pre-flip the LEFT half
  // and Gemini needs to know which orientation it is looking at.
  const mirrorNote = mirror
    ? "The LEFT half has been horizontally mirrored to match the RIGHT half's selfie-camera orientation, so left and right body parts in both halves correspond DIRECTLY (when the LEFT shows a left arm raised, the RIGHT should also show a left arm raised)."
    : "The LEFT half is in source orientation; the RIGHT half is mirrored by the selfie camera. Grade as a mirror copy — when the LEFT shows the reference dancer's left arm raised, the RIGHT raising its right arm is CORRECT.";

  // Partial visibility paragraph (section d) leans on the legsVisible signal
  // we already detected client-side. When legs are out of frame, gently prime
  // Gemini to use the visibility_notes field instead of zeroing the score.
  const visibilityHint = legsVisible
    ? "The user appears to be filming with their full body in frame."
    : "The user appears to be filming UPPER BODY ONLY — legs are likely not visible. Note this in visibility_notes; do NOT penalize for the missing legs.";

  return `(a) SIDE-BY-SIDE FRAMING
You are watching a side-by-side comparison video. The LEFT half is the reference dancer — this is the ground truth, the correct way to do the dance. The RIGHT half is a user attempting to replicate the reference dancer's moves. Your job is to score how well the user (right) matches the reference (left). You are NOT judging the user as a dancer in absolute terms — you are measuring how closely their movements track the reference's movements. Compare them move by move, beat by beat.

(b) WHAT TO COMPARE AND WHAT TO IGNORE
Compare these things: timing on the beat, direction of weight transfer (left/right), arm position and arm timing, body lean, head movement, when major moves start and end. Do NOT score based on: facial expression, outfit, lighting, background, video quality, the user's attractiveness, or anything that is not about matching the choreography.

${mirrorNote}

(c) PRE-TRIMMED ALIGNMENT
Grade the entire user video against the entire reference video. Both have been pre-trimmed to align with each other.

(d) PARTIAL VISIBILITY
If part of the user's body is out of frame (commonly legs), grade only the body parts you can see. Note the visibility limitation in the visibility_notes field. Do NOT score out-of-frame body parts as zero or as a penalty — simply exclude them from scoring. ${visibilityHint}

(e) CALIBRATION ANCHORS
Tier the user's performance using these definitions. Match what you saw on the RIGHT half to the closest tier and emit the integer score from the corresponding range:

- **90-100 (GROOVY):** User matches the reference's movements with precise timing and clean execution. Body parts move in the same directions as the reference, on the same beats, with similar amplitude. Minor imperfections allowed.
- **75-89 (SOLID):** User is clearly doing the same dance. Most moves land on the beat, body parts move in roughly the same directions as the reference, but timing is sometimes off or amplitude is reduced. This is what a sincere first-time attempt by a non-dancer should look like.
- **60-74 (ALMOST):** User is attempting the choreography but missing significant beats or moves. The overall shape of the dance is recognizable but execution is loose.
- **40-59 (WARMING UP):** User is moving to the music but not really doing the reference choreography. Movements are present but not aligned with the reference's directions or timing.
- **Below 40 (JUST STARTED):** User is standing still, barely moving, flailing randomly, or doing something completely unrelated to the reference.

The tier field MUST be one of: GROOVY, SOLID, ALMOST, WARMING_UP, JUST_STARTED (use the underscored form WARMING_UP and JUST_STARTED in the JSON, even though the human label has a space).

(f) PHILOSOPHICAL FRAMING
Remember: the user is being measured on similarity to a professional reference, not on absolute dance skill. A non-dancer roughly on tempo and moving in the right directions is doing exactly what this product is designed to teach. They should feel rewarded. Be honest, but be kind.

did_well MUST cite a specific body part or beat the user actually got. work_on MUST cite a specific body part or beat AND be something drillable in roughly 90 seconds (a single isolated move or body part the user could practice in front of a mirror). Avoid vague guidance like "be more expressive" or "keep practicing."

(g) RESPONSE SCHEMA
Return ONLY valid JSON matching this exact shape. No markdown fences, no prose preamble, no commentary:

\`\`\`json
{
  "score": <integer 0-100>,
  "tier": "GROOVY" | "SOLID" | "ALMOST" | "WARMING_UP" | "JUST_STARTED",
  "did_well": "<one sentence citing a specific body part or beat>",
  "work_on": "<one sentence citing a specific body part or beat, drillable in 90 seconds>",
  "visibility_notes": "<empty string if user is fully in frame, otherwise note what was not visible>"
}
\`\`\`

Example of a good response for a sincere attempt:

\`\`\`json
{
  "score": 78,
  "tier": "SOLID",
  "did_well": "Your weight transfer on beats 1 and 3 matched the reference cleanly, especially the left-to-right hip shift.",
  "work_on": "Your arms stayed too low on the chorus hits — try drilling just the arm raise on counts 5-6 in front of a mirror.",
  "visibility_notes": ""
}
\`\`\`

Example of a good response for a sincere attempt with partial frame:

\`\`\`json
{
  "score": 72,
  "tier": "SOLID",
  "did_well": "Your upper-body bounce was on tempo throughout, matching the reference's rhythm well.",
  "work_on": "The chest isolation on beat 4 was understated — drill chest-forward, chest-back to a metronome at the song's tempo.",
  "visibility_notes": "Legs were not visible in frame, so footwork was not scored."
}
\`\`\``;
}
