# /goal: Rebuild the Mode B scoring system into a real learning loop

## Context

Mode B (the test/scoring mode) is in `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx`. As of the last few commits (most recently 66e8296), Mode B loads, runs end-to-end, and produces a numeric score with retry/back-to-copy-along/back-to-lessons buttons. **It does not crash. The infrastructure works.** Do not rebuild the page lifecycle, runState machine, camera attach, PoseExtractor init, or the StartOverlay countdown — those are debugged and stable.

What does NOT work: the score itself is wildly off. User danced a chunk competently (reasonable timing, similar shape to reference, no obvious flubs) and scored 18/100. Threshold for pass is 70. Either the scoring math is broken, or it's calibrated for a non-existent superhuman dancer, or both.

The user wants this rebuilt as a real learning loop, not just a number. The score is a means to an end — the end is teaching the user to dance better. You have ~10 hours of runtime. Do not stop until the goal is met. If you finish early, keep tightening; do not declare done until every acceptance criterion below is verified.

## Mandatory order of operations

You MUST work in this order. Do not skip steps. Do not start coding stage 2 before stage 1 is verified.

### STAGE 1 — Diagnose what's currently broken (30-60 min)

Before any rewriting. Investigate, do not assume:

1. **Find the scoring pipeline end-to-end.** Trace from raw camera frame → PoseExtractor output → coordinate transformation (if any) → reference-pose comparison → DTW or whatever similarity metric is used → final 0-100 score. Write down every file and line range involved. Put this trace in a markdown doc at `/docs/scoring-trace.md`.

2. **Verify the user's pose stream is being captured correctly.** Look at PoseExtractor. What does it output? 17 joints in what coordinate space? Per frame or smoothed? Are confidence scores being used to filter low-confidence joints?

3. **Verify the reference pose stream exists and is correctly formatted.** Where does it come from? Is it pre-computed and stored, or computed live from the reference video? Same coordinate space as the user stream?

4. **Check for the four known killer bugs in pose-comparison scoring:**
   - **Mirror flip.** When a user faces the camera and copies a dancer who is also facing the camera, the user's left hand is on the same screen-side as the dancer's right hand. If the comparison is left-to-left literally (instead of mirror-flipped), every dance scores terribly even when copied correctly. Test: is there a mirror flip anywhere in the pipeline? Is it correct?
   - **Coordinate normalization.** If the user is at distance D1 from the camera and the reference was filmed at distance D2, absolute joint coordinates won't match even for identical poses. Need to normalize to a canonical body — typically: translate so hip-midpoint is origin, scale so shoulder-to-hip distance = 1.0. Is this happening? Is it being done for both streams?
   - **Angle vs position.** Comparing absolute joint positions is fragile (camera angle, body size, framing all affect it). Comparing joint angles (e.g., elbow angle = angle between upper arm and forearm) is robust because angles are invariant to scale, position, and most rotations. Is the current scoring position-based or angle-based?
   - **Threshold calibration.** Even if the math is right, the conversion from raw DTW distance to a 0-100 score has a scaling parameter that has to be tuned against real human performance. What's the current formula? What dataset (if any) was it calibrated against?

5. **Write a diagnostic report at `/docs/scoring-diagnosis.md`.** Format:
   - What works in the current scoring pipeline
   - What's broken or missing (with file:line references)
   - Severity of each (correctness bug vs tuning vs missing feature)
   - Rebuild scope estimate: rebuild from scratch, partial rewrite, or just tuning?

**Commit this diagnostic doc before you write any new scoring code.** This is non-negotiable. The user wants to see the diagnosis, not just the fix.

### STAGE 2 — Add the dual-skeleton debug/learning overlay (1-2 hours)

This is BOTH a debugging tool AND a user-facing teaching feature. Build it early because Stage 3 (scoring) needs it for verification.

Build a real-time overlay that shows BOTH skeletons during Mode B:
- The reference skeleton (extracted from the reference video, played in sync with the audio)
- The user's skeleton (extracted live from the camera feed)

Both rendered in the same coordinate space (after normalization). Use different colors — reference in white, user in coral (the brand color). Render each as 17 joints connected by lines.

Position: behind the score readout but above the camera feed. The user should be able to look down at their phone and see both skeletons dancing — reference doing the move, theirs trailing or leading slightly.

