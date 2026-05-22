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

(filled in at Stage 3.)

### Stage 4 — Scorer rewire

(filled in at Stage 4.)

### Stage 5 — Body-relative criterion evaluator

(filled in at Stage 5.)

## Calibration tests

(Filled in at Stage 6 — including which test catches which bug class.)

## Known limitations

(Filled in at Stage 7.)

## Why we did NOT swap pose models in this PR

Tracked separately; the symptom — body-size disparity between user and
reference — is a coordinate-system bug, not a tracker-accuracy bug.
Swapping MediaPipe Pose Landmarker for RTMPose-via-Modal is being
evaluated as its own decision because it changes hosting cost,
mobile-port path, and latency profile. Keeping it out of this PR
preserves scope: this PR fixes the math layer that broke; the model
choice is decided on its own merits.
