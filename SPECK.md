# SPEC: Scoring round 3 — fix what validation surfaced

## Context — read this BEFORE you touch any file

Two prior PRs landed: `gemini-windowing-fix` (chunk-trimming reference video, leg-visibility branch, schema-locked prompt) and `gemini-generosity-and-ui` (prompt rewrite, callout UI redesign, callout diagnostic logging). Validation tonight on a real device, three attempts on the same chunk, surfaced five specific failures. This PR fixes them. The architecture stays — MediaPipe drives live callouts during the dance, Gemini drives the post-attempt verdict, MediaPipe falls back on Gemini failure. No structural changes.

**The five failures, with the actual data:**

1. **Sincere attempt (chunk 1/3):** Gemini raw 51, MediaPipe debug 33, displayed overall **81**. Components shown: arms 50, legs 75 (upper-body-only), body 35, timing 45 → arithmetic mean 51. The overall 81 does not match the component breakdown. A user looking at that screen cannot reconcile the number with the bars.

2. **Same attempt:** trouble spots reported at 0:00 and 0:02 — both inside the pre-roll padding where the dancer is walking back to the camera, not performing the choreography. The prompt has a padding-ignore clause; it is being ignored. The "Your body remained still throughout the dance" trouble spot spans 0:00–7:38, i.e. the entire chunk including padding.

3. **Same attempt — mirroring is broken at the model layer.** Mode A mirrors the reference video for the learner (transform: scaleX(-1) on the REF panel). The learner therefore practices a mirrored version of the dance. In Mode B, the user's attempt is captured from the front-facing camera, which is also mirrored. The reference video sent to Gemini is the **raw, unmirrored** source video. So Gemini compares: unmirrored reference vs mirrored attempt. The current prompt's "grade as a mirror copy" clause was correct for that pairing, but it does not help when the user learned the mirrored version and is replaying it — left/right correspondence between what the user learned and what Gemini scores is now inverted by one flip. Trouble spots citing "right hand thumbs-up gesture" when the user was copying what they saw as their own left hand are an artifact of this.

4. **Standing-still attempt:** Gemini fell back to MediaPipe (header reads "FALLBACK SCORING," score 44). Components: arms 19, legs 75 (upper-body-only), body 68, timing 0 → mean 41. Score of 44 for standing still is too high for a NOT_DANCING canary. Separate issue: the legs=75 default for upper-body-only is contributing to the overall as if legs were performed correctly, when in fact legs were not assessed. Upper-body-only mode should EXCLUDE legs from the overall, not impute 75 to it.

5. **Live callouts always read GROOVY**, third report in three rounds. The callout overlay is firing GROOVY on every accent beat regardless of similarity score. Either (a) the threshold check is being short-circuited, (b) the similarity stream feeding the engine is saturated, (c) the tier mapping is bypassed by a default, or (d) the diagnostic logging added in round 2 was never wired to console. Find the cause before changing anything.

6. **Flailing attempt scored 75 with the SOLID tier.** Gemini raw was 45, MediaPipe debug 16, displayed 75. The displayed score for random flailing should be below 40. This is the NOT_DANCING canary failing harder than it failed in round 2 (where flailing scored 50). The generosity rewrite over-corrected.

**Hard rules:**

1. Architecture unchanged. MediaPipe live, Gemini post-attempt, MediaPipe fallback.
2. All diagnostic logging from rounds 1 and 2 stays. Add to it.
3. Branch off whatever is current main (or the latest gemini-* branch if rounds 1 and 2 are not yet merged) into `scoring-round-3`. One commit per file group. Do not push to main.
4. Do not modify the chunk-windowing logic from round 1.
5. Mobile-first; verify at 390px.
6. **Do not "tune" thresholds blindly.** For the callout always-GROOVY bug specifically, instrument first, diagnose, then fix. If the diagnosis is "the similarity stream is saturated near 1.0 always," that is a scoring-layer bug, not a threshold-tuning problem, and you should stop and flag.

---

## File-by-file plan

