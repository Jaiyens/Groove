# SPECK: Fix Mode B scoring via skeleton normalization + angle-based comparison

## Why this exists

Mode B scoring is broken in a way that the previous rebuild (Stages 1–7) did not address. Symptoms from real-world testing:

- When user dances next to the reference, the user's rendered skeleton is ~2x the size of the reference dancer's skeleton in the same frame. The size disparity itself signals the bug.
- Scores feel uncorrelated with actual dance quality. "Good" attempts and "bad" attempts produce similar numbers.
- The calibration suite (stand-still=21.9, noise-tracking=80.5, perfect=100) passes, but those tests use synthetic landmarks of the SAME body size as the reference. They do not exercise the real failure mode.

## Root cause (read this section before doing anything else)

The scoring pipeline is comparing skeletons in **image-space coordinates** of two **different-sized bodies** without normalization. Three compounding problems:

1. **Translation not removed.** Reference dancer's pelvis is at one (x, y) in image space; user's pelvis is at a different (x, y). Every joint position carries an offset that has nothing to do with dance quality.
2. **Scale not removed.** Reference dancer occupies ~50% of frame height; user occupies ~90%. Every limb position differs by ~1.8x even on identical poses. This is the "skeleton half my size" observation.
3. **Positions compared instead of angles.** Even with translation and scale fixed, raw 2D positions are noisy under camera distance, framing, and rotation variation. The dance-tracking literature (Disney/Raptis 2011, Walloon-dance 2015, Kinect-Thai-dance 2017, Mruchus dance-sync, DeepDance Devpost) overwhelmingly converges on comparing joint **angles**, which are invariant to translation, scale, and most rotation by construction.

The skill graph (public/data/knowledge_graph.json) further mixes units in `measurable_success_criterion`: some are angles in degrees (good, scale-invariant), some are positions in meters ("wrist.x − shoulder.x > 0.30m") that are NOT invariant to body size. Position thresholds must be expressed as fractions of the user's own arm/torso/shoulder lengths.

## What you are doing in this task

A focused refactor of the scoring math layer to fix normalization and switch the comparison primitive from positions to angles. You are NOT swapping pose models. You are NOT changing Mode A. You are NOT touching the UI beyond the existing ResultsCard. You are NOT touching the worker or Supabase. You are NOT inventing new scoring features.

You ARE:

- Normalizing every skeleton (reference and user) to a canonical body frame before comparison
- Computing joint-angle vectors as the primary comparison primitive
- Converting every absolute-meter threshold in the skill graph to a body-relative threshold at runtime
- Updating the calibration suite to use **different-sized bodies** so it actually catches the bug class that shipped to me
- Documenting every math change in `docs/scoring-normalization.md`

## Stages

### Stage 1 — Diagnose against real data (do not skip)

1.1. Re-read `docs/scoring-trace.md` and `docs/scoring-diagnosis.md` from the previous rebuild. Note what was fixed (the synthetic-reference bug, the exponential frame-score crush, the mirror). Note what was NOT fixed (translation/scale normalization, angle-based primitive).

1.2. Open `lib/pose/normalize.ts`, `lib/pose/referenceFrames.ts`, `lib/pose/jointAngles.ts`, `lib/scoring/scorer.ts`, `lib/scoring/dtw.ts`, `lib/scoring/similarity.ts`. Map every place where two skeletons get compared — direct landmark comparison, angle comparison, distance comparison, anything. Write the map to `docs/scoring-normalization.md` under a "Comparison sites" header.

1.3. For each comparison site, mark which of these it does:
- Translates to pelvis-origin? (yes/no)
- Scales by torso length or equivalent? (yes/no)
- Compares angles (scale-invariant) or positions (not)?

Almost every site will fail at least one of these. That is the bug surface.

1.4. Commit: `docs(scoring): normalization audit + comparison-site map`.

### Stage 2 — Implement canonical skeleton normalization

2.1. Add `lib/pose/canonicalize.ts`. Pure TypeScript, no browser deps. Export:

