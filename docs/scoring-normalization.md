# Scoring normalization rebuild

This doc accompanies the SPECK refactor that fixes the Mode B "user's
skeleton renders 2x the reference's size" bug observed during real-world
testing, plus the related "scores feel uncorrelated with performance"
symptom. It is written in stages alongside the code so the math changes
and their motivation are recoverable later.

## Background — what the previous rebuild fixed (and didn't)

The Stage 1-7 rebuild documented in `docs/scoring-rebuild-summary.md`
fixed:

- The synthetic-reference bug (`neutralReferenceFrame` was replacing the
  real reference pose stream) — Mode B now loads the worker-produced
  `pose_data_url` sidecar.
- The exponential frame-score crush (`exp(-(1-sim)*5)` collapsed honest
  cosines of 0.95 to 78). Replaced with a calibrated piecewise-linear
  map.
- The left/right mirror asymmetry between a follow-along user (camera-
  mirrored) and a normally-oriented reference dancer.

It did NOT fix:

- **Body-size disparity.** The user's body and the reference dancer's
  body live in different image-space coordinate systems (different
  camera framings, different distance to camera, different aspect
  ratios in some cases). Even though `compute2DJointAngles` is
  theoretically translation- and scale-invariant for angles within a
  single frame, the inputs to it are still raw image-space landmarks —
  there is no canonical body frame that both streams share. The visual
  symptom: in DualSkeletonOverlay the user's skeleton renders ~2x the
  reference's height in the same frame. The scoring symptom: noisy and
  inconsistent per-joint deltas because the inputs to the angle
  formulas come from anisotropic coordinate systems whose torso-unit
  length differs.
- **Positions in skill-graph success criteria are not body-relative.**
  `measurable_success_criterion` strings in
  `public/data/knowledge_graph.json` include hard-coded meter
  thresholds ("root.x within 0.05 m of right_ankle.x",
  "head.x translates by at least 0.08 m"). A short user and a tall user
  meet these criteria at different effective body proportions; for a
  child or a very tall adult the thresholds are effectively wrong.

The Stage 2-7 work in this doc addresses both items: a single
canonicalization chokepoint (translate + scale to a unit torso-length
body frame) feeding angle-space comparison, plus a body-relative
re-evaluation of the position criteria from the skill graph.

## Comparison sites

Every place in the codebase where two skeletons (or their
joint-angle reductions) are compared, audited against three properties
the fix needs to provide:

| Site | Translates to pelvis-origin? | Scales by torso length? | Comparison primitive |
|---|---|---|---|
| `lib/scoring/dtw.ts:46` — `euclidean(user[i], reference[j])` as DTW local cost | implicit only (angle math is translation-invariant when the input landmarks come from the same image); not enforced upstream | implicit only via angle scale-invariance; not enforced upstream | joint angles + 2D-zeroed depth fields |
| `lib/scoring/scorer.ts:147` — `cosineSimilarity(userF.vector, refF.vector)` | implicit only | implicit only | joint angles (cosine over the 11-dim vector) |
| `lib/scoring/scorer.ts:148` — `compareFrame(userF.vector, refF.vector, jointWeights)` | implicit only | implicit only | per-joint absolute angle delta with tolerance band |
| `lib/scoring/referenceFrames.ts:88` — `compute2DJointAngles(mirrored)` building the reference stream | no — operates on raw worker-produced image landmarks, only mirror-flipped | no | produces joint-angle vector |
| `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx:341,361` — live readout: `compute2DJointAngles(res.landmarks)` then `cosineSimilarity(vec, refVec)` | no — operates on raw MediaPipe image landmarks | no | joint angles |
| `app/dance/[danceId]/full/page.tsx:212,215` — live readout for full-dance Mode B | no | no | joint angles |
| `app/drill/[skillId]/page.tsx:151,153` — Mode A drill live readout | no | no | joint angles |
| `lib/pose/normalize.ts` — `normalizeToBody` already exists but is only used by the dual-skeleton overlay drawing path, not by scoring | yes (hip-mid origin) | yes (shoulder-to-hip = 1) | n/a — outputs landmarks not angles |
| `public/data/knowledge_graph.json` criterion strings | n/a | n/a | absolute meters (e.g. "root.x within 0.05 m of right_ankle.x") — NOT body-relative |

