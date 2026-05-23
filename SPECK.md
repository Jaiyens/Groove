# spec.md

# Score restoration + tone fix + side-by-side framing

## The problem

The Gemini scoring pipeline has drifted away from a known-good state.
The user remembers a version (~1-2 days ago in git history) where:

- A sincere ~7s attempt would score around 81
- The response included "what you did well" and "what you could improve"
- The grading felt like coaching, not judgment
- It didn't penalize the user for walking back from the camera at the
  start of the clip

The current version:

- Is brutally strict — sincere attempts score very low or fall back to
  MediaPipe because Gemini times out
- Returns less qualitative feedback than the older version
- Grades the entire clip including the camera-walk-back at the start,
  which tanks the score before the user even moves to the music
- Has a 40000ms timeout budget that is too tight; the timeout fires
  before Gemini responds on composite-bytes payloads
- May not be explicitly telling Gemini that the video it receives is a
  side-by-side comparison (reference dancer on left, user attempt on
  right). Without this framing, Gemini cannot do the job it's being
  asked to do — it has to be told what it's looking at and what to
  compare.

The goal is NOT to make scoring lenient for its own sake. The goal is
to make scoring reflect *dancing effort relative to the reference* —
measured by comparing the user's body movements (right half of the
composite frame) to the reference dancer's body movements (left half of
the composite frame), from motion onset onward, with a tier
distribution that rewards sincere attempts and honestly grades flailing
ones.

## Philosophical anchor (read this before touching the prompt)

The user is being graded on *similarity to a professional reference
dancer*, not on *absolute dance ability*. A non-dancer who is roughly
on tempo and moving their body in the same directions as the reference
is doing the thing the product is designed to teach. They should feel
rewarded. A user who stood still or flailed randomly should score low.
The score's job is to encourage continued attempts while being honest
enough that improvement feels real. This is the same philosophy as
Duolingo's XP system: generous enough to keep you coming back, honest
enough that you can tell when you're actually getting better.

This anchor is the reason the thresholds in this spec are more
generous than the current production thresholds. It is not "score
inflation." It is "scoring the right thing."

## Non-negotiables

- The Gemini prompt MUST explicitly frame the input as a side-by-side
  comparison video: LEFT = reference (ground truth), RIGHT = user
  (attempt). Gemini's job is to compare right against left.
- The Gemini prompt MUST explicitly tell Gemini which body parts and
  movements to compare: timing on the beat, direction of weight
  transfer, arm position, body lean, head movement. NOT facial
  expression. NOT outfit. NOT background. NOT video quality.
- The walk-back-from-camera at the start of the user's clip MUST NOT
  count against the score. Motion onset is already detected; the
  prompt must reference it by value ("the user's first real movement
  is at 0.16s — ignore everything before that").
- The Gemini response MUST be valid JSON in a fixed schema (see
  Response Schema section below). No prose preamble, no markdown
  fences.
- The Gemini response MUST include qualitative feedback referencing
  specific body parts or beats, not generic encouragement.
- The qualitative "what to work on" feedback MUST be actionable in a
  ~90-second drill (i.e. a specific move or body part the user could
  practice in isolation), not a vague suggestion like "be more
  expressive."
- If the user's body is partially out of frame (e.g. legs not
  visible), Gemini MUST grade what it can see and explicitly note the
  visibility limitation in the response. It MUST NOT score
  out-of-frame body parts as zero.
- A genuinely-attempted ~7s performance where the user is roughly on
  tempo and moving their body in the right directions even if
  imprecise SHOULD land in the 70-85 range.
- A user standing still or doing nothing SHOULD score below 40.
- A user nailing the choreography SHOULD be able to hit 90+.
- The Gemini timeout budget MUST be raised to at least 90000ms.

## Calibration anchors (give these to Gemini in the prompt)

Tell Gemini explicitly what each score range means, so its internal
calibration doesn't drift:

- **90-100 (GROOVY):** User matches the reference's movements with
  precise timing and clean execution. Body parts move in the same
  directions as the reference, on the same beats, with similar
  amplitude. Minor imperfections allowed.
- **75-89 (SOLID):** User is clearly doing the same dance. Most moves
  land on the beat, body parts move in roughly the same directions as
  the reference, but timing is sometimes off or amplitude is reduced.
  This is what a sincere first-time attempt by a non-dancer should
  look like.