**This overlay serves three purposes:**
1. **Debugging.** If the user's skeleton looks broken (pretzel arms, missing joints, jitter), pose detection is the problem. If both skeletons look anatomically correct but don't line up when the user is dancing well, normalization is the problem. If they line up but the score is bad, the comparison math is the problem.
2. **Learning.** The user can SEE where their movements diverge from the reference in real time. That is itself teaching.
3. **Trust.** When the user gets a score, they trust it more because they could see what was being compared.

Add a toggle to show/hide the overlay (default ON during development, default OFF for end users — but expose a settings flag to flip it).

### STAGE 3 — Rebuild the scoring math (2-4 hours)

Based on Stage 1 diagnosis. The expected fixes, in order of likely importance:

1. **Mirror the reference pose horizontally** before comparison. Test by dancing with the user and reference shown side by side — the user's right hand should align to the reference's right hand on screen (which is the dancer's left hand in their own body frame).

2. **Normalize both pose streams to a canonical body frame** before comparison. Translate to hip-midpoint origin, scale to shoulder-width = 1.0. Apply to every frame in both streams.

3. **Use joint angles, not just positions, in the similarity metric.** For each frame, compute the 8 most informative joint angles (elbows, shoulders, hips, knees) and use those as the primary comparison surface. Position is a secondary signal. Joint-angle comparison should be the dominant component of the score.

4. **Weight joints by movement importance for this specific chunk.** If the chunk's defining moves are arm-heavy (e.g., a hand-jive), wrists/elbows/shoulders should weigh more than knees. If it's body-heavy (a body roll), the opposite. For a first pass, you can compute weights automatically: the joints that move the most in the reference are the most important to score on. A joint that's stationary in the reference contributes near-zero weight.

5. **Use DTW with a constrained warping window.** Allow ~200ms of timing slack but not more. Too much warping rewards lazy timing.

6. **Calibrate the 0-100 mapping.** After the math is right, the raw DTW distance still needs to map to a number a human can interpret. Do this empirically: 
   - Score a "perfect" performance (the reference dancer compared to themselves, with tiny synthetic noise added): should be 95+.
   - Score a "no movement" performance (user stands still): should be <20.
   - Score a "decent" performance (the user's actual recordings from testing): should land 60-85 depending on how cleanly they performed.
   - Adjust the mapping function until those three calibration points hit those ranges.

### STAGE 4 — Build the closed learning loop (3-4 hours)

This is what makes the product more than a scoring app. The score isn't the end — what the user does NEXT with the score is the product.

**Per-joint, per-section breakdown on the results screen.**

When a chunk ends, the results screen shows:
1. **Overall score** (big, prominent, but not the only thing on screen anymore).
2. **Component scores** — Arms / Legs / Timing / Body — each as a sub-score. This lets the user see WHERE they failed, not just THAT they failed.
3. **Timeline of trouble spots** — the 2-3 moments in the chunk where the user diverged most from the reference. Each one shows: timestamp ("at 0:04"), what went wrong ("right arm 30° off"), and a button to practice that 2-second moment specifically.
4. **A targeted practice recommendation.** "Your arms were the weakest. Want to drill the arm sequence at half speed?" — this links into Mode A with the reference video set to start at the worst moment, slowed down. This is the closed loop. The score isn't just a number; it routes the user to a fix.

**Targeted drill mode.** When the user taps a trouble-spot timestamp, take them into a focused practice loop:
- Play that 2-second clip of the reference, looped, at 50% speed.
- Show the reference skeleton clearly.
- After 3 loops, speed up to 75%.
- After 3 more, 100%.
- Then send them back to Mode B to retest just that section.

This drill mode should reuse existing Mode A components where possible. Don't build it as a separate page — extend the existing copy-along page to accept `?from=ms&to=ms&loop=true&speed=0.5` URL params.

### STAGE 5 — Redesign the results screen (1-2 hours)

The current screen says "ALMOST THERE" with a red 18 and "threshold 70." This is broken in three ways:
1. The encouragement message ("ALMOST THERE") doesn't match a score that's 52 points below threshold.
2. "Threshold 70" is dev language, not user language.
3. The score is the only thing on the page — no breakdown, no actionable next step.

New results screen design requirements:
- **Headline copy adapts to the score:** ≥85 = "Nailed it." 70-84 = "You got it." 50-69 = "Getting there." <50 = "Keep practicing." No more "almost there" at 18.
- **Score color adapts:** green ≥70, amber 50-69, red <50.
- **Component breakdown** (Arms / Legs / Timing / Body) shown as four small bars or rings under the main score.
- **Trouble-spot list** with 2-3 timestamped moments and tappable practice buttons.
- **Primary CTA: "Drill the worst part"** — direct route into the targeted drill mode at the lowest-scoring moment.
- **Secondary CTAs:** Try again (full retry) and Back to lesson.
- **Drop "threshold 70"** entirely. If you want to show pass/fail, do it with the color and the headline.

### STAGE 6 — Verification and tuning (1 hour)

Verify each of these holds before declaring done:

1. **Skeleton accuracy.** Run Mode B. Look at the dual-skeleton overlay. Does the user skeleton track the user's actual body? Are joints in roughly the right places, not flickering, not pretzel-shaped?
2. **Score sanity.** Test three scenarios manually:
   - Stand still through the whole chunk → score <25.
   - Wave arms randomly through the whole chunk → score <40.
   - Actually attempt the dance reasonably → score 55-80 depending on quality.
   If any of these are off, tune the calibration mapping in Stage 3 step 6. Iterate.
3. **Mirror correctness.** Visually verify in the overlay: when the reference dancer raises their LEFT hand (from their POV, which appears on the RIGHT side of the screen), the user mirrors by raising their right hand (from the user's POV, which also appears on the right side of their phone). Both right hands on screen, both up. If they're on opposite sides, mirror logic is wrong.
4. **Component scores are informative.** If a user does the arm moves correctly but messes up the legs, Arms score should be much higher than Legs score. Test this by deliberately doing one well and one badly.
5. **Trouble-spot identification.** If a user deliberately freezes for 1 second mid-chunk, that frozen second should appear as a trouble spot.
6. **Drill mode loop.** Tap a trouble spot. Verify: it routes to Mode A, starts at the right timestamp, plays the right 2-second window, loops, speeds up after 3 reps.
7. **Results screen copy matches score.** Score 90 → "Nailed it." Score 18 → "Keep practicing," NOT "Almost there."

### STAGE 7 — Document what you built

Write a final summary at `/docs/scoring-rebuild-summary.md`:
- What the diagnostic found
- What was rebuilt vs kept
- The math of the new scoring (key formulas, weights, thresholds)
- How calibration was done
- Known limitations and next steps

## Hard rules

- **Do not stop until every Stage 6 acceptance criterion verifies.** If something fails, fix it and re-verify.
- **Do not touch:** Mode A (copy/page.tsx and friends), the dance library, the framing-callout on the setup screen, the StartOverlay component, the lifecycle effects we just debugged (lines 380-388 of test/page.tsx and the audio re-render guards we just put in place). If you must touch them, justify it in your commit message.
- **Commit often.** Each stage should produce at least one commit. The user will wake up and read commit history to understand what you did.
- **Do not silently revert previous fixes.** Specifically: do not re-add framing gates, do not put `audio` back into effect deps, do not undo the volume-effect or cleanup-effect deps we just fixed.
- **Performance matters.** Mode B runs on phones. The pose pipeline + scoring + dual-skeleton overlay all running 30fps on an iPhone is the bar. If you build something that drops below 24fps on a recent iPhone, profile and fix before declaring done.
- **No new dependencies without justification.** We're on Vercel, build size matters. If you need to add a library, comment why in the commit.
- **The dual-skeleton overlay must be functional even if the scoring isn't perfect.** That is, even if Stage 3 doesn't fully land, Stage 2 alone is a major product improvement — the user can SEE what the system sees. So land Stage 2 first and commit it, even if you're still working through Stage 3.

## When you're done

Final commit message should include:
- "Mode B scoring rebuild complete"
- List of files touched
- The three calibration test scores (stand still, random arms, real attempt)
- Confirmation that all 7 Stage 6 acceptance criteria pass

If you hit a wall on something you can't resolve (e.g., the pose detection model itself is fundamentally inaccurate and you can't fix it), DO NOT silently ship a half-fix. Commit the partial work, write up the blocker in `/docs/scoring-rebuild-summary.md`, and stop. The user will read it in the morning and decide what to do.

Now go.