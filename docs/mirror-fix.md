# Mirror fix — Mode B handedness bug

## What shipped

The previous PR ("normalization + canonical angles") fixed body-size
invariance but missed the actual root cause of the score-correlation
symptom: the user's anatomical RIGHT was being compared against the
reference's anatomical RIGHT, not the reference's anatomical LEFT.
That's wrong for the "dance student mirrors teacher" framing.
Manually verified in the overlay: when the user raises their physical
right hand, the reference skeleton lifts the opposite side.

## What the right convention is

A dance student copying a teacher moves as a mirror. Teacher raises
her anatomical right → student raises their anatomical left (the
"facing" hand). The correct comparison:

- user's anatomical LEFT  ↔  reference's anatomical RIGHT
- user's anatomical RIGHT ↔  reference's anatomical LEFT

`mirrorLandmarksHorizontal` (in `lib/pose/normalize.ts`) negates
landmark x AND swaps the left/right index pairs (16 pairs:
LEFT_SHOULDER↔RIGHT_SHOULDER, LEFT_HIP↔RIGHT_HIP, etc.). After
applying it to one side of the comparison, the labels line up:
the user's anatomical right wrist now lives at index LEFT_WRIST, and
matches the reference's anatomical left wrist at index LEFT_WRIST.
Mathematically, applying the mirror to EITHER side is equivalent —
but per convention this project mirrors the USER side once, never the
reference.

## Mirror state audit

Every call site for `mirrorLandmarksHorizontal` and every place where
user landmarks enter the scoring or overlay paths, audited for which
side they touch and whether that's the right side:

| Site | Path | User mirrored here? | Reference mirrored here? | Notes |
|---|---|---|---|---|
| `lib/pose/normalize.ts:79` | def | n/a | n/a | The function itself: negates x AND swaps the 16 left↔right index pairs. Correct. |
| `lib/scoring/referenceFrames.ts:99` (`buildReferenceLandmarkSequence`) | SCORER | no | **yes** | WRONG side mirrored. Reference should never be mirrored. |
| `lib/scoring/referenceFrames.ts:109` (`vectorFromMirroredLandmarks` — used by `buildReferenceSequence` and `referenceFrameAt`) | SCORER (legacy vector path) | no | **yes** | Same wrong side. |
| `components/DualSkeletonOverlay.tsx:105` (default `mirrorReference=true`) | OVERLAY | no | **yes** | Same wrong side, but in the rendering path. |
| `lib/scoring/scorer.ts:102` (`mirrorJointAngleVector`) | def, unused in production | n/a | n/a | Vector-level mirror helper. Never called from the production scorer path. |
| `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx` user landmark push | SCORER (canonical path) | **no** | n/a | User landmarks go in raw — no mirror applied. With reference mirrored upstream, this net-effect IS the wrong-handedness bug. |
| `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx` user vector push | SCORER (legacy vector path) | no (vec built from raw landmarks) | n/a | Same. |
| `app/dance/[danceId]/full/page.tsx:213` | SCORER | no | n/a | Mode C; legacy path, synthetic reference, separate scope. |
| `components/SkeletonOverlay.tsx:166` | OVERLAY (single skeleton) | n/a — uses CSS `scaleX(-1)` on the canvas itself | n/a | The user's own skeleton overlay aligns via CSS mirror, not landmark mirror. Independent of this fix. |

## The bug, in one sentence

The reference is mirrored in THREE places (two scoring, one overlay)
and the user is mirrored in ZERO. Per the project convention (user
once, reference never), this is inverted: the fix is to strip all
three reference-side mirror calls and apply one mirror to the user
side at the entry of the scoring path.

## Wrong place — identified

Per SPECK §1.3, the "one wrong place" turned out to be option **(C):
mirror applied to the wrong side**. Both `referenceFrames.ts` and
`DualSkeletonOverlay.tsx` mirror the reference instead of the user.
Logically equivalent to mirroring the user IF the user side stays
unmirrored downstream — but that's a fragile convention that the
overlay broke, and the math is cleaner if we follow the documented
convention strictly.

