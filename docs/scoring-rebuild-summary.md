# Mode B scoring rebuild — summary

End-of-task writeup of the Mode B scoring rebuild requested in SPECK.md.
Goal: turn a popup that said "ALMOST THERE / 18 / threshold 70" — for a
user who danced competently — into a real learning loop with a trustable
score, a component breakdown, and a path to fix what went wrong.

## What the diagnostic found

See `docs/scoring-trace.md` (the end-to-end pipeline trace) and
`docs/scoring-diagnosis.md` (severity ranking).

The user-visible 18/100 was the result of three stacked bugs:

1. **Reference was synthetic.** `lib/scoring/syntheticReference.ts`'s
   `neutralReferenceFrame()` produced a "neutral upright pose with ±4°
   sway" — the user was being compared to a person standing still, not
   to the actual dancer. The worker already extracts a real per-frame
   reference pose for every dance (loaded via `dance.pose_data_url`,
   used in Mode A), but Mode B never wired it in.
2. **Frame-score curve was exponential.** `frameScoreFromSimilarity =
   100 * exp(-(1-sim) * 5)` crushed any real cosine — even 0.95
   similarity mapped to ~78. The exponential's tail was way too steep
   for typical dance-vs-dance cosine numbers (0.85-0.97).
3. **No left/right swap.** When a follow-along user mirrors a
   forward-facing dancer, the user's anatomical right hand maps to
   the dancer's anatomical left. The original pipeline compared
   `user.left_*` to `reference.left_*` literally — penalising a
   correctly-mirrored copy.

Secondary issues: no per-component decomposition, no trouble-spot
detection, no drill-mode integration, and a "Almost there" copy that
showed regardless of how far the score was from passing.

## What was rebuilt vs kept

**Kept.** Camera lifecycle, MediaPipe extractor wrapper, the runState
machine, the StartOverlay countdown, the audio re-render guards, the
existing in-camera SkeletonOverlay, the DTW algorithm itself, the
BeatTracker, the chunkProgress / mastery persistence, Mode A's
fundamental layout, the SPECK round-4 / round-5 / SPECK-polish fixes.
None of those needed work.

**Rebuilt.**

- `lib/pose/jointAngles.ts`: added `compute2DJointAngles()` for the
  image-space comparison surface (the worker JSON has z=0 — we can't
  honestly use depth-dependent fields like `hip_rotation_y` /
  `chest_forward_z`).
- `lib/pose/normalize.ts` (new): `normalizeToBody` for shared canonical
  body frame; `mirrorLandmarksHorizontal` for the user-vs-reference
  mirror flip (negates x AND swaps LEFT_*/RIGHT_* indices).
- `lib/scoring/referenceFrames.ts` (new): converts worker pose JSON
  into mirrored JointAngleVector frames; cached per chunk-range.
- `lib/scoring/jointWeights.ts` (new): variance-driven per-joint
  weights, per-joint tolerances, the per-joint score function, and
  the component groupings (Arms / Legs / Body).
- `lib/scoring/scorer.ts`: replaced cosine + exp() with weighted
  per-joint comparison. Added components, trouble spots, timing
  derivation. Tightened DTW band to ~220 ms slack.
- `lib/scoring/uiPrefs.ts` (new): localStorage flag for the dual
  overlay toggle.
- `components/DualSkeletonOverlay.tsx` (new): canonical-body skeleton
  pair, reference in white, user in coral. Mirror is applied at the
  landmark level so the comparison is visually intuitive.
- `components/ResultsCard.tsx` (new): adaptive headline, big colour-
  coded score, Arms / Legs / Body / Timing bars, up to 3 trouble-spot
  rows with drill links, "Drill the worst part" primary CTA.
- `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx`: loads real
  reference pose data, drives the live and final scores from it,
  renders the dual overlay, exposes a "skeletons on/off" toggle, and
  hands the final SessionScore to ResultsCard.
- `app/dance/[danceId]/chunk/[chunkIndex]/copy/page.tsx`: drill-mode
  URL params (`?from`, `?to`, `?speed`). Auto-advances 0.5x → 0.75x
  → 1.0x every 3 loops, then routes back to Mode B with the same
  window. Skips the StartOverlay + framing-check redirect in drill
  mode.

## The math of the new scoring

Per-frame, per-joint:

