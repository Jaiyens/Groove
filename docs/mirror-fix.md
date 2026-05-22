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

## Post-fix score check

(Filled in at Stage 5 after the manual UI check.)