- **60-74 (ALMOST):** User is attempting the choreography but missing
  significant beats or moves. The overall shape of the dance is
  recognizable but execution is loose.
- **40-59 (WARMING UP):** User is moving to the music but not really
  doing the reference choreography. Movements are present but not
  aligned with the reference's directions or timing.
- **Below 40 (JUST STARTED):** User is standing still, barely moving,
  flailing randomly, or doing something completely unrelated to the
  reference.

## Response Schema (REQUIRED)

Gemini MUST return JSON matching this exact shape. No markdown fences,
no prose preamble:

```json
{
  "score": <integer 0-100>,
  "tier": "GROOVY" | "SOLID" | "ALMOST" | "WARMING_UP" | "JUST_STARTED",
  "did_well": "<one sentence citing a specific body part or beat>",
  "work_on": "<one sentence citing a specific body part or beat, drillable in 90 seconds>",
  "visibility_notes": "<empty string if user is fully in frame, otherwise note what was not visible>"
}
```

Example of a good response for a sincere attempt:

```json
{
  "score": 78,
  "tier": "SOLID",
  "did_well": "Your weight transfer on beats 1 and 3 matched the reference cleanly, especially the left-to-right hip shift.",
  "work_on": "Your arms stayed too low on the chorus hits — try drilling just the arm raise on counts 5-6 in front of a mirror.",
  "visibility_notes": ""
}
```

Example of a good response for a sincere attempt with partial frame:

```json
{
  "score": 72,
  "tier": "SOLID",
  "did_well": "Your upper-body bounce was on tempo throughout, matching the reference's rhythm well.",
  "work_on": "The chest isolation on beat 4 was understated — drill chest-forward, chest-back to a metronome at the song's tempo.",
  "visibility_notes": "Legs were not visible in frame, so footwork was not scored."
}
```

## Investigation phase (do this BEFORE writing any code)

1. Run `git log --oneline -- lib/scoring/gemini/client.ts` and identify
   the last 15 commits that touched the scoring prompt or tier
   thresholds. Write the list to
   `docs/score-restoration-investigation.md`.
2. For each commit that changed the prompt text, the system
   instructions, the tier thresholds, or the scoring rubric, run
   `git show <sha> -- lib/scoring/gemini/client.ts` and extract the
   prompt as it existed at that commit. Save each version as
   `docs/score-prompt-history/v{N}-{sha}.txt` with a header comment
   noting the commit date and message.
3. Identify the commit where the user's "81 felt right" version most
   likely lived. Heuristics for picking it:
   - Tier thresholds were more generous (closer to the calibration
     anchors above)
   - The prompt explicitly framed the input as a side-by-side
     comparison
   - The prompt asked for qualitative feedback
   - The prompt referenced motion onset
   - The prompt was framed as coaching rather than judging
   Note your pick in the investigation doc with reasoning.
4. Diff the picked-good prompt against the current production prompt.
   List every substantive change in the investigation doc. For each
   change, note whether it likely contributed to the regression.