```ts
export interface CanonicalSkeleton {
  // Every landmark translated so pelvis_midpoint = (0, 0) and scaled so torso_length = 1.
  // Same landmark indices as MediaPipe Pose Landmarker (33 points).
  // Optionally rotated so shoulder line is horizontal — controlled by `rotateToUpright` flag.
  landmarks: Array<{ x: number; y: number; z: number; visibility: number }>;
  torsoLength: number;       // original torso length in input units (image-space px or normalized 0-1)
  shoulderWidth: number;     // original shoulder width
  pelvis: { x: number; y: number; z: number };  // original pelvis midpoint
  rotationApplied: number;   // radians, if rotateToUpright
}

export function canonicalizeSkeleton(
  raw: PoseResult,                         // landmarks straight from MediaPipe
  opts?: { rotateToUpright?: boolean }     // default false for now; angles handle most rotation
): CanonicalSkeleton;
```

Algorithm:
- Compute pelvis midpoint = midpoint of MediaPipe landmarks 23 (left_hip) and 24 (right_hip).
- Translate every landmark by `-pelvis`.
- Compute torso length = Euclidean distance from pelvis midpoint to shoulder midpoint (midpoint of landmarks 11, 12). If torso_length < 0.05 (degenerate / very low confidence), return null — calling code treats this as a dropped frame.
- Divide every translated landmark by torso_length.
- If `rotateToUpright`, compute the shoulder-line angle (atan2 of shoulder vector) and rotate the whole skeleton so it becomes 0.
- Preserve visibility as-is.

2.2. Unit-test in `tests/canonicalize.test.ts`:
- Identical pose at 2 different scales → canonicalized landmarks match within 1e-6.
- Identical pose at 2 different image positions → canonicalized landmarks match.
- Mirrored pose (mirrorLandmarksHorizontal applied) → canonicalized form is the mirror.
- A degenerate frame (all landmarks at origin, torso_length ≈ 0) → returns null.

2.3. Commit: `feat(pose): canonical skeleton normalization (translate + scale)`.

### Stage 3 — Joint-angle vector as the comparison primitive

3.1. Extend `lib/pose/jointAngles.ts` (do not rewrite it; add a parallel exporter so the old code path keeps compiling). Export:

```ts
export interface JointAngleVector {
  // All angles in radians, all in [0, π].
  leftElbow: number;
  rightElbow: number;
  leftShoulder: number;       // angle at shoulder between (shoulder→hip) and (shoulder→elbow)
  rightShoulder: number;
  leftHip: number;            // angle at hip between (hip→shoulder) and (hip→knee)
  rightHip: number;
  leftKnee: number;
  rightKnee: number;
  torsoLean: number;          // angle between vertical (0,-1) and (pelvis→shoulderMid)
  shoulderTilt: number;       // angle between horizontal (1,0) and (leftShoulder→rightShoulder)
  hipTilt: number;            // angle between horizontal (1,0) and (leftHip→rightHip)
  // Plus per-joint confidence = min(visibility of joints used in that angle).
  confidence: Record<string, number>;
}

export function jointAnglesFromCanonical(c: CanonicalSkeleton): JointAngleVector;
```

3.2. Why these specific angles: they cover the four major limb articulations (elbows, shoulders, hips, knees), the spine alignment (torsoLean), and the two main body-frame tilts (shoulderTilt for body roll / chest iso, hipTilt for hip iso). They map cleanly onto the skill graph's success criteria for arm extension, dime stop, hip pop, body roll, etc.

3.3. Compute angles using `acos((a·b)/(|a||b|))` with a guard for |a||b| < 1e-6 → return 0 and confidence=0 for that joint.

3.4. Unit-test in `tests/jointAngles.test.ts`:
- T-pose canonical skeleton (arms horizontal) → both shoulders at π/2 within 0.01 rad.
- Arms-down rest pose → shoulders near 0.
- Right elbow flexed 90° → rightElbow within 0.05 of π/2.
- Whole-body scale 0.5x and 2x → angles unchanged within 1e-6 (this is THE test that proves scale invariance).
- Skeleton translated by (100, 50) in pixels → angles unchanged within 1e-6 (translation invariance).