### Findings

1. **Every angle-comparison site relies on the "angles are invariant"
   property holding for landmarks that come from differently framed
   images.** That assumption is fine in pure geometry but breaks down
   when image aspect ratios differ between user camera and reference
   video — pixel-space x and y are anisotropic units in MediaPipe's
   normalized landmark output. We need a single chokepoint that
   converts to an isotropic, body-unit coordinate system before angle
   math runs.

2. **`normalizeToBody` (shoulder-to-hip = 1, hip-mid origin) already
   exists** and is exactly the canonical body frame the spec asks for —
   but it's only used by skeleton rendering, never by scoring. Stage 2
   either re-uses or supersedes it; per the spec we add a new
   `canonicalizeSkeleton` and re-route every scoring entry point
   through it. The render path is updated to use the same canonical
   skeleton, so the "user 2x the reference size" visual bug
   disappears as a side effect.

3. **The DTW local cost is Euclidean over the 11-dim angle vector.**
   That mixes 8 anatomical-angle joints (range 0-180°), 2
   body-orientation angles (range -180°-180° for `hip_rotation_y`, 0-90°
   for `torso_lean`), and one displacement (`chest_forward_z` in
   meters). In 2D mode we zero the depth fields so the unit mix
   reduces, but a per-joint weighted angle distance — built on
   canonicalized angles — is a cleaner local cost than raw Euclidean.

4. **Skill-graph criteria are in absolute meters.** Stage 5 converts
   them at runtime to body-relative thresholds using the user's
   torso_length from canonicalization. The criterion evaluator becomes
   the single place those meter→torso-length conversions happen.

## Math changes

(Filled in over Stages 2-5 as the code lands.)

### Stage 2 — Canonicalization (translate + scale)

`canonicalizeSkeleton(rawLandmarks)` translates every landmark by the
negative of the pelvis midpoint (midpoint of LEFT_HIP=23 and
RIGHT_HIP=24), then divides by the torso length (Euclidean distance
from pelvis midpoint to shoulder midpoint, where shoulder midpoint =
midpoint of LEFT_SHOULDER=11 and RIGHT_SHOULDER=12). After this:

- pelvis midpoint = (0, 0, 0)
- torso length = 1.0
- shoulder midpoint sits on the body's vertical axis at distance 1 from
  the origin

If `rotateToUpright` is passed, the skeleton is further rotated 2D so
the shoulder line is horizontal; default OFF (angle space handles most
rotation invariance for free; rotation only matters when we want a
canonical render orientation).

Degenerate frames (torso length < 0.05 in input units, or missing
required landmarks) return null. Callers treat null as a dropped
frame.

### Stage 3 — Joint-angle vector from canonical skeleton

`jointAnglesFromCanonical(c)` in `lib/pose/jointAngles.ts` (added as a
parallel exporter — the legacy `JointAngleVector` is unchanged).
Returns an 11-dim radian vector + per-joint confidence:

- `leftElbow`, `rightElbow` — angle at the elbow vertex
- `leftShoulder`, `rightShoulder` — angle at the shoulder, between
  shoulder→hip and shoulder→elbow
- `leftHip`, `rightHip` — angle at the hip, between hip→shoulder and
  hip→knee
- `leftKnee`, `rightKnee` — angle at the knee vertex
- `torsoLean` — angle between world-up (0, -1) and the
  pelvis→shoulderMid vector
- `shoulderTilt` — angle between horizontal (1, 0) and the
  left→right shoulder line
- `hipTilt` — angle between horizontal (1, 0) and the left→right
  hip line