Implementation order matters. Do them in this order. Pause for a diff summary after each file group.

---

### Group 1 — Mirror the reference video sent to Gemini

**Why first:** every other Gemini fix depends on the reference and attempt being in the same orientation. Without this, prompt tuning is fighting noise.

**MODIFIED: `lib/scoring/gemini/client.ts`**

Before sending the reference video as base64, mirror it horizontally to match the attempt's mirrored orientation. Two acceptable implementation paths — pick the simpler one that works:

- **Path A (preferred):** in the client-side trimming step (the FFmpeg.wasm or canvas-based path that already exists for windowing), apply a horizontal flip filter during the same pass. FFmpeg's `hflip` filter. For canvas-based trimming, draw the source video frame to canvas with `ctx.scale(-1, 1); ctx.drawImage(...)` per frame.
- **Path B (fallback):** if client-side flipping balloons CPU time on mobile to the point where the trim+flip takes longer than the dance itself, do the flip server-side in the API route using ffmpeg in a Node child process. Acceptable cost: +300ms of latency. Document the choice in `docs/scoring-decisions.md`.

Add a payload field `referenceMirrored: true` so the prompt can stop asking Gemini to imagine the mirror correspondence.

**MODIFIED: `lib/scoring/gemini/prompt.ts`**

Delete the "grade as a mirror copy" clause. Replace with:

> The REFERENCE video has been horizontally mirrored so that left/right correspond directly to the ATTEMPT video, which is captured from a front-facing camera. Grade left and right literally — when the reference's left arm goes up, the attempt's left arm should go up.

Update the existing prompt-invariants test (`tests/geminiPrompt.test.ts`) to assert the NEW clause exists and the old mirror-copy clause does NOT exist. Do not delete the test; rewrite the assertion.

**Acceptance:**
- A reference video that was previously sent with text "wave left arm" appears in Gemini's payload with the left/right physically swapped.
- Unit test: when called with a known reference video, the base64 of the reference payload differs from the base64 of the raw source.
- Trouble spots on a sincere attempt no longer reference the opposite hand.

---

### Group 2 — Fix the padding-ignore problem at the source

**Why second:** the prompt's padding-ignore clause is being ignored because the reference video Gemini sees STILL CONTAINS the walking-back-to-camera frames. Telling a model "ignore the first 2 seconds" while showing it those 2 seconds is asking it to override what it sees with what you said. Cut the padding instead of asking Gemini to imagine it isn't there.

**MODIFIED: `lib/scoring/gemini/client.ts`** (or wherever reference trimming lives)

Currently the reference is trimmed to the chunk window `[chunkStartSec, chunkEndSec]`. That window includes any pre-roll where the source dancer is establishing position before the choreography starts. Add a second trim step:

1. After the chunk window is applied, run a **lightweight motion-onset detection** on the trimmed reference: compute mean per-frame pixel-difference (downsampled to 64×64 grayscale for speed). The first frame where pixel-diff exceeds the rolling baseline by 3× is the "movement onset." Trim everything before that.
2. Mirror this trim on the attempt video using the **same time offset** so that t=0 in both videos corresponds to the same moment in the choreography.
3. Send to Gemini.
4. Add to the payload: `referenceMotionOnsetSec: <number>` and `attemptMotionOnsetSec: <number>` for diagnostic logging.

**MODIFIED: `lib/scoring/gemini/prompt.ts`**

Replace the existing "ignore padding" / "trouble spots bounded to attempt" clauses with a stronger version:

> Both videos start exactly at the moment of first dance movement. There is no pre-roll padding. All trouble spots must reference timestamps within the dance, not before it.

Update the prompt-invariants test.

**Acceptance:**
- Logged `referenceMotionOnsetSec` for the test chunk is > 0.0 (the dancer is walking back to camera for some time before dancing).
- Trouble spots no longer fire at 0:00 unless there is a genuine error at the actual first dance beat.
- Add an integration test with a fixture reference video that has 2s of dead air at the start: assert the trimmed reference duration is `originalDuration - ~2s`.

