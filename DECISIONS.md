# Decisions log

A running log of tradeoffs and interpretations made during the overnight build. Each entry: what + why.

## Project root location

Spec shows `groove-web/` as the top-level project directory, but the working dir is already `/Users/panda/Groove`. **Decision**: use `/Users/panda/Groove` as the project root directly; the `package.json` name is `groove-web` per spec. Avoids redundant nesting (`Groove/groove-web/`). Internal structure (`app/`, `components/`, `lib/`, `public/`) follows the spec exactly.

## Next.js version

Spec says "Next.js 14+ with App Router". **Decision**: pinned to `next@14.2.15`. Next 15 changes async params semantics in App Router, which would complicate dynamic routes (`[danceId]`, `[sessionId]`, `[skillId]`). Staying on 14 keeps params synchronous and reduces surprise for Jaiyen tomorrow. There is a known security note on this version; for a local prototype with no backend, it's acceptable. Bump before deploying production.

## Strict TS, no JS escape hatches

`tsconfig.json` uses `strict: true` per spec. No `// @ts-ignore` allowed in committed code — anything that doesn't type-check goes into BLOCKERS.md.

## Dark mode default + iPhone phone frame

`app/layout.tsx` sets `<html className="dark">` unconditionally. `PhoneFrame` wraps content and renders an iPhone-shaped shell at `min-width: 600px` (desktop dev view) and full-bleed below that (real mobile). The 430px width matches iPhone 14 Pro Max width; 932px matches its height.

## Tailwind colors

Custom semantic palette: `bg`, `text`, `accent` with score-color tokens (`accent.green/amber/red`) matching the spec's results screen color-coding rules. Easier to keep score breakdown consistent across screens.

## Testing setup

`npm test` uses Node's native `node --test` runner with `tsx` for TypeScript. No Jest / Vitest dependency needed — keeps the toolchain small and the pure-TS modules (which we'll port to Swift) testable without browser-y test runners.

## Beat tracker scope

Spec says "use Web Audio API to do real-time onset detection". Real onset detection is a research problem with no clean off-the-shelf JS lib. **Decision**: ship the BPM-based phase tracker per the spec's v1 escape hatch ("allow a hardcoded BPM per reference dance fixture") and stub the audio-onset path with a clearly-marked TODO. Real-time onset detection deferred to native iOS where AVFoundation makes this easier. Recorded in OVERNIGHT_SUMMARY.md as a known gap.

## Reference dance media

Spec forbids real TikTok video. **Decision**: generate 3 minimal placeholder MP4s (or omit and use `<video>` poster fallback) — Jaiyen swaps in real footage tomorrow. Codec doesn't matter for the prototype since the camera + skeleton path is what we're demoing.

## Mastery: bootstrap value

For brand-new users with no attempts yet, the recommender needs a value. **Decision**: `getMastery(skillId)` returns `0` for unknown skills. Readiness for a fresh dance is therefore 0% on first launch — matches the "% ready" mental model and surfaces all skills as drill candidates. Documented in `lib/mastery/store.ts`.

## Connecting a Dance fixture to a RoutineNode

Spec says readiness uses `skill_weights` from a routine node, but the `Dance` interface has only `id` and `required_skills` — no explicit `routine_node_id` field. **Decision**: match by `id` convention. If a `RoutineNode` exists in the graph whose `id` equals `dance.id`, use its `skill_weights`; otherwise fall back to uniform weights over `dance.required_skills`. The stub graph includes one routine node with id `fixture_apt` to exercise the weighted path; the other two dances (`fixture_espresso`, `fixture_renegade`) exercise the uniform fallback. Tomorrow Jaiyen can either rename routine nodes to match dance IDs or extend the Dance type with `routine_node_id`.

## MediaPipe running mode

Spec says "live-stream running mode for camera." **Decision**: `@mediapipe/tasks-vision@0.10.17` only exposes `IMAGE` and `VIDEO` running modes (no `LIVE_STREAM` for vision tasks in this SDK version — only audio/text have it). Camera live stream uses `VIDEO` mode with monotonically increasing timestamps, which is the documented MediaPipe pattern for real-time webcam input. The `detectForVideo(elt, timestampMs)` call is synchronous. Behavior is identical to what spec intends.

## MediaPipe model

Using `pose_landmarker_lite.task` (float16) from MediaPipe's public model store. Lite is fast enough for real-time on mid-range phones; full would be ~2× slower with marginal accuracy gain at this resolution. Tomorrow Jaiyen can swap to `pose_landmarker_heavy` if accuracy is a problem — change MODEL_URL in `lib/pose/poseExtractor.ts`.

## Stub graph structure

8 nodes covering all 6 layers per spec: 2 foundations (posture, weight_shift), 2 isolations (shoulder_iso, hip_isolation), 1 travel (two_step), 1 combo (body_roll), 1 vocabulary (arm_wave), 1 routine (fixture_apt). Every node has `"sources": ["STUB - replace with real graph"]` per spec. The routine's `required_skills` matches `fixture_apt`'s `required_skills` exactly so the weighted-readiness math is straightforward to verify.