All angles in [0, π]. Per-joint confidence = min(visibility of the
landmarks used in that joint's computation), in [0, 1]. The scorer
treats per-joint confidence below 0.30 as "this frame's signal on
that joint is too noisy to score" and drops the contribution.

Why these specific angles: they cover the four major limb
articulations (elbows, shoulders, hips, knees), the spine alignment
(torsoLean), and the two body-frame tilts (shoulderTilt for body roll
/ chest iso, hipTilt for hip iso). Maps directly onto the skill
graph's success-criterion vocabulary.

### Stage 4 — Scorer rewire

`scoreSession` in `lib/scoring/scorer.ts` now dispatches on which set
of input frames was provided:

- **`userLandmarkFrames` + `referenceLandmarkFrames`** (new path,
  what production uses): canonicalize → joint angles → compare. Per
  SPECK §4.2:
  - `per_joint_score[j] = max(0, 1 − (|a_u[j] − a_r[j]| / TOL[j])²)`
  - `frame_score = Σ(w[j] · per_joint_score[j]) / Σ w[j]`
  - tolerances (radians): 0.35 for limb joints, 0.20 for torsoLean,
    0.25 for shoulderTilt / hipTilt
  - weights variance-driven from the reference angle sequence
    (`deriveCanonicalJointWeights`)
- **`userFrames` + `referenceFrames`** (legacy vector path): the
  pre-existing per-joint comparison runs unchanged. Kept so the
  legacy unit tests, the synthetic-reference fallback (for dance
  rows without pose JSON), and the scorer.test.ts suite all keep
  passing.

Components (Arms / Legs / Body / Timing) and trouble-spots are
re-implemented for the canonical path:

- Arms = mean per-joint score of leftElbow + rightElbow +
  leftShoulder + rightShoulder
- Legs = mean per-joint score of leftHip + rightHip + leftKnee +
  rightKnee
- Body = mean per-joint score of torsoLean + shoulderTilt + hipTilt
- Timing = `1 − mean(|u_i / (N-1) − r_i / (M-1)|) / TIMING_TOLERANCE`
  along the DTW warp path. `TIMING_TOLERANCE = 0.10` (10% off-diagonal
  collapses timing to 0).

Trouble spots: same 1.5s non-overlapping window algorithm. Worst-joint
attribution maps canonical joints back to the legacy `JointName`
vocabulary so the existing trouble-spot UI dictionary lookup keeps
working (shoulderTilt / hipTilt fall back to the `torso` pretty-name).

All tolerances + the timing-tolerance live at module scope as named
constants (SPECK Hard Rule #7) so the next calibration pass against
real recordings can tune them without spelunking.

### Stage 5 — Body-relative criterion evaluator

`evaluateCriterion(criterionString, userSeries, refSeries, bpm, opts?)`
in `lib/graph/criteriaEvaluator.ts`. Pattern-matches the criterion
string against a small set of supported shapes and returns
`{ passed, evidence }`.

Supported patterns:
- `elbow angle > N°` — body-invariant; checks max observed elbow angle
  across the user series against the threshold (radians).
- `knee angle between A° and B°` — body-invariant; checks the min/max
  knee angle across the user series stays inside the band.
- `(left|right)_wrist.x − (left|right)_shoulder.x > N m` — converts
  the meter threshold to torso-lengths using
  `referenceTorsoLengthM` (default 0.50 m) and compares against the
  canonical-space lateral wrist extension (which is already in
  torso-length units).
- `ankle … rises N m` / `ankle … above … N m` — converts the meter
  threshold to torso-lengths and compares against the observed ankle
  rise (canonical y is +DOWN, so rise = baseline_y − min_y).
- `DTW score ≥ X%` (whole-routine, "meta") — returns `passed=true`
  with an explanatory evidence string; the scorer's overall already
  measures this.

Unsupported criteria — followup:
- Velocity / timing-window criteria ("velocity > 0.6 m/s within 120
  ms"). Need per-frame velocity from the canonical landmark stream.
- Shoulder-roll loop closure ("trace of (shoulder.y, shoulder.z)
  forms a closed loop with circumference > 0.15 m"). Needs
  trajectory-based geometry.
- Body-wave timing chains ("head.z peak at t1, shoulder_mid.z at t2,
  ..."). Needs phase-detection on the canonical position series.
- Multi-beat composite criteria (most of the routine-level skill
  scripts, e.g. `dynasty_combo_a`, `dynasty_combo_b`).
- Cross-step / two-step ankle.x ordering checks.

Anything in this list returns `{ passed: true, evidence: 'criterion
not yet supported' }` and logs a console warning, which is the
graceful-degradation path SPECK Stage 5.4 calls for.

## Calibration tests

The Stage 6 calibration suite (`tests/scoringCalibration.test.ts`) is
split into two groups:

**Legacy suite (`mode-b calibration`)** — built before this PR. Uses
synthetic pre-canonicalized angle vectors of identical body size on
both user and reference sides. Catches: the synthetic-reference
regression, the variance-weighting regression, the trouble-spot
regression. Kept as-is so the previous rebuild's invariants don't
silently drift.

**Body-size invariance (`mode-b calibration — body-size invariance
(Stage 6)`)** — added in this PR. Feeds raw LANDMARK frames into
`scoreSession` so the canonical-angle pipeline actually runs. Each
test catches a specific bug class:

- `half_scale_perfect` — user landmarks = reference scaled by 0.5x.
  Expected ≥ 95. **Catches the "user skeleton renders 2x reference
  size" bug.** If canonicalization isn't translating + scaling
  consistently, the scores diverge because the angle inputs come
  from inconsistent coordinate systems. With the chokepoint working,
  scaled inputs canonicalize to the same body frame and the score is
  100.
- `double_scale_perfect` — same idea, 2.0x scale. Expected ≥ 95.
- `translated_perfect` — user landmarks = reference + (Δx, Δy) image
  offset. Expected ≥ 95. **Catches the "user dances at a different
  position in the frame than the reference" bug.** A pre-Stage-2
  scorer would treat translation as joint deviation; the canonical
  chokepoint removes it.
- `rotated_5deg_perfect` — shoulder line rotated 5° vs reference.
  Expected ≥ 90 (small penalty acceptable — the 5° propagates into
  shoulderTilt + hipTilt, which is the system's correct response).
- `half_scale_wrong` — 0.5x scale BUT arms in wrong position.
  Expected ≤ 40. Validates that body-size invariance does NOT also
  smuggle in any "everything looks correct because we normalized"
  false positive.
- `half_scale_8deg_noise` — 0.5x scale + Gaussian joint noise.
  Expected 55–85. Mid-band "real-life competent attempt with sensor
  jitter on a short user" — passes the calibration but isn't perfect.

The first two — `half_scale_perfect` and `translated_perfect` — are
the spec's named acceptance tests. They prove the shipped bug class
is fixed.

## Known limitations

- **Rotation invariance is partial.** `canonicalizeSkeleton` accepts
  a `rotateToUpright` flag but defaults to off. The angle-space
  comparison is invariant to most rotation by construction (angles
  don't care about absolute orientation) except for `torsoLean`,
  `shoulderTilt`, and `hipTilt` which are measured against world
  axes. A 5° body rotation deducts up to ~10 points from the body
  component; a larger rotation deducts more. If real-world testing
  shows this is the dominant error mode, flip `rotateToUpright` on
  in the production scorer path.
- **Criterion-parser coverage is intentionally narrow.** See the
  "Unsupported criteria — followup" list above. Anything outside the
  supported set returns "passed: true, evidence: not yet supported"
  rather than throwing.
- **Reference torso length is a constant (0.50 m).** The
  meter→torso-length conversion in `evaluateCriterion` assumes the
  reference dancer has a typical-adult torso. Routine metadata
  could carry per-routine torso length and override the constant;
  not in scope for this PR.
- **Mode C (full-routine) page is on the legacy vector path.** It
  doesn't load real reference pose data — its reference is the
  synthetic neutral-pose generator, which doesn't benefit from
  canonicalization. Migrating Mode C to real reference + canonical
  pipeline is a separate scope item.
- **Manual UI verification was not performed.** The test
  harness is headless; running the dev server and confirming the
  DualSkeletonOverlay rendering in a real browser is left to the
  human-loop step at the end of this PR. `DualSkeletonOverlay`
  itself already uses `normalizeToBody` (translate + scale) for
  drawing, so the canonical sizing property holds at the render
  layer regardless of which scoring pipeline is wired up.

## Why we did NOT swap pose models in this PR

Tracked separately; the symptom — body-size disparity between user and
reference — is a coordinate-system bug, not a tracker-accuracy bug.
Swapping MediaPipe Pose Landmarker for RTMPose-via-Modal is being
evaluated as its own decision because it changes hosting cost,
mobile-port path, and latency profile. Keeping it out of this PR
preserves scope: this PR fixes the math layer that broke; the model
choice is decided on its own merits.