---

### Group 3 — Fix component/overall consistency on the results screen

**Why third:** even with the model behaving correctly, the results UI is currently lying to the user. Components average to 51 and the headline says 81.

**Decide first:** the discrepancy comes from a "boost" or "tier-floor" applied to Gemini's raw overall when computing the displayed overall, but the same boost is not applied to the components. There are two ways to make this honest:

- **Option A (chosen — implement this):** the displayed overall is computed as the arithmetic mean of the four components after their own per-component generosity boost. No separate boost is applied at the top level. This makes the breakdown the source of truth and the headline a derived value. The Gemini raw `overall_score` is retained internally and exposed only on the debug pill.
- **Option B (reject):** keep the top-level boost and proportionally boost each component to match. Rejected because it makes the components fictional.

**MODIFIED: `lib/scoring/displayScore.ts`** (or wherever the boost lives — search for `Gemini raw` in the codebase to find the logger that produced the debug pill text)

```typescript
function displayedOverall(gemini: GeminiScore, legsVisible: boolean): number {
  const c = gemini.components;
  if (legsVisible) {
    return Math.round((c.arms + c.legs + c.body + c.timing) / 4);
  }
  // Upper-body-only: legs excluded entirely
  return Math.round((c.arms + c.body + c.timing) / 3);
}
```

Apply per-component generosity boosts inside the Gemini prompt instead (Group 4) — not on top of the result.

**MODIFIED: `components/ResultsCard.tsx`** (or wherever the score header renders)

The headline number is now the output of `displayedOverall()`. The debug pill ("Gemini raw: X · MediaPipe (debug): Y") continues to show Gemini's raw `overall_score` and MediaPipe's score side-by-side; that's the diagnostic surface. The components below render unchanged.

**Acceptance:**
- For the sincere attempt's components (arms 50, legs 75, body 35, timing 45 — assuming Group 4 doesn't change them), the displayed overall is 51, not 81.
- For an upper-body-only attempt, the displayed overall excludes legs from the mean. The legs pill renders as "(UPPER BODY ONLY)" and shows a single dim dash (`—`), not "75."
- Add a unit test: `displayedOverall({arms:50, legs:75, body:35, timing:45}, true)` returns 51. `displayedOverall({arms:50, legs:75, body:35, timing:45}, false)` returns 43.

---

### Group 4 — Recalibrate Gemini's component scoring + canary