```
delta_k = | user.angle_k - reference.angle_k |
score_k = max(0, 1 - delta_k / tolerance_k) ^ 2
```

Tolerances (in degrees, except chest_forward_z which is meters):

```
left_elbow / right_elbow / left_shoulder / right_shoulder  → 40
left_hip / right_hip / left_knee / right_knee              → 45
torso_lean                                                 → 25
hip_rotation_y                                             → 60 (zeroed in 2D)
chest_forward_z                                            → 0.3 (zeroed in 2D)
```

Per-frame overall:

```
weighted_overall = Σ_k (score_k * w_k) / Σ_k w_k        (range 0..1)
frame_score      = weighted_overall * 100                (range 0..100)
```

Joint weights `w_k` come from `deriveJointWeights(referenceFrames)`:

```
stddev_k = std(reference.angle_k across chunk frames)
raw_k    = stddev_k for "active" joints; 0 for hip_rotation_y/chest_forward_z
w_k_raw  = raw_k + MIN_WEIGHT                            (MIN_WEIGHT = 0.05)
scale    = nEligibleJoints / Σ_k w_k_raw                 (so avg weight = 1)
w_k      = w_k_raw * scale                              (zeroed dims stay 0)
```

This makes the score sensitive to "did you do the moves the dance is
actually about". A static-knees TikTok-arm-dance won't penalise you
heavily for a static-knees user; an all-body routine will.

Frame-pairs come from DTW. Local cost is Euclidean over the joint-angle
vector. The Sakoe-Chiba band is set to:

```
window_frames = max( |N - M|, ceil(220ms / medianFrameInterval) )
```

— so users get at most ~220ms of timing slack before DTW refuses to
align further.

After DTW:

- **Beat scores**: mean frame_score per beat (BPM-derived).
- **Overall**: mean(beatScores).
- **Components**: mean per-joint score within each joint group, * 100.
  - Arms = elbows + shoulders, Legs = hips + knees, Body = torso_lean.
- **Timing**: fraction of DTW path steps that are strictly diagonal
  (both user and reference advanced one frame), mapped 0.5 → 0,
  1.0 → 100.
- **Trouble spots**: non-overlapping 1.5s windows, ranked by mean
  frame_score ascending. Up to 3, each at least 8 points worse than
  overall. Worst joint per spot = joint with the lowest mean
  per-joint score in the window. Phrase: `${joint} ${avgDelta}° off`.

Headline copy mapping (results card):

```
score ≥ 85 → "Nailed it."
score ≥ 70 → "You got it."     (PASS_THRESHOLD = 70)
score ≥ 50 → "Getting there."
score < 50 → "Keep practicing." (NOT "Almost there")
```

## How calibration was done

`tests/scoringCalibration.test.ts` defines four synthetic personas
against an arm-heavy reference (shoulders ±30°, elbows ±25°, legs
static — typical TikTok dance):

| Persona              | Spec target | Actual |
|----------------------|-------------|--------|
| stand still          | < 25        | **21.9** |
| random arm flailing  | < 40        | **23.3** |
| ~8° noise tracking   | 55-85       | **80.5** |
| perfect copy         | ≥ 95        | **100**  |

Component differentiation, arms-perfect / legs-static user against a
full-body reference: **arms 100 / legs 43**.

Trouble-spot detection, user freezes for 1.5s mid-chunk: a trouble
spot in `[freezeStart, freezeEnd]` is reliably surfaced.

Calibration steps:

1. Started with linear per-joint score and the same exponential
   frame-score curve. Stand-still scored ~50. Switched per-joint to
   quadratic `(1 - d/tol)^2`.
2. Stand-still dropped to 25.5. Tightened arm tolerances from 45° to
   40° (typical arm-driven dance is more sensitive than legs).
3. Stand-still 22 — passing — but legs/torso were still getting too
   much weight on arm dances. Lowered `MIN_WEIGHT` from 0.15 to 0.05.
4. Re-ran the calibration suite. All four personas in spec.

## Known limitations and next steps

- **Pose JSON ships z=0.** The worker's COCO-17 → MediaPipe-33
  conversion in `worker/pose.py` doesn't write depth. We compensate by
  using `compute2DJointAngles` on both sides, which drops
  `hip_rotation_y` and `chest_forward_z`. Future work: switch the
  worker to a true 3D BlazePose pipeline, or run MediaPipe Tasks Vision
  on the reference video in a Node-side worker. Either would unlock
  depth-sensitive scoring (front-vs-side body orientation).
