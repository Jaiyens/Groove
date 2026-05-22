# SPECK: Fix the left/right mirror bug in Mode B scoring

## Why this exists

Verified by manual UI test just now: when the user raises their right hand, the reference skeleton in DualSkeletonOverlay raises its left hand. This means the scorer is comparing the user's right-labeled landmarks to the reference's left-labeled landmarks, scoring even a perfect mirror-copy attempt as ~40%.

This is the actual root cause of the bad Mode B scores. The full canonical normalization + angle-based rebuild from the last PR is correct and stays. This PR is a focused mirror fix on top of it.

## Background on what's actually wrong

The front camera produces a naturally-mirrored video feed — when the user raises their right hand, it appears on the right side of the screen (the camera-mirror convention, which matches how humans look in actual mirrors). MediaPipe Pose Landmarker runs on this mirrored feed and labels landmarks according to image position, so the landmark labeled `right_wrist` is actually the user's anatomical LEFT wrist appearing on the right side of the frame.

The reference dancer's video is NOT mirrored. Her `right_wrist` landmark is her anatomical right wrist.

A dance student copying a reference does so as a mirror — when the teacher raises her right hand, the student raises their left to face it. So the correct comparison is:
- user's anatomical left ↔ reference's anatomical right
- user's anatomical right ↔ reference's anatomical left

This is the mirror semantics. We need to apply `mirrorLandmarksHorizontal` to exactly ONE side of the comparison (conventionally the user) so the labels line up. The previous rebuild added `mirrorLandmarksHorizontal` in `lib/pose/normalize.ts` but it's clearly not being applied at the right layer in the scoring pipeline, because the symptom shipped.

## What you are doing in this task

A surgical fix. Find every place where user landmarks and reference landmarks meet, ensure the user side is mirrored exactly once before canonicalization, ensure the reference side is not mirrored, and ensure the overlay renders consistently with what the scorer sees. Add tests that would have caught this bug. Update docs.

You are NOT changing pose models. You are NOT changing the canonicalization math. You are NOT changing joint angles or DTW. You are NOT changing Mode A. You are NOT changing the UI beyond a possible one-line overlay wiring fix.

## Stages

### Stage 1 — Trace the mirror state through the pipeline

1.1. Search the codebase for every call to `mirrorLandmarksHorizontal` and every place where user-side landmarks enter scoring. Likely files:
- `lib/pose/normalize.ts` (defines mirrorLandmarksHorizontal)
- `lib/pose/canonicalize.ts` (canonical normalization, added last PR)
- `lib/pose/referenceFrames.ts` (builds reference frame series from worker pose JSON)
- `lib/scoring/scorer.ts` (the per-frame pipeline)
- `app/.../test/page.tsx` or wherever Mode B wires user frames into the scorer
- `components/DualSkeletonOverlay.tsx` (the visual layer that confirmed the bug)

1.2. For each location, write down in `docs/mirror-fix.md` under "Mirror state audit":
- Whether user landmarks pass through `mirrorLandmarksHorizontal` here (yes/no)
- Whether reference landmarks pass through it here (yes/no)
- Whether the function is called for the SCORER path, the OVERLAY path, or both
- The current behavior — which side ends up mirrored at the point of comparison

1.3. Identify the one wrong place. Almost certainly one of:
- (A) `mirrorLandmarksHorizontal` is only applied inside DualSkeletonOverlay for rendering, but scorer.ts gets unmirrored user landmarks
- (B) It's applied to both user and reference, which cancels out
- (C) It's applied to reference instead of user (logically equivalent but wrong by convention)
- (D) It's applied at the raw-landmark layer but canonicalization undoes the asymmetry because of how the rotation step works

1.4. Commit: `docs(scoring): mirror state audit`.

### Stage 2 — Define the canonical mirror convention

2.1. Add to the top of `lib/pose/normalize.ts` (or wherever `mirrorLandmarksHorizontal` lives) a comment block stating the project-wide convention:

```
MIRROR CONVENTION
=================
Front-camera user video is naturally horizontally mirrored. Reference dance video is not.
For a dance student copying a teacher, the correct comparison is mirror-semantics:
  user's anatomical left  ↔ reference's anatomical right
  user's anatomical right ↔ reference's anatomical left

Therefore, in the scoring pipeline, user landmarks pass through mirrorLandmarksHorizontal()
EXACTLY ONCE before canonicalization. Reference landmarks are never mirrored. The overlay
must use the same convention so what the user sees matches what the scorer scores.

A passing test of this convention: user raises their physical right hand. The reference
skeleton in the overlay raises the side that visually aligns with the user's right hand
(which from the user's perspective is the same side, because the user video is mirrored).
```

2.2. Confirm `mirrorLandmarksHorizontal` does the right thing: it swaps every left/right landmark pair (e.g. swaps landmarks 11↔12 for shoulders, 23↔24 for hips, all the way through) AND flips x = 1 - x for normalized coords or x = width - x for pixel coords. If it only flips x without swapping labels, that's a bug — fix it. If it only swaps labels without flipping x, that's also a bug — fix it. It must do both.