---

# Day-2 changes (real knowledge graph drop, 2026-05-20)

## Graph file format: bare array

The stub graph was `{ nodes, version, generated_at }`. The real graph from Claude Research is a **bare JSON array** of nodes — no wrapping object. **Decision**: make the loader accept both. `KnowledgeGraphSchema` now uses `z.preprocess` to wrap a bare array as `{ nodes: array, version: 'unknown', generated_at: '' }`. The legacy object form is also preserved so the test suite's hand-built fixtures still parse. Both routes flow through the same downstream pipeline (cross-reference checks, normalised return shape).

## Fixture / routine merge

Old fixtures duplicated `bpm`, `duration_seconds`, and `required_skills` between `lib/dances/fixtures.ts` and the graph. With the real routine nodes carrying authoritative values, **decision**: split `Dance` into `DanceFixture` (editorial only — `id`, `name`, `artist`, `video_url`) and `Dance` (resolved view with pedagogy fields merged in from the routine node). `resolveDance(fixture, graph)` is the merge entry point. UI components that consumed `Dance` keep working unchanged; consumers that used to call `getDance(id)` now call `getDance(id, graph)`. Fixture `id` must equal the routine node id (`routine_*`).

## Three fixtures: golden / dead_dance / not_cute_anymore

Per task brief: replaced the old `fixture_apt` / `fixture_espresso` / `fixture_renegade` stubs (whose routine nodes don't exist in the real graph) with `routine_golden`, `routine_dead_dance`, `routine_not_cute_anymore`. Placeholder mp4 paths point at `/data/reference_dances/<id>.mp4` for Jaiyen to drop real footage in. Reference video component already degrades gracefully when files are missing.

## Readiness: iterate required_skills, not skill_weights

`routine_golden` has 14 entries in `required_skills` but only 13 in `skill_weights` (the routine omits `posture_alignment` from weighting — likely because it's a baseline assumption rather than a scored skill). **Decision**: change `computeReadiness` to iterate `dance.required_skills` (the canonical set), looking up each weight from `skill_weights` (defaulting to 0 if absent). Net effect on the score: identical, since a weight-0 skill contributes 0 to the weighted sum. But the per-skill breakdown now lists *every* required skill, which is what the UI actually needs.

## Routine weight sums

All 8 routine nodes have `Σ skill_weights[*] ≈ 1.0` (within float epsilon). Loader treats this as a soft constraint — the per-skill Zod range `[0, 1]` still applies, but we don't reject a routine whose weights drift slightly from 1. The readiness calc normalises by total weight anyway.


## Skeleton overlay: object-cover projection + selfie mirroring

User reported the skeleton didn't line up with the body and randomly stopped. Three concrete bugs:

1. **Coordinate space mismatch.** The canvas was hardcoded to 430×700 px while the on-screen video filled `flex-1` (true client size) with `object-fit: cover`. Cover crops the long axis of the camera frame; the canvas drew landmarks as if there was no crop. **Fix**: `lib/pose/projection.ts` is a new pure-TS module that computes `(scale, offsetX, offsetY)` from intrinsic video dimensions and the on-screen element bounds, and `SkeletonOverlay` now takes a `videoRef` and re-measures via `ResizeObserver`. Pure math separated for Swift portability.

2. **Mirror duplication.** The video element CSS-flipped with `scaleX(-1)`; the canvas then mirrored landmarks again via JS (`mirror ? (1 - lm.x) * w : lm.x * w`). When combined with object-cover crop, the second mirror compounded the offset error. **Fix**: mirroring is now a single CSS flip on the canvas — landmarks are always drawn in the camera's native un-mirrored frame, and the same `scaleX(-1)` applied to both video and canvas keeps them aligned by construction.

3. **Detection loop restarts on every render.** `useEffect([camState, runState, dance])` re-armed RAF every time `dance` changed reference identity, which happened on every `bumpMastery()` because `getDance(id)` was called fresh on each render. **Fix**: `useMemo(() => getDance(id, graph), [graph, id])`. Combined with a visibility-change handler that pauses RAF when the tab hides (and re-anchors `startMsRef` on resume), the "random stops" go away.

Added pose-tracking UI states: a toast surfaces "pose tracking lost, repositioning…" when 1.5 s pass with no detection, and "pose tracker unavailable" when MediaPipe `init()` rejects. The detection loop tracks consecutive failures so a recovery can be wired in (currently the loop just keeps re-trying — MediaPipe usually recovers within a few hundred ms once the body re-enters frame).

Removed the `width: { ideal: 430 }, height: { ideal: 700 }` constraints on `getUserMedia` — let the device pick native sensor dimensions, and let the projection math handle whatever shape comes back. This also avoids the iOS Safari quirk where unrealistic constraints downscale aggressively and ruin landmark precision.