3.5. Commit: `feat(pose): joint-angle vector primitive with scale-invariance tests`.

### Stage 4 — Rewire scorer.ts to use angles on canonicalized skeletons

4.1. In `lib/scoring/scorer.ts`, replace the existing per-frame scoring path with this pipeline:

```
for each user frame F_u and reference frame F_r aligned by DTW:
    c_u = canonicalizeSkeleton(F_u)
    c_r = canonicalizeSkeleton(F_r)
    if c_u or c_r is null: skip frame, count as dropped
    a_u = jointAnglesFromCanonical(c_u)
    a_r = jointAnglesFromCanonical(c_r)
    per_joint_diff[j] = |a_u[j] - a_r[j]|        # in radians
    frame_score = aggregate_per_joint(per_joint_diff, weights)
```

4.2. Aggregation rule (replaces the old quadratic curve, keeps it readable):

```
per_joint_score[j] = max(0, 1 - (diff[j] / TOL[j])^2)        # 0 to 1
where TOL[j] = 0.35 rad (~20°) for elbows/shoulders/hips/knees
              0.20 rad (~11°) for torsoLean
              0.25 rad (~14°) for shoulderTilt, hipTilt

frame_score = sum(weight[j] * per_joint_score[j]) / sum(weight[j])
overall_score = 100 * mean(frame_scores across valid frames)
```

4.3. Per-joint weights stay variance-driven as in Stage 3 of the previous rebuild — joints that vary more in the reference get more weight. Don't change that logic; just apply it to angle-space variance instead of position-space variance.

4.4. Components (Arms / Legs / Body / Timing) — same idea as before, but rebuilt from the angle vector:
- Arms = mean of left/right elbow + left/right shoulder per-joint scores
- Legs = mean of left/right hip + left/right knee per-joint scores
- Body = mean of torsoLean + shoulderTilt + hipTilt per-joint scores
- Timing = computed from DTW warp path: 1 - mean(|warp[i] - i|) / (sequence_length * timing_tolerance)

4.5. Trouble spots: same 1.5s-window algorithm as before, but ranked by mean frame_score within window (now on the new scale), not by raw position distance.

4.6. Commit: `feat(scoring): rewire per-frame scoring on canonical angles`.

### Stage 5 — Body-relative thresholds for skill-graph position criteria

5.1. The skill graph's `measurable_success_criterion` fields contain absolute-meter thresholds (e.g. "right_wrist.x − right_shoulder.x > 0.30 m"). These are calibrated to a specific body size and break for other bodies.

5.2. Add `lib/graph/criteriaEvaluator.ts`. Export:

```ts
export function evaluateCriterion(
  criterion: string,                  // raw string from the graph
  userSkeletonSeries: CanonicalSkeleton[],
  refSkeletonSeries: CanonicalSkeleton[],
  bpm: number
): { passed: boolean; evidence: string };
```

5.3. Inside the evaluator: when the criterion mentions a distance in meters, convert it at runtime to "fraction of user's torso_length". E.g. "0.30 m" becomes "0.30 / reference_torso_length_m ≈ 0.6 torso-lengths", and the check on the user becomes "user_value > 0.6 * user_torso_length".

5.4. You don't have to support every criterion in the graph for this PR — start with the criteria for the three seeded routines (Golden, Dead Dance, NOT CUTE ANYMORE). Parse the common patterns (distance thresholds, angle thresholds, timing windows). For criteria you can't yet parse, return `{ passed: true, evidence: "criterion not yet supported" }` and log to console. List unsupported criteria in `docs/scoring-normalization.md` under "Unsupported criteria — followup".