2.3. Commit: `docs(pose): mirror convention + verify mirrorLandmarksHorizontal correctness`.

### Stage 3 — Apply mirror at the single correct chokepoint

3.1. The chokepoint is the entry to the scoring pipeline — the place where raw user landmarks from the live MediaPipe stream get passed to scorer.ts. Find this entry (likely in `app/.../test/page.tsx` or in scorer.ts itself). Apply `mirrorLandmarksHorizontal` to user landmarks exactly once, BEFORE canonicalization.

3.2. Remove `mirrorLandmarksHorizontal` from any other location in the scoring path. Specifically, audit:
- The canonicalization step — it should NOT mirror internally
- The angle vector computation — it should NOT mirror internally
- The DTW step — it should NOT mirror internally
- The reference frames builder — should NOT mirror reference

If the previous rebuild had any of these mirroring internally, that's the cancellation bug. Strip it.

3.3. The overlay needs to match the scorer. Two options, pick whichever is simpler in the existing code:
- (Preferred) The overlay rendering also pulls from the post-mirror user landmark stream, so what the user sees on screen is the same data the scorer sees.
- (Acceptable) The overlay separately mirrors for rendering but uses identical mirror semantics.

Whatever you do, leave a single comment at the overlay's mirror application explaining the convention.

3.4. Commit: `fix(scoring): apply mirror at single user-entry chokepoint`.

### Stage 4 — Tests that would have caught this

4.1. Add `tests/mirror.test.ts`:

- **Test: user_right_lifts_reference_right** (the test that would have caught the shipped bug). Construct a synthetic user landmark frame where right_wrist is raised (high y in image space). Construct a reference frame where her right_wrist is also raised. Pass through the full scoring pipeline. Expect: high per-joint score on the right-arm joints, NOT a low score. This is the unit test version of "raise your right hand and check the reference's right hand goes up."

- **Test: mirrorLandmarksHorizontal_is_involution**. Apply the mirror twice and confirm you get the original landmarks back within 1e-6.

- **Test: mirror_swaps_labels_correctly**. After one application, left_wrist's anatomical content is at the original right_wrist's position and vice versa, for at least three landmark pairs (shoulders, wrists, hips).

- **Test: full_pipeline_handedness**. A canonical user-perfect-copy synthetic input (user landmarks are the reference landmarks with mirror semantics applied to simulate the camera flip) scores ≥ 95. This is the integration test of "the system correctly recognizes a mirror copy as a correct copy."

4.2. Run the existing calibration suite (137 tests). Verify nothing breaks. If the existing `half_scale_perfect` or `translated_perfect` tests break because they were constructed without mirror semantics, update them to use mirror-correct synthetic inputs, and note this in the commit message.

4.3. Commit: `test(pose): mirror-aware handedness suite`.

### Stage 5 — Manual UI verification

5.1. Run `npm run dev`. Open Mode B for the Golden chunk.

5.2. Perform the handedness check:
- Raise your physical right hand. The reference skeleton must raise the side that visually corresponds to your right hand in the overlay.
- Raise your physical left hand. Same check, opposite side.
- Wave one hand. The reference's matching hand should be moving in the overlay.

5.3. Perform the rough scoring check: do a real attempt at the Golden chunk. Compare the score to the bad-attempt and standing-still cases. We're looking for the rank-order to be obvious (good > bad > still) with meaningful gaps. Document the three scores in `docs/mirror-fix.md` under "Post-fix score check."

5.4. If the handedness check passes but the score still feels low, do NOT chase it in this PR. Note it in `BLOCKERS.md` with the symptom and proposed next step (tune TOL[j] thresholds, or investigate the legacy vs canonical path divergence). The mirror fix is the one thing this PR does.

5.5. Commit: `docs(scoring): post-mirror-fix verification log`.

## Hard rules

1. **One mirror application, one location, before canonicalization.** Not two, not zero. If you find more than one, strip the extras. If you find zero, that's the bug.
2. **Do not change the canonical normalization math, the joint angle math, DTW, or the scorer aggregation.** Those are now considered correct.
3. **Do not swap pose models.** Stay on MediaPipe.
4. **Do not modify Mode A.**
5. **The handedness unit test from Stage 4 is the gating test.** It must pass before you commit Stage 4. If it doesn't pass, debug Stage 3 until it does.
6. **The manual UI handedness check in Stage 5 is also gating.** If the overlay still shows wrong-side mirroring after Stage 3, the fix is incomplete regardless of what unit tests pass.
7. **Reference data is never mirrored.** If you find code that mirrors reference landmarks anywhere, that's a bug — remove it.

## Tiebreaker for ambiguity

When something is ambiguous, default to:
1. Applying the mirror as close to the live MediaPipe output as possible — ideally the very first thing that happens to a user frame
2. Keeping the canonical pipeline (canonicalize → angles → DTW) ignorant of mirror state
3. Making the overlay visually match what the scorer scores, not the other way around
4. Preferring deletion of redundant mirror calls over adding new ones

Begin.