5. **Fallback:** If no clearly-good commit emerges from history
   (because the picked-good version never quite matched all
   heuristics, or because the user's memory is approximate), write a
   prompt from scratch using this spec as the source of truth. Note
   in the investigation doc that you took the fallback path.
6. STOP. Do not proceed to implementation until the investigation doc
   exists and lists either a baseline commit OR an explicit decision
   to write from scratch.

## Implementation phase

After investigation, in a single commit on a new branch
`score-restoration`:

1. Write the prompt with these sections, in order:
   a. **Side-by-side framing (opening lines):**
      "You are watching a side-by-side comparison video. The LEFT half
      is the reference dancer — this is the ground truth, the correct
      way to do the dance. The RIGHT half is a user attempting to
      replicate the reference dancer's moves. Your job is to score how
      well the user (right) matches the reference (left). You are NOT
      judging the user as a dancer in absolute terms — you are
      measuring how closely their movements track the reference's
      movements. Compare them move by move, beat by beat."

   b. **What to compare and what to ignore:**
      "Compare these things: timing on the beat, direction of weight
      transfer (left/right), arm position and arm timing, body lean,
      head movement, when major moves start and end. Do NOT score
      based on: facial expression, outfit, lighting, background, video
      quality, the user's attractiveness, or anything that is not
      about matching the choreography."

   c. **Motion onset instruction:**
      "The user's first frame of real dance movement is at
      {motionOnsetSec}s. Ignore everything in the user's video before
      that timestamp — they are walking back from the camera or
      preparing. Begin grading from {motionOnsetSec}s onward. If you
      see the user clearly still preparing or adjusting themselves
      after that timestamp, use your judgment and begin grading at
      the first beat-aligned dance move you see."

   d. **Partial visibility handling:**
      "If part of the user's body is out of frame (commonly legs),
      grade only the body parts you can see. Note the visibility
      limitation in the visibility_notes field. Do NOT score
      out-of-frame body parts as zero or as a penalty — simply
      exclude them from scoring."

   e. **Calibration anchors:** (include the 5 tier descriptions from
      the Calibration Anchors section above, verbatim)

   f. **Philosophical framing (penultimate paragraph):**
      "Remember: the user is being measured on similarity to a
      professional reference, not on absolute dance skill. A
      non-dancer roughly on tempo and moving in the right directions
      is doing exactly what this product is designed to teach. They
      should feel rewarded. Be honest, but be kind."

   g. **Response schema (final lines):** (include the JSON schema
      above, verbatim, with the example responses)

2. Bump the Gemini timeout from 40000ms to 90000ms in the relevant
   client call.

3. Add a console log immediately before the Gemini API call printing
   the full prompt being sent, prefixed with `[gemini-prompt]`. This
   is so the user can see in the browser console exactly what Gemini
   is being asked. Keep this log in for now; remove it later.

4. Add a console log immediately after the Gemini response is received
   printing the full raw response, prefixed with `[gemini-response]`.

5. Ensure the deterministic post-processing layer (`buildFinalScoreView`
   or equivalent) handles the new JSON schema correctly. If the schema
   keys changed from the previous version, update the consumer to
   match.

## What NOT to touch

- The motion onset detection logic in `client.ts` lines 265-389. It is
  working correctly per yesterday's logs.
- The composite generation in `composite.ts`. It is working correctly
  per yesterday's logs (`[composite] success` fires). The side-by-side
  video itself is fine — the problem is that the prompt doesn't tell
  Gemini that's what it's looking at.
- The MediaPipe fallback path. We want Gemini to succeed, not to
  remove the fallback.
- The debug capture infrastructure from the previous overnight run.
- Any UI code.

## Validation

After implementation, the user will run a sincere ~7-second attempt
with the browser console open. The expected log sequence:

```
[gemini-prompt] <full prompt — must contain the side-by-side framing,
                 the motion onset value, the body-parts list, the
                 calibration anchors, and the JSON schema>
[gemini-client] sending composite {...}
[gemini-response] <full raw JSON matching the schema exactly>
```

**Validation checks:**
- Expected score for a sincere attempt: 70-85.
- Response must be parseable JSON (no markdown fences, no preamble).
- `did_well` must cite a specific body part or beat.
- `work_on` must cite a specific body part or beat and be drillable
  in 90 seconds.
- If the user was partially out of frame, `visibility_notes` must
  explain what wasn't scored.

**Failure modes to report:**
- Score below 60 on a sincere attempt → prompt restoration is
  incomplete, calibration anchors not landing.
- Score above 95 on a flailing attempt → thresholds too lenient OR
  Gemini is ignoring the calibration anchors.
- Gemini's response does not reference the side-by-side structure
  (e.g. comparing left to right, comparing reference to user) → the
  framing is not landing, strengthen it.
- Response is not valid JSON → the schema instruction needs to be
  more forceful, or move it to the system instruction.
- `work_on` is generic ("keep practicing", "be more expressive") →
  the actionable-in-90-seconds constraint needs to be more explicit.

Report all failures with the [gemini-prompt] and [gemini-response]
logs from the failed run.

## Deliverables

- `docs/score-restoration-investigation.md` (created in investigation
  phase)
- `docs/score-prompt-history/v{N}-{sha}.txt` files (created in
  investigation phase)
- A single commit on branch `score-restoration` implementing the
  changes
- A status doc at `docs/score-restoration-status.md` summarizing what
  changed, what the picked-good baseline commit was (or whether the
  fallback "write from scratch" path was taken), what was modified vs.
  that baseline, and what to watch for during validation