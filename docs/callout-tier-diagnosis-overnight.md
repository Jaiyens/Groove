# Callout tier diagnosis — overnight run

## Question

The `[callout-engine][beat]` logs from tonight's validation showed `windowMax` clustered between 0.95 and 0.999 with the per-beat tier almost always GROOVY or PERFECT. SPECK overnight Group 5 asked: is the similarity stream saturated, or are the thresholds wrong?

## Verdict

**Diagnosis (A): Similarity saturated.** The per-frame similarity that feeds `calloutEngineRef.current?.ingestFrame` is `cosineSimilarity(userVector, refVector)` where both vectors are joint-angle vectors (radians). Cosine similarity over angle vectors is structurally biased high — a pair of normal human poses almost always scores ≥ 0.95 regardless of how well the user is copying the reference.

The window-max trick (Diagnosis B) does pick the highest sample in ±150ms but the same saturation applies to every sample. The thresholds (Diagnosis C) are not obviously miscalibrated; they were tuned for a metric that was assumed to range over 0.6–1.0, but the actual metric ranges over 0.95–1.0.

## Evidence chain

1. **Live call site.** `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx:546-556` computes the similarity it feeds to the callout engine:

    ```ts
    const sim = cosineSimilarity(vec, ref);
    // ...
    calloutEngineRef.current?.ingestFrame({
      timestamp: sessionT,
      similarity: Math.max(0, sim),
    });
    ```

   `vec` and `ref` are both `JointAngleVector` instances (see step 2).

2. **The vector being scored.** `lib/pose/jointAngles.ts:94-117` builds the `JointAngleVector` as an 11-keyed record:

    ```
    left_elbow, right_elbow,
    left_shoulder, right_shoulder,
    left_hip, right_hip,
    left_knee, right_knee,
    torso_lean, hip_rotation_y, chest_forward_z
    ```

   The eight named joint angles are computed via `angleAt(a, b, c)` (the interior angle at vertex `b`) — always non-negative, in **[0, π]** radians. For a person standing or moving naturally these cluster in a tight range:

   - elbows: **~1.5–3.0** (bent → straight)
   - shoulders: **~0.3–2.5** (arms-down → arms-up)
   - hips: **~2.5–3.0** (standing)
   - knees: **~2.5–3.0** (standing/dancing)
   - torso_lean: **~0.0–0.5** (mostly upright)

   `hip_rotation_y` and `chest_forward_z` are typically small numbers, sometimes negative.

3. **Cosine similarity on two such vectors.** With `cosineSimilarity(a, b) = (a·b) / (‖a‖·‖b‖)`, if both vectors have most of their mass on the same axes (joint angles all positive, all clustered around 1.5–3.0), the dot product is dominated by those shared-direction components even when individual joint angles differ substantially.

   Quick worst-case sanity check: imagine the user's `left_elbow` is at 1.5 (bent) and the reference's is at 3.0 (straight). The other 7 joints match exactly with magnitudes around 2.5. Per-axis contribution to `dot`: one term is `1.5 × 3.0 = 4.5` instead of `3.0 × 3.0 = 9.0` — a 50% reduction on one axis. But that axis is one of eight and the rest contribute `~6.25` each. So `dot ≈ 4.5 + 7×6.25 ≈ 48.25` vs `‖a‖·‖b‖ ≈ √(8×6.25)·√(2.25 + 7×6.25) ≈ 7.07·6.95 ≈ 49.16`. Cosine ≈ **0.981**.

   A whole limb being in the wrong position barely scratches the metric. The user's body keeps the rest of the vector pointed in roughly the same direction in 11-D space, so the angle between the two vectors stays close to zero.

4. **The post-attempt scorer DOES NOT have this problem.** `lib/scoring/scorer.ts:184-188` computes the *displayed* score via `compareFrame(userF.vector, refF.vector, jointWeights)` — a per-joint, weighted comparison whose individual terms respond to per-joint angle differences. The cosine on the same line is kept around only to populate the legacy `FrameScore.similarity` field; the scoring decision uses `cmp.overall * 100`. So the post-attempt verdict has been honest while the live callouts have been saturated, which matches what tonight's logs showed.

5. **The threshold story is downstream of all this.** `CALLOUT_THRESHOLDS.GROOVY = 0.88` would be a sensible threshold for a metric that actually varies in 0.6–1.0. For a metric that lives in 0.95–1.0, every threshold above 0.5 saturates GROOVY.

## Why (B) and (C) don't apply

- **(B) Window too generous.** Even at ±10ms the per-frame samples would still be 0.95–0.999. Tightening the window or switching to median doesn't change the underlying signal.
- **(C) Thresholds too low.** Bumping GROOVY to 0.97, PERFECT to 0.92, GREAT to 0.85 would push *some* beats into PERFECT/GREAT but the saturation noise floor is ~0.95, so a meaningful spread is impossible without changing the metric.

## Proposed fix (shipped as a separate `experimental(callout-tier):` commit)

Replace `cosineSimilarity` in the callout call-site with a per-joint **angular agreement** score:

```ts
function jointAngleAngularSimilarity(a, b): number {
  const keys = [
    'left_elbow', 'right_elbow',
    'left_shoulder', 'right_shoulder',
    'left_hip', 'right_hip',
    'left_knee', 'right_knee',
  ] as const;
  let sum = 0;
  for (const k of keys) {
    const d = Math.abs((a[k] ?? 0) - (b[k] ?? 0));
    sum += Math.max(0, 1 - d / Math.PI);
  }
  return sum / keys.length;
}
```

Each joint contributes `1 - |Δangle| / π` to the mean. Predicted bands at the current `CALLOUT_THRESHOLDS`:

| Avg per-joint error | Similarity | Tier              |
|---------------------|------------|-------------------|
| ~10° (0.175 rad)    | ~0.944     | GROOVY            |
| ~30° (0.524 rad)    | ~0.834     | PERFECT           |
| ~60° (1.047 rad)    | ~0.667     | GREAT             |
| ~90° (1.571 rad)    | ~0.500     | ALMOST            |

This is the response curve the existing tier thresholds were *intended* for. PERFECT becomes the modal tier for a sincere copy, with GROOVY peaks when the user nails an accent beat and ALMOST when the user misses one outright. Matches the SPECK callout-engine module comment: *"A sincere attempt should fire mostly PERFECT/GREAT with occasional GROOVY peaks."*

Why excludes `torso_lean`, `hip_rotation_y`, `chest_forward_z`: torso_lean is a tiny near-zero angle (noise dominates), and the two depth fields are zeroed when the user pipeline is running 2D landmarks (see `compute2DJointAngles`). Keeping them in the mean would pull every sample close to 1.0 and partly re-introduce the saturation we're escaping.

## What can't be verified overnight

- The proposed similarity function's actual distribution on a real attempt. The exponent (`1 - d/π`) is the simplest sensible mapping but a sigmoid or piecewise-linear scaling might be tighter. Treat the experimental commit as a starting point — the next field run should produce a `[beat]` log with windowMax samples spread across the full 0–1 range, not piled up at one end.
- Whether per-joint **weighting** (the `deriveJointWeights` machinery in `scorer.ts`) would further sharpen the tier spread for the live callouts. Worth trying if the unweighted mean still skews to one tier.

## Acceptance against the spec

- ✓ `/docs/callout-tier-diagnosis-overnight.md` identifies diagnosis (A).
- ✓ Diagnosis cites file paths and lines, walks through the saturation math.
- ✓ Fix is shipped in its own commit tagged `experimental(callout-tier):` per the spec.
