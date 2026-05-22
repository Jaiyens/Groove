# Mode B scoring — diagnostic findings

Investigation done before any code changes. Tracing the live Mode B pipeline
end-to-end (see `scoring-trace.md`) revealed why a competent dancer is
scoring 18/100.

## What works

- **Camera + extractor lifecycle** is stable. PoseExtractor is initialized
  once per camera grant and reused. Detection is reliable on a modern phone
  at 30 fps using `pose_landmarker_full.task` on GPU
  (`lib/pose/poseExtractor.ts:21-22`).
- **Joint-angle math** is correct (`lib/pose/jointAngles.ts`). 8 anatomical
  angles + torso lean + hip rotation + chest forward displacement. Uses
  world landmarks, which are already roughly normalized (hip-midpoint
  origin, meters).
- **DTW** algorithm is correct (`lib/scoring/dtw.ts`). Sakoe-Chiba band is
  set to 10% of the longer sequence; the band is wide enough that scoring
  won't get jammed if the user is slightly off-beat.
- **Beat grid + chunk-aligned timestamps** are correct. User frames are
  tagged with absolute routine timestamps and aggregated to beats with the
  dance's known BPM.
- **The skeleton overlay drawing for the user** (`SkeletonOverlay.tsx`) is
  visually correct: handles object-fit cover, CSS-mirror, DPR, and stale
  frames.
- **A real pose-JSON loader exists** for reference data
  (`lib/pose/referencePose.ts`) and is used in Mode A for the
  "show skeleton" overlay. Sidecar JSON is produced by the worker.

## What is broken

### KILLER BUG #1 — Reference is synthetic. Severity: CRITICAL.

`lib/scoring/syntheticReference.ts:27-39` —
`neutralReferenceFrame(t, bpm)` returns a fixed "neutral standing upright"
pose with tiny (~±4°/±8°) on-beat oscillation. This is the reference Mode B
is scoring against. **Mode B never loads the real reference pose data,
even though that data exists for every dance.**

- `dance.pose_data_url` from the backend is unused inside the test page.
- `app/.../test/page.tsx:326` calls `neutralReferenceFrame(...)` instead.
- `app/.../test/page.tsx:364` calls `generateReferenceSequence(...)` for
  the final aggregate score. Still synthetic.

A user who is actually dancing is being penalized for not standing
perfectly still. A user who stands still is being rewarded. This alone
explains the 18/100 result for a competent attempt.

### KILLER BUG #2 — No mirror between camera frame and reference. Severity: HIGH.

