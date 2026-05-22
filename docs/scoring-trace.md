# Mode B scoring pipeline — end-to-end trace

Trace of every file/line touched between the raw camera frame and the final
0-100 score the user sees on the results screen. Done before any rewrites, so
the diagnosis is grounded in what's actually there, not what we wish was
there.

## 1. Raw frame capture
- `lib/pose/cameraAttach.ts` — `attachStream(video, stream)` wires a
  MediaStream to the `<video>` element. Camera is selfie/front
  (`facingMode: 'user'`), CSS-mirrored on display (`scaleX(-1)`).
  Frames are 30 fps, native resolution from the device camera.
- `app/dance/[danceId]/chunk/[chunkIndex]/test/page.tsx:139-188` —
  `startCamera()` / `handleTapToStart()` request the MediaStream and attach.

## 2. Pose extraction
- `lib/pose/poseExtractor.ts` — `PoseExtractor` wraps MediaPipe
  `PoseLandmarker` (model `pose_landmarker_full.task`, GPU delegate, 0.5
  detection/presence/tracking thresholds).
- `app/.../test/page.tsx:216-246` — extractor init on camera grant.
- `app/.../test/page.tsx:300-358` — `requestAnimationFrame` loop calls
  `ex.detectFromVideo(v, sessionT)` every frame. Returns
  `{ landmarks, worldLandmarks, timestampMs, confidence }`:
  - `landmarks` — 33 normalized image-space landmarks (x,y ∈ [0,1], z relative
    to hips). Used for skeleton rendering.
  - `worldLandmarks` — 33 world-space landmarks (meters, origin at
    hip midpoint, +Y down per MediaPipe BlazePose convention). Used for
    angle math.
  - `confidence` — mean visibility across landmarks.

## 3. Joint-angle vectorisation
- `lib/pose/jointAngles.ts:76-117` — `computeJointAngles(worldLandmarks)`
  reduces 33 landmarks to an 11-dim joint-angle vector:
  - `left_elbow`, `right_elbow`, `left_shoulder`, `right_shoulder`,
    `left_hip`, `right_hip`, `left_knee`, `right_knee` — degrees, joint
    flexion angles via `angleAt(A,B,C)`.
  - `torso_lean` — degrees from world +Y of the spine vector
    (hip→shoulder).
  - `hip_rotation_y` — signed `atan2(z, x)` of hip line; range (-180, 180].
  - `chest_forward_z` — meters; `-(shoulderMid.z - hipMid.z)`.
- No left/right mirroring of joint names. Whichever side MediaPipe calls
  "left" is the dancer's anatomical left (regardless of which side of the
  screen it appears on after CSS mirror).

## 4. Frame storage (user stream)
- `app/.../test/page.tsx:322-325` — every detected frame is pushed onto
  `userFramesRef.current` as `{ timestampMs: chunk.startMs + sessionT,
  vector }` (absolute routine-relative timestamp).

## 5. Reference stream
- **This is the broken piece.** `lib/scoring/syntheticReference.ts:27-39` —
  `neutralReferenceFrame(t, bpm)` produces a "neutral upright pose with
  small ±4° sway and ±8° shoulder oscillation on the beat". This is not
  the reference dance. It's a placeholder that was left in.
- `lib/scoring/syntheticReference.ts:41-54` —
  `generateReferenceSequence(durationSeconds, bpm, fps=30)` builds the full
  reference sequence the final scoring uses; same neutral-with-sway frames
  across the entire routine.
- A real pose-JSON loader exists at `lib/pose/referencePose.ts`
  (`useReferencePose`, `landmarkAt`) and consumes a worker-produced
  `dance.pose_data_url` sidecar of MediaPipe landmark frames. **It is only
  wired into Mode A's "show skeleton" overlay** (`app/.../copy/page.tsx:123`,
  `:285-298`). Mode B never touches it. Mode B's reference is 100%
  synthetic.

## 6. Live frame score (during dance)
- `app/.../test/page.tsx:326-329` — every detected frame: compute
  `neutralReferenceFrame(t, bpm)`, take `cosineSimilarity(userVec, refVec)`,
  pass to `frameScoreFromSimilarity()`.
- `lib/scoring/scorer.ts:35-39` —
  `frameScoreFromSimilarity(sim) = 100 * exp(-(1-sim) * 5)`.
  Properties:
  - sim 1.00 → 100
  - sim 0.95 → 78
  - sim 0.90 → 61
  - sim 0.80 → 37
  - sim 0.70 → 22
  - sim 0.50 → 8
  - sim 0.00 → 0.67
- The exponential decay is harsh: any non-trivial divergence drops the
  score into "looks like a failure" territory even when the user is
  dancing well.

## 7. Final session score
- `app/.../test/page.tsx:361-396` — on `runState === 'finished'`:
  1. `generateReferenceSequence(duration, bpm)` builds the full synthetic
     reference (still synthetic).
  2. Filter to `[chunk.startMs, chunk.endMs)`.
  3. `BeatTracker(bpm, chunk.startMs).asGrid()` → beat grid.
  4. `scoreSession({ userFrames, referenceFrames, beatGrid, skillIds })`.
- `lib/scoring/scorer.ts:41-77` — `scoreSession`:
  1. Run DTW between user vectors and reference vectors
     (`lib/scoring/dtw.ts:16-88`, Sakoe-Chiba band ≈10% of max length, local
     cost = `euclidean(userVec, refVec)` — Euclidean over all 11 dims
     including the `chest_forward_z` meters which sits ~0).
  2. For each `(u,r)` in the DTW path, compute
     `cosineSimilarity → frameScoreFromSimilarity → score`.
  3. Aggregate frames by beat → `BeatScore = mean(framesInBeat)`.
  4. Overall = `mean(beatScores)`.
  5. `perSkillScores`: partition beats uniformly across skillIds.
- `app/.../test/page.tsx:375-389` — `setFinalScore(round(result.overall))`,
  persist via `recordChunkScore`.

## 8. Results UI
- `app/.../test/page.tsx:560-630` — score popup. Shows
  `passed ? 'Chunk passed' : 'Almost there'`, the rounded score in
  `scoreColor`, and `threshold {PASS_THRESHOLD}` (70). No per-joint
  breakdown, no trouble-spots, no drill CTA.
- `lib/mastery/chunkProgress.ts` — `PASS_THRESHOLD = 70`,
  `recordChunkScore(danceId, idx, score)` persists per-chunk best score
  and unlocks the next chunk on pass.

## Summary of math
```
userFrame.vec = computeJointAngles(worldLandmarks)
refFrame.vec  = neutralReferenceFrame(t, bpm)         ← FAKE
sim           = cosineSimilarity(userVec, refVec)
frameScore    = 100 * exp(-(1 - sim) * 5)
beatScore     = mean(frameScores in beat)
overall       = mean(beatScores)
```