5.5. Unit-test in `tests/criteriaEvaluator.test.ts`:
- A user with 0.5x torso scale executing the reference arm extension → passes (was failing before because absolute meters didn't scale).
- A user under-extending by 50% → fails.
- An unsupported criterion → returns passed=true with the warning evidence string.

5.6. Commit: `feat(graph): body-relative criterion evaluator`.

### Stage 6 — Calibration suite that actually catches the shipped bug

6.1. The existing `tests/scoringCalibration.test.ts` uses synthetic landmarks at the same body size as the reference. Add new tests in the same file (do not delete the old ones; they still cover the synthetic-reference regression):

- **half_scale_perfect**: user landmarks = reference landmarks scaled by 0.5x about an arbitrary translated origin. Expected score: ≥ 95. THIS IS THE KEY NEW TEST. If this passes, the size disparity bug is fixed.
- **double_scale_perfect**: same, 2.0x. Expected ≥ 95.
- **translated_perfect**: user landmarks = reference landmarks + offset (e.g. +200px x, -100px y). Expected ≥ 95.
- **rotated_5deg_perfect**: shoulder line rotated 5° vs reference. Expected ≥ 90 (small penalty acceptable).
- **half_scale_wrong**: user is 0.5x scale BUT arms in wrong position. Expected ≤ 40.
- **half_scale_8deg_noise**: 0.5x scale + 8° gaussian noise on joints. Expected 55–85.

6.2. Run all tests. The two failing-when-pasting tests are likely going to be half_scale_perfect and translated_perfect; that's the whole point — they should fail against the OLD code path and pass against the NEW one. If both pass, you've fixed the bug class.

6.3. Commit: `test(scoring): body-size-invariant calibration suite`.

### Stage 7 — End-to-end verification

7.1. Run `npm test`. Expect all tests green (97 existing + ~15 new).

7.2. Run `npx tsc --noEmit`. Expect clean.

7.3. Run `npm run dev`. Manually navigate to Mode B for the Golden routine. Confirm:
- The reference and user skeletons in DualSkeletonOverlay now appear at the same canonical size (this is implicit from canonicalizeSkeleton being called before render — wire it into the overlay component if it isn't already; if the overlay still renders raw landmarks, add a canonicalized rendering toggle and default it ON).
- Scoring numbers change vs the previous rebuild on the same input recording, if you have one cached.

7.4. Write `docs/scoring-normalization.md` covering:
- Comparison-site audit results
- Math changes (translation + scale + angles)
- Body-relative criterion conversion
- New calibration tests and what bug class each catches
- Known limitations (rotation invariance still partial, criteria parser incomplete, etc.)
- Why we did NOT swap pose models in this PR (preserves scope, MediaPipe accuracy improvements are a separate decision tracked in a followup doc)

7.5. Commit: `docs(scoring): normalization rebuild summary`.

## Hard rules

1. **Do not swap pose models.** Stay on MediaPipe Pose Landmarker. RTMPose-via-Modal is a separate decision being evaluated outside this PR.
2. **Do not modify Mode A copy-along or the practice-loop routing.** Scope is the scoring math only.
3. **Do not regress the existing 97 tests.** If you have to change one, it's because it asserted the old buggy behavior — say so explicitly in the commit message.
4. **Keep `lib/pose/` and `lib/scoring/` pure TypeScript** — no browser-only APIs. They will port to Swift later.
5. **Do not invent new product features.** No new buttons, no new screens, no new fields on the ResultsCard.
6. **One stage per commit, in order.** If a stage is blocked, write to `BLOCKERS.md` and stop. Do not skip ahead.
7. **All thresholds in TOL[j] and timing_tolerance are parameters at the top of scorer.ts**, not magic numbers buried in functions. The next iteration will tune them against real recordings.
8. **The canonicalization invariance unit tests are not optional.** They are the proof that the bug is fixed. Do not commit Stage 2 without them passing.

## Tiebreaker for ambiguity

When something is ambiguous, default to whichever interpretation:
1. Is most portable to Swift later (no browser-only types, no React-only patterns)
2. Is most testable with synthetic landmarks (so the calibration suite stays the source of truth)
3. Preserves angle-space comparison as the primary primitive
4. Keeps the canonicalization step as the single chokepoint where every skeleton enters the scoring pipeline

Begin.