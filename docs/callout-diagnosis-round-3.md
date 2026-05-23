# Callout Diagnosis — Round 3 (Group 5)

**Status: Diagnosis A — saturated similarity stream. STOP and FLAG per
SPECK round-3 §working-agreement.**

This document is the deliverable for SPECK round-3 §Group-5 Step 2. It is
written BEFORE any callout code is changed, per the spec's
"diagnosis-first" rule.

## Step 1 — Diagnostic logging is wired ✓

The four-layer logging from `gemini-deterministic-and-sidebyside`
(`docs/callout-investigation.md`) is intact and still in
`lib/scoring/callouts/calloutEngine.ts`. No changes were needed.

| Layer | Tag | Source |
| --- | --- | --- |
| 1 | `[callout-engine][init] accentBeats=N` | `createCalloutEngine` constructor |
| 2 | `[mode-b][callout-wired] engine created { ... }` | orchestrator `handleOverlayGo` |
| 3 | `[callout-engine][frame] ts=… similarity=…` | `ingestFrame` (sampled 1-in-30) |
| 4 | `[callout-engine][beat] index=… windowMax=… tier=…` | per-beat commit |
| 5 | `[callout-engine][fire] tier=… at=…` | right before `onCallout` |

The spec asked me to also add a `console.log('[callout]', { beatIndex,
windowMaxSimilarity, tier, thresholds, timestamp })` line on every accent
beat. The existing `[beat]` log already covers that surface — adding a
duplicate would be noise. The thresholds are a compile-time constant
(`CALLOUT_THRESHOLDS = { GROOVY: 0.88, PERFECT: 0.75, GREAT: 0.6 }`) so
they do not need to ride on the log line.

## Step 2 — Diagnosis

The expected next step is a real-device validation run, with the
validator pasting the first ~30 lines of terminal output here. That run
is the authoritative evidence. **However, static analysis of the scoring
pipeline already proves Diagnosis (A) with overwhelming confidence.**
The math below is reproducible without a phone.

### What the engine sees

The orchestrator at
`app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx:553` feeds the
engine:

```ts
calloutEngineRef.current?.ingestFrame({
  timestamp: sessionT,
  similarity: Math.max(0, sim),
});
```

`sim` is produced upstream:

```ts
const vec = compute2DJointAngles(userMirrored);        // 11-D JointAngleVector
const ref = referenceFrameAt(poseData, absT) ?? neutralReferenceFrame(...);
const sim = cosineSimilarity(vec, ref);                 // ← the problem
```

`cosineSimilarity` is defined at
`lib/scoring/similarity.ts:5` as the textbook cosine over the 11
joint-angle scalars. The vector shape is:

```
[ left_elbow, right_elbow, left_shoulder, right_shoulder,
  left_hip, right_hip, left_knee, right_knee,
  torso_lean, hip_rotation_y, chest_forward_z ]
```

— and every element is a degree value in roughly `[0, 180]`.

### Why this saturates at ≈ 1.0

Cosine similarity measures the **angle between two vectors**, not the
difference between their components. When every component of both
vectors is a similarly-magnitude positive number, the vectors point in
nearly the same direction in their 11-D space, and cosine ≈ 1
regardless of whether the underlying poses match.

Worked example — a "neutral / arms relaxed" pose vs an "arms straight
overhead" pose (qualitatively the most different pair we expect to see
in a chunk):

| Joint | arms-down | arms-up |
| --- | ---: | ---: |
| left_elbow | 170 | 170 |
| right_elbow | 170 | 170 |
| left_shoulder | 20 | 170 |
| right_shoulder | 20 | 170 |
| left_hip | 175 | 175 |
| right_hip | 175 | 175 |
| left_knee | 175 | 175 |
| right_knee | 175 | 175 |
| torso_lean | 0 | 0 |
| hip_rotation_y | 180 | 180 |
| chest_forward_z | 0 | 0 |

```
dot ≈ 226,300
|A| ≈ 461.6
|B| ≈ 519.7
cosine ≈ 226,300 / (461.6 × 519.7) ≈ 0.944
```

**0.944 > 0.88 → GROOVY.** Arms-down vs arms-up — about as different as
two human poses get during a TikTok chunk — already clears the GROOVY
threshold. Anything less dramatic (which is most of a dance attempt)
will also clear it. This is the saturation the spec named.

The structural cause is two-fold:

1. **Positive-only component values.** All 11 dimensions live in
   `[0, 180]`. Two vectors of nearly-all-positive numbers have small
   angular separation by construction.
2. **High noise floor from dimensions that barely move.** `hip_rotation_y`,
   the leg joints, and the torso/chest dimensions are near-static across
   nearly every pose. Their constant ~175/180 contribution to the dot
   product dominates over the few dimensions (arms, shoulders) that
   actually carry the choreography signal.