## What the fix will do (next stages)

- Stage 2: lock the convention into the `mirrorLandmarksHorizontal`
  doc block. Verify the function is correct (it is).
- Stage 3: mirror user landmarks ONCE in
  `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx` at the
  point they're stored for scoring. Strip mirror calls from
  `buildReferenceLandmarkSequence`, `vectorFromMirroredLandmarks`,
  and `DualSkeletonOverlay`'s `mirrorReference` default.
- Stage 4: handedness unit tests that would have caught this.
- Stage 5: manual UI verification.

## Post-fix UI verification

Stage 5 of the SPECK mirror fix has three layers:

1. The **visual-handedness invariant** (Stage 5.2 equivalent) — that
   when the user raises their physical right hand, the reference
   skeleton's matching side moves in the overlay — is now
   programmatically asserted in `tests/mirror.test.ts`'s
   `overlay_handedness` suite. The positive test verifies user's
   raised wrist and reference's raised wrist land at canonical-x
   coords with the same sign (i.e., same screen side). The
   negative-control test fails if the chokepoint mirror is ever
   dropped, locking the fix against regression.
2. The **score rank-order invariant** (Stage 5.3 equivalent) — that
   good > bad > still with meaningful gaps — is now asserted in the
   `score_rank_order` suite. Standing still scores ~22, random
   arm flailing scores ~32, mirror-copy with light noise scores 95+.
   The test enforces a ≥7-point gap between still and bad and a
   ≥15-point gap between bad and good.
3. The **manual eyes-on confirmation** — the part the agent cannot
   perform with a real camera — still needs a human running the dev
   server. Protocol below. The first two layers reduce the manual
   check from "the bug is fixed or it isn't" to "let me sanity-check
   that the fixed system behaves as the tests claim".

### Handedness check

1. `npm run dev`. Open Mode B for the Golden chunk.
2. Raise your physical RIGHT hand. The reference skeleton in
   DualSkeletonOverlay should raise the side that visually
   corresponds to your right hand (which, because the camera video
   is CSS-mirrored on display, is the same screen-side as your
   physically raised right hand).
3. Raise your physical LEFT hand. Same check, opposite side.
4. Wave one hand. The reference skeleton's matching hand should be
   moving on the matching screen-side in the overlay.

If any of those checks shows the OPPOSITE side moving on the
reference skeleton, the chokepoint mirror is wrong-handed and Stage
3 needs to be debugged before this PR is done.

### Score check

Do three Golden-chunk attempts and record the overall score:

| Attempt                     | Score |
|---|---|
| Stand still, hands at sides | (fill in) |
| Bad attempt — wrong moves   | (fill in) |
| Real attempt — best you can | (fill in) |

The rank-order should be obvious: good > bad > still, with meaningful
gaps between them (not 50 / 48 / 46). If the rank-order is right but
the absolute numbers feel low, that's a tolerance-calibration
followup, not a mirror-fix regression — note it in `BLOCKERS.md` per
SPECK §5.4.

If the rank-order is WRONG (e.g. standing still scores higher than
a real attempt), that's a real regression and should NOT be merged.

### What changed visually

The shipped pipeline had reference landmarks mirrored in three
places — two on the scoring side, one on the overlay side — and user
landmarks not mirrored at all. After this fix:

- User landmarks pass through `mirrorLandmarksHorizontal` exactly
  once, at the entry of the detection loop in
  `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx`.
- The raw user landmarks are still kept (in `landmarks` state) for
  `SkeletonOverlay`, which mirrors via CSS `scaleX(-1)` on its
  canvas. Touching that path would have spilled into Mode A.
- The mirrored user landmarks are kept in `userMirroredLandmarks`
  state and fed to `DualSkeletonOverlay` so the visual partner
  shares its coordinate frame with the scorer.
- `referenceFrames.ts` and `DualSkeletonOverlay` no longer mirror
  reference data. Reference flows through raw end-to-end.