**Why fourth:** the prompt rewrite from round 2 was too soft on flailing (raw 45 for flailing vs raw 51 for a sincere attempt is a 6-point gap — that's noise, not signal). Tighten the canary, sharpen the components, kill the "default 75 for legs" anti-pattern.

**MODIFIED: `lib/scoring/gemini/prompt.ts`**

Rewrite the canary and component-grading sections. Keep the chunk-window awareness, keep the post-Group-1 mirror clause, keep the post-Group-2 motion-onset clause.

Specific changes:

1. **Canary is now binary AND quantitative.** Current language treats `is_actually_dancing: false` as a flag with no enforced score consequence. New language:

   > Step 1 — Decide `is_actually_dancing`. The attempt is NOT a dance attempt if any of the following are true: (a) the body is mostly still relative to the camera (postural sway only), (b) the limb motion is fast but uncorrelated with the reference (the user is flailing, not copying), (c) the user is out of frame for more than 30% of the chunk. If any of these are true, set `is_actually_dancing: false` AND set `overall_score` to a value between 5 and 25. Components in this case should reflect what was actually observed (e.g., flailing arms might score arms: 15 because there IS arm motion, just wrong; standing-still body should score body: 5). Do not pad components upward to make the result feel kinder.

2. **Sincere-attempt floor is also explicit.** If `is_actually_dancing: true`, no individual component score may be below 35 unless the attempt genuinely shows zero effort on that axis. The current arms=19 on the standing-still attempt is fine because `is_actually_dancing` was false. But a sincere attempt scoring arms=25 is the prompt being too punishing in a different way.

3. **Upper-body-only mode no longer fills `legs` with a default 75.** It returns `legs: null`. Update `GeminiScoreSchema` in `lib/scoring/gemini/types.ts` to accept `legs: z.number().min(0).max(100).nullable()`. The downstream `displayedOverall` from Group 3 already excludes legs in that branch. The UI from Group 3 renders the dim dash.

4. **Trouble-spot count is capped by tier.** GROOVY: max 2. SOLID: max 3. SHAKY: max 4. NOT_DANCING: max 1 ("this didn't look like an attempt at the dance"). Currently the system pads to 3 regardless.

5. **The first insight must be specific and positive — but only if `is_actually_dancing` is true.** If `is_actually_dancing: false`, the insights should not pretend there was good work to praise. Existing language conflated these.

**MODIFIED: `lib/scoring/gemini/types.ts`**

```typescript
components: z.object({
  arms: z.number().min(0).max(100),
  legs: z.number().min(0).max(100).nullable(),
  body: z.number().min(0).max(100),
  timing: z.number().min(0).max(100),
}),
```

**MODIFIED: `tests/geminiPrompt.test.ts`**

Add assertions for the new canary language, the floor, the cap-by-tier, the nullable legs, and the conditional-positive-insight clause.

**Acceptance (validation pass, not automated):**
- Sincere attempt: `is_actually_dancing: true`, components between 35 and 95, displayed overall 55–85.
- Standing still: `is_actually_dancing: false`, overall 5–25, body component low (under 20), arms low.
- Flailing: `is_actually_dancing: false`, overall 5–25. **This is the canary.** If flailing still scores above 40, the prompt is wrong and you stop and flag — do not tune around it.

---

### Group 5 — Diagnose the always-GROOVY live callout bug

**Why last:** the prior four groups change the post-attempt verdict, which is independent from the live callout engine. Save the diagnostic work for when the rest is stable.

This is a **diagnosis task first, fix task second.** Do not change thresholds before diagnosing.

**Step 1 — Verify the diagnostic logging from round 2 is actually wired.**

Open `lib/scoring/callouts/calloutEngine.ts`. There should be a `console.log("[callout]", ...)` or equivalent on every accent-beat fire. If there is not, that's where round 2 silently failed. Add it now:

```typescript
console.log('[callout]', {
  beatIndex,
  windowMaxSimilarity: maxSim,
  tier,
  thresholds: { groovy: T_GROOVY, perfect: T_PERFECT, great: T_GREAT, almost: T_ALMOST },
  timestamp: performance.now(),
});
```

**Step 2 — Run one sincere attempt with that logging on and copy the console output into `docs/callout-diagnosis-round-3.md`.**

Read the log. Three possible diagnoses, each with a different fix:

- **(A) The similarity stream is saturated near 1.0.** Every beat shows `windowMaxSimilarity: 0.99…`. → The fix is in the similarity computation, NOT the callout engine. Find where the per-frame similarity is computed (likely `lib/scoring/mediapipe/perFrame.ts` or similar). The most common cause is averaging cosine similarities over too many joints — the noise floor on random poses is around 0.85 because limb directions don't span much of the unit sphere. Fix by switching to either (i) per-joint angle delta with a per-joint normalization, or (ii) Procrustes-aligned position L2. Document the choice.

- **(B) The thresholds are mis-set OR the tier-mapping function is bypassed.** The log shows varied `windowMaxSimilarity` but `tier: "GROOVY"` regardless. → Inspect `tierForSimilarity()` or whatever the mapping function is called. It's almost certainly hitting a default or a wrong comparator (e.g., `>=` where `<` was meant).

- **(C) The callout overlay is rendering "GROOVY" regardless of what the engine emits.** The log shows correct varied tiers but the screen shows GROOVY. → Inspect `components/CalloutOverlay.tsx`. The most likely cause is the JSX rendering a hardcoded string from a stale debug branch, or the state hook keying off the wrong event field.

**Step 3 — Fix the diagnosed cause. Only the diagnosed cause.**

Don't fix all three at once. Document what you found and what you changed.

**Step 4 — Re-run, confirm callouts now vary by attempt quality.**

Sincere attempt: mix of PERFECT/GREAT/GROOVY, occasional ALMOST.
Standing still: mostly ALMOST.
Flailing: mix of ALMOST/GREAT (similarity to fast motion is genuinely high — that's why Gemini matters).

If the fix surfaces a deeper problem (e.g., the similarity stream is genuinely meaningless because the underlying scoring pipeline regressed), **stop and flag.** Do not paper over.

---

## Out of scope

- Apple Vision port.
- TikTok URL ingestion changes.
- Skill graph routing changes.
- Mode A changes.
- Sound design for callouts.
- Replacing Gemini with a different model. (See note at the bottom of this doc.)

---

## Working agreement

- After each group, pause and post a diff summary.
- Mobile-first: verify at 390px.
- If Group 5 step 2 surfaces diagnosis (A) — a saturated similarity stream — STOP and flag before fixing. That is a scoring-layer rewrite and is a separate spec, not this one.
- All prior round-1 and round-2 logging stays. Add to it; don't replace it.
- One commit per group. Branch: `scoring-round-3`. No push to main.

---

## Acceptance summary (all must pass)

- [ ] Reference video sent to Gemini is mirrored to match the attempt orientation; `referenceMirrored: true` in payload; prompt-invariants test updated.
- [ ] Reference and attempt are both trimmed to motion onset; `referenceMotionOnsetSec` logged; padding-aware prompt clause replaced with "starts at first movement" clause.
- [ ] Displayed overall = mean of components (excluding legs when upper-body-only). Headline number matches the breakdown bars. Gemini raw shown on debug pill only.
- [ ] Standing-still attempt: `is_actually_dancing: false`, overall 5–25, headline matches.
- [ ] Flailing attempt: `is_actually_dancing: false`, overall 5–25. **Hard canary.** If this fails, stop and flag.
- [ ] Sincere attempt: components in 35–95 range, displayed overall 55–85, trouble spots reference real dance moments (not 0:00 padding).
- [ ] Live callouts vary by attempt quality. Diagnosis written up in `docs/callout-diagnosis-round-3.md`.
- [ ] All prior tests still pass.
- [ ] Branch `scoring-round-3` pushed, no merge to main.

---

## After Claude Code finishes — your validation pass

Same five-attempt protocol as round 2:

1. **Sincere attempt.** Live callouts should vary. Gemini score 55–85, displayed overall matches components.
2. **Standing still.** Live callouts mostly ALMOST. Gemini `is_actually_dancing: false`, overall under 25.
3. **Flailing.** Live callouts mixed. Gemini `is_actually_dancing: false`, overall under 25. **This is the hard canary.**
4. **Sincere attempt on a different chunk.** Sanity check.
5. **Deliberately off-beat sincere attempt.** Timing component low, other components normal.

If runs 2 and 3 both score under 25 AND run 1 scores 55–85 AND the live callouts vary, the round is done. Flip `SHOW_BOTH_SCORES=false` and merge.

---

## Note on "should we abandon Gemini" (your question — read this)

The flailing score of 75 is the strongest evidence yet that Gemini-as-judge has a real failure mode. But the failure is not "Gemini cannot tell flailing from dancing." The failure is "the prompt is telling Gemini to be generous, the reference is unmirrored, and the trim still includes padding the prompt told it to ignore." We are not yet at the point where we can fairly say Gemini doesn't work — we're at the point where we can say *this prompt* doesn't work on flailing.

This spec is the last fair test of Gemini. If after this round flailing still scores above 40, the answer is: drop Gemini as the primary scorer, keep MediaPipe + a much stricter event-detection layer (the Just Dance / Dalea approach — per-beat angle deltas, color-coded, no semantic narration), and use Gemini only for the post-attempt *insights* (which are generated from the MediaPipe trouble spots, not used for scoring). That's a separate spec we write together if it comes to it.

Do this round first.