The camera is selfie (`facingMode: 'user'`). Both video and skeleton are
CSS-mirrored on render (`scaleX(-1)`) so the user sees themselves in a
"mirror" view. But the underlying MediaPipe landmarks are NOT
horizontally flipped — `left_shoulder` is whichever shoulder MediaPipe
detects on its left in the unmirrored frame. When the reference dancer
(filmed normally, facing camera) raises their *anatomical* right hand,
that hand appears on the LEFT side of the screen, so MediaPipe labels it
LEFT_SHOULDER. The user mirroring the move raises their *anatomical*
right hand (which is on the user's screen RIGHT after mirror) — MediaPipe
in the unmirrored camera frame sees it on the screen LEFT, so labels it
LEFT_SHOULDER too. The labels coincidentally match! BUT:

- For the user, "left_shoulder" in the JointAngleVector = anatomical
  RIGHT shoulder.
- For the reference (extracted from a normal-orientation video),
  "left_shoulder" = anatomical LEFT shoulder.

So we're comparing the user's anatomical RIGHT shoulder to the
reference's anatomical LEFT shoulder. Once we hook the real reference
data up, this asymmetry will silently halve the score.

Fix: when extracting the user joint-angle vector from a mirrored camera
input, swap left/right names. We must do this consistently.

### KILLER BUG #3 — No coordinate normalization on top of MediaPipe. Severity: MEDIUM-LOW.

MediaPipe world landmarks already use hip-midpoint origin in meters, so
position is implicitly normalized for translation. The scoring is on joint
*angles* not positions, so scale invariance is also automatic. This is
actually OK — angles are invariant to camera distance / body size, which
is exactly why the joint-angle vector was chosen. No fix needed here; the
spec's STAGE 3 step 2 is already handled by virtue of using angles.

### KILLER BUG #4 — Frame-score decay is far too aggressive. Severity: HIGH.

`lib/scoring/scorer.ts:35` — `FRAME_SCORE_DECAY = 5`.
`frameScoreFromSimilarity(s) = 100 * exp(-(1-s)*5)`.

For joint-angle vectors with O(10) dimensions and degrees in the tens to
hundreds, cosine similarity between a real-dance frame and a reasonable
reference frame typically lands 0.85-0.97 even when the dance is well
executed. The decay maps that to a 37-86 range — penalising honest dance
attempts. A small misalignment costs disproportionately because exp grows
fast.

For a 0-100 score that should be readable as "how close are you", we
want sim≈0.95 → ~85, sim≈0.85 → ~65, sim≈0.5 → ~20. Switch to a
calibrated linear/piecewise mapping rather than a steep exponential.

### KILLER BUG #5 — Euclidean DTW local cost mixes units. Severity: LOW-MEDIUM.

`lib/scoring/dtw.ts:46` uses `euclidean(userVec, refVec)` over the raw
11-dim vector. 8 of those dims are degrees (0-180 range), 2 are degrees
(torso, hip rotation), 1 is meters (chest_forward_z, ~0). Degrees vastly
dominate the distance — chest_forward_z effectively contributes nothing.
That's fine for the prototype, but if anyone bumps `chest_forward_z` to
cm later we'll get weird scale drift.

### MISSING — No per-joint or per-component breakdown surfaced. Severity: HIGH.

`SessionScore.perSkillScores` exists but is fed an empty `chunk.skills`
list in the typical dance fixture. The current results UI doesn't show it
either. There is no Arms / Legs / Timing / Body decomposition exposed
anywhere — which is what the spec calls for in Stages 4-5.

### MISSING — No trouble-spot identification. Severity: HIGH.

`SessionScore.frames` has the per-frame scores, but nothing computes
local minima or "the 2-3 worst seconds". The product spec needs this for
the drill-mode loop.

### MISSING — No drill-mode integration. Severity: HIGH.

The spec wants tapping a trouble-spot to route into Mode A with `?from`,
`?to`, `?loop`, `?speed` query params. Mode A currently doesn't honor
those.

### MISSING — Results-screen copy is hardcoded. Severity: MEDIUM.

`'Almost there'` is rendered for every failing score
(`app/.../test/page.tsx:564`), even an 18. `'threshold 70'` is dev
language.

## Severity rollup

| Bug | Severity | Type |
|---|---|---|
| Reference is synthetic, not real | CRITICAL | correctness |
| No left/right swap for mirrored user | HIGH | correctness |
| Frame-score decay too steep | HIGH | tuning |
| No trouble-spots / drill loop | HIGH | missing feature |
| No component breakdown surfaced | HIGH | missing feature |
| Euclidean DTW unit-mix | LOW | latent |
| Results-screen copy/UX | MEDIUM | UX |

## Rebuild scope

Partial rewrite — the lifecycle, extractor, DTW algorithm, joint-angle
math, and beat tracker are all keepers. We need to:

1. Stop using `neutralReferenceFrame` / `generateReferenceSequence` in
   Mode B; load the real reference pose stream via `pose_data_url` and
   convert frames to `JointAngleVector`s using `computeJointAngles` on the
   world-landmarks side.
2. Mirror the user's joint-angle vector (swap left/right joint names) so
   it lines up with a normally-oriented reference.
3. Replace the exponential frame-score mapping with a calibrated linear
   one.
4. Weight joints by per-chunk movement importance (auto-derived from
   reference variance).
5. Compute Arms / Legs / Timing / Body component scores from the same
   DTW path.
6. Compute the 2-3 worst-scoring windows from `SessionScore.frames`.
7. Build the drill-mode URL params into Mode A.
8. Rebuild the results popup to surface all of this.

The infrastructure stays. The math swaps. The UI grows.