- **Drill-mode re-scoring is one-trip.** When the drill loop completes,
  we route to `/test?from=ms&to=ms` but the test page doesn't yet scope
  its scoring to the [from, to) window — the user re-runs the WHOLE
  chunk. Adding `?from`/`?to` clamping in the test detection loop is a
  natural next pass (mirror what copy/page.tsx already does).
- **Live readout still uses cosine.** The bottom-right pill during the
  run shows a cosine-derived running score for cheapness/stability.
  The final-screen number uses the weighted per-joint metric. They
  agree directionally but the live number tends to be more generous.
  Aligning them would mean piping the variance weights to the live
  loop and computing the weighted per-joint score per frame.
- **Mode C and the drill page still use synthetic reference.**
  `app/dance/[danceId]/full/page.tsx` and `app/drill/[skillId]/page.tsx`
  still call `neutralReferenceFrame` / `generateReferenceSequence`.
  Out of scope for this task (SPECK §Hard rules: "Do not touch Mode A
  …"), but they will scoring-regress the same way Mode B did until
  they're migrated. The migration is mechanical: import
  `useReferencePose` and `buildReferenceSequence`, do the same swap.
- **Trouble-spot worst-joint phrasing is short and clinical.** "right
  elbow 28° off" is informative but not friendly. A future pass can
  map joint+sign to action verbs ("your right elbow was too straight")
  by reusing the `phraseFor()` helper that already exists for
  `correctionHint`.

## Files touched

- `docs/scoring-trace.md` *(new)*
- `docs/scoring-diagnosis.md` *(new)*
- `docs/scoring-rebuild-summary.md` *(new — this file)*
- `lib/pose/jointAngles.ts`
- `lib/pose/normalize.ts` *(new)*
- `lib/scoring/scorer.ts`
- `lib/scoring/jointWeights.ts` *(new)*
- `lib/scoring/referenceFrames.ts` *(new)*
- `lib/scoring/uiPrefs.ts` *(new)*
- `lib/scoring/types.ts`
- `components/DualSkeletonOverlay.tsx` *(new)*
- `components/ResultsCard.tsx` *(new)*
- `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx`
- `app/dance/[danceId]/chunk/[chunkIndex]/copy/page.tsx`
- `tests/scorer.test.ts`
- `tests/scoringCalibration.test.ts` *(new)*
- `tests/resultsCardCopy.test.ts` *(new)*

## Stage 6 acceptance criteria, status

1. **Skeleton accuracy** — User-skeleton overlay (existing
   `SkeletonOverlay`) unchanged; the new `DualSkeletonOverlay` skips
   any frame whose hips/shoulders fall below 0.3 visibility, so
   pretzel/garbage frames are simply not drawn. Verified by code.
2. **Score sanity** — `tests/scoringCalibration.test.ts` locks in 22 /
   23 / 80 / 100 for the four personas, all in spec bands. ✓
3. **Mirror correctness** — `mirrorLandmarksHorizontal` flips x AND
   swaps LEFT_*/RIGHT_* index pairs; reference frames are mirrored
   before joint-angle extraction; `DualSkeletonOverlay`
   `mirrorReference=true` matches the camera-mirror so the user's
   right-side moves overlap the reference's right-side on screen.
   Verified by code review of `lib/pose/normalize.ts` +
   `lib/scoring/referenceFrames.ts`.
4. **Component scores informative** — Calibration test: arms-perfect
   user with legs static against a full-body reference yields
   arms=100, legs=43, gap=57. ✓
5. **Trouble-spot identification** — Calibration test: 1.5s freeze
   yields a trouble spot overlapping `[1500, 3000)`. ✓
6. **Drill mode loop** — Mode A reads `?from`, `?to`, `?speed`; loops
   the sub-window; auto-advances 0.5 → 0.75 → 1.0 every 3 loops;
   routes back to `/test?from=…&to=…` after the final tier. End-to-end
   browser verification deferred (camera-bound).
7. **Results screen copy** — `tests/resultsCardCopy.test.ts` locks
   in: 90 → "Nailed it.", 70 → "You got it.", 60 → "Getting there.",
   18 → "Keep practicing." (explicitly NOT "Almost there"). ✓