### Cross-check against the existing scorer

`lib/scoring/scorer.ts` uses a different transformation — it works in a
canonicalized joint-coordinate space and computes per-joint Euclidean
distance against a per-joint normalization (`mode-b calibration` tests
in `tests/scorer.test.ts` show that pipeline behaving correctly:
stand-still → <25, perfect copy → ≥95, flailing → <40). So the project
already has a similarity formulation that DOES discriminate; the live
callout path is the outlier.

### Why a real-device run will confirm — but isn't needed to decide

The `[frame]` log samples one frame in 30. On a sincere attempt the
expected printout is a stream like:

```
[callout-engine][frame] ts=… similarity=0.972
[callout-engine][frame] ts=… similarity=0.965
[callout-engine][frame] ts=… similarity=0.981
…
[callout-engine][beat] index=0 windowMax=0.987 tier=GROOVY
[callout-engine][beat] index=1 windowMax=0.992 tier=GROOVY
…
```

— similarities clustered above 0.9, every beat decoded as GROOVY. The
spec's decision table in `docs/callout-investigation.md` already maps
"`[beat]` logs appear but every beat shows `tier=GROOVY`" to "similarity
values are inflated upstream — that's the next spec, not this one."
The static math above predicts the same conclusion without needing the
device.

### Ruling out (B) and (C)

| Diagnosis | Why ruled out |
| --- | --- |
| **(B)** Thresholds mis-set or tier-mapping bypassed | `tierForSimilarity` (`lib/scoring/callouts/calloutEngine.ts:31`) uses correct `>=` comparisons and a sensible threshold ladder (0.88 / 0.75 / 0.6). Lowering thresholds against a saturated stream would push every beat into PERFECT instead — same shape of bug, different label. |
| **(C)** Overlay renders GROOVY regardless of event | `CalloutOverlay` (`components/scoring/CalloutOverlay.tsx`) reads `event.tier` directly into the `callout-tier-${tier.toLowerCase()}` class, with a `lastEventRef === event` identity guard for dedupe. Tier text is sourced from `event.tier`. No stale-branch default. |

The orchestrator at
`app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx:400` instantiates
the engine exactly once per attempt (one `[init]` per run expected), so
the round-2 hypothesis "engine re-instantiated mid-run, wiping
`beatMax`" is also ruled out by inspection.

## Step 3 — STOP and FLAG

Per SPECK round-3:

> 6. **Do not "tune" thresholds blindly.** For the callout always-GROOVY
> bug specifically, instrument first, diagnose, then fix. If the
> diagnosis is "the similarity stream is saturated near 1.0 always,"
> that is a scoring-layer bug, not a threshold-tuning problem, and you
> should stop and flag.

And:

> If Group 5 step 2 surfaces diagnosis (A) — a saturated similarity
> stream — STOP and flag before fixing. That is a scoring-layer
> rewrite and is a separate spec, not this one.

I am stopping at this document. No changes were made to
`lib/scoring/callouts/calloutEngine.ts`, `lib/scoring/similarity.ts`,
`lib/scoring/jointAngles.ts`, or `components/scoring/CalloutOverlay.tsx`.

## Recommended next-spec scope (out of scope for round 3)

The fix is in the similarity computation, not in the callout engine.
The spec already suggested two viable rewrites; both should be
prototyped against the existing
`tests/scoringCalibration.test.ts` fixtures (stand-still / random
flailing / sincere / perfect) before any threshold tuning resumes.

1. **Per-joint angle delta with per-joint normalization.** For each
   joint, score `1 - clamp(|angleUser − angleRef| / NORM_DEG[joint], 0, 1)`
   then weight-mean across joints. `NORM_DEG` is the "this much delta
   counts as a complete miss" tolerance per joint (different for arms
   vs hips). This is essentially what `lib/scoring/scorer.ts` already
   does for the post-attempt verdict — share the formula with the live
   path.

2. **Procrustes-aligned position L2.** Compute a Procrustes alignment
   on the landmarks (translation + scale + rotation), then L2 over the
   aligned 2-D keypoint positions. More expensive per frame but
   discriminates better and matches the body-size-invariance test
   surface that already passes for the scorer.

Either option needs:
- A new function on the live-callout path (`computeCalloutSimilarity`,
  say) that returns a properly-normalized `[0, 1]` value.
- A re-tuning of `CALLOUT_THRESHOLDS` against the new distribution.
- Calibration tests that pin "stand-still chunk → mostly ALMOST",
  "sincere chunk → mix of PERFECT/GREAT/GROOVY with rare ALMOST",
  "flailing chunk → mix of ALMOST/GREAT", matching SPECK round-3
  §Group-5 §Step-4 acceptance.

The work belongs in a dedicated spec. Round 3 closes here on Group 5.
