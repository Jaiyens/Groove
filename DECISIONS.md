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


## Audio: separate <audio> element, lazy alloc, gesture-bound first play

Spec: "the reference video file IS the audio source. Use `<audio>` element in Mode B / C". The new `lib/audio/danceAudio.ts` hook allocates one `Audio()` element per src and exposes a controller — `play/pause/seekMs/setVolume/setPlaybackRate/stop` — plus reactive state (isPlaying, isReady, currentTimeMs, durationMs, volume, playbackRate).

Design choices:
- Separate `<audio>` element rather than reusing the reference `<video>` element's audio output. Mode A keeps the video mounted (PIP); Mode B / C unmount it (camera goes full-bleed) — if we relied on the video's audio, we'd lose audio mid-flow at the mode handoff. The audio element persists across mode transitions because the hook owns its own ref.
- Lazy alloc tied to `src`. New element on src change so the browser fully resets stream state.
- `play()` returns `Promise<boolean>` rather than throwing — iOS Safari rejects autoplay; the caller is expected to bind first-play to a user gesture (the "I got it" button in Mode A, the "Start" button in Mode B).
- `playbackRate` clamped to [0.25, 2] — feeds the 50% / 75% / 100% speed toggle in Mode A.

`components/VolumeControl.tsx` is the compact header control — single tap toggles mute (remembers last non-zero level), hover/focus reveals the slider. Lives in the practice header during Modes A / B / C.


## Practice loop: three modes, route hierarchy

Spec: replace one-shot `/practice/[danceId]` with `/dance/[id]` overview + Mode A copy-along + Mode B scored test + Mode C full attempt. **Decision**: each mode is its own route; state lives in localStorage (`lib/mastery/chunkProgress.ts`) so navigating mid-flow doesn't lose progress. Mode A keeps the reference video; Mode B unmounts it and switches to audio-only via `useDanceAudio` (the audio element survives the React unmount because the hook owns its own ref). Mode C gates on every chunk being passed and uses the same scoring path as the old practice page, so the results screen + drill recommender don't change.

## Chunker: uniform partition for now

`lib/graph/chunker.ts` distributes `required_skills` across N chunks by `floor(k * N / skills.length)`. **Decision**: this is a placeholder for real per-move choreography labels. The function signature is stable — when timestamp-labelled moves arrive, swap the partition strategy without touching any caller. Default targets: 2.5 s per chunk, 2 skills per chunk, clamped to `[2, 8]` chunks per routine. All 8 real routines yield 5–7 chunks at this default.

## Chunk-progression pass threshold

70 / 100. Captured as `PASS_THRESHOLD` in `lib/mastery/chunkProgress.ts`. Higher than the mastery EMA's natural floor (~30 for a new user attempting a chunk), lower than the 80 / 90 we'd want for genuine mastery. Picked so the demo loop unlocks at a realistic pace — Jaiyen can crank it once real reference-pose data lands and scores become trustworthy.

## Mode A speed default: 60%

Below the 75% tier so first-time learners get a clearly-slower-than-real-time loop, but high enough to feel like dancing not slow-motion. Toggle exposes 50/75/100% per spec.

## Volume control: header pill, not bottom bar

The bottom area is dense (CTA + speed toggle + chunk progress) and a volume slider there competes for attention. Header puts it next to the back button — mute is one tap, slider reveals on focus/hover.

## PIP swap (Mode A)

Tap the PIP to swap roles (camera becomes full-bleed, reference becomes PIP). Implemented as a state toggle; the active element gets `inset-x-3 top-3 h-2/3` instead of `right-3 bottom-24 h-40 w-28`. No separate "swap" button — the entire PIP is the affordance, which matches TikTok Duet behaviour.

---

# v2 changes (backend + Simply redesign, 2026-05-20)

## Phase 0: `.env.local` not present at start — graceful fallback

SPECK.md §Phase 0 says: "If `.env.local` doesn't exist yet, write a `SETUP_TODO.md` with step-by-step instructions for Jaiyen and pause work on phases that require the backend." **Decision**: do that, and additionally write all code that *doesn't* require the backend to be live (worker pipeline, API routes, frontend redesign). End-to-end runtime verification (Phase 1) is documented as a follow-up for Jaiyen — see `SETUP_TODO.md` §4. The alternative — refusing to build anything else until Supabase exists — would have wasted the autonomous window on a setup step only Jaiyen can complete.

## Worker: single-process polling, not queue + broker

The spec offered Postgres NOTIFY, a queue, or polling. **Decision**: 5-second polling against `status='queued'`. Reasons: (a) only 1 worker process at a time is realistic at this scale, (b) Supabase free tier doesn't expose LISTEN/NOTIFY over the REST API anyway, (c) optimistic update (`update … where status='queued'`) gives us atomic claim semantics without a queue. Tradeoff: up to 5s submit→start latency. Acceptable for the demo.

## Worker: pose JSON ships raw, not as a binary protobuf

A MediaPipe pose JSON for a 15s @ 30fps clip is ~1.5 MB uncompressed. Supabase Storage gzip-compresses on the fly when `content-encoding: gzip` is set, so cost is fine. **Decision**: keep the JSON shape readable so the frontend can `fetch().json()` it directly into the existing `lib/scoring/scorer.ts`. Binary encoding can come later if storage costs balloon.

## Worker: audio uploaded as wav, not mp3

The pipeline already produces a 22 kHz mono wav for librosa. Re-encoding to mp3 saves bandwidth but adds ffmpeg latency and a transient artifact. **Decision**: upload the wav. ~700 KB for 15s. The browser plays wav fine via the `<audio>` element. Revisit when we exceed 100 dances.

## Worker: skeleton video at 720×1280 (portrait)

TikToks are vertical. The skeleton mp4 is rendered at 720×1280 to match. H.264 + `+faststart` for inline browser playback. Frames missing pose data render as solid black — same length as the source clip so audio sync stays straightforward.

## Worker: skill mapping is heuristic, not learned

Spec acknowledges "v1 can be approximate — check which gross movement patterns occur". **Decision**: 5 simple range-based features (hip_x, shoulder_y, wrist_xy, ankle_x, combined) map to 6 knowledge-graph skills (`posture_alignment`, `weight_shift_basic`, `shoulder_isolation`, `hip_isolation`, `two_step`, `body_roll`, `arm_wave`). Thresholds are empirical guesses. The output goes into `dances.skill_weights` so the existing readiness math just works.

## Worker: `audio_start_offset_ms` left at 0 for v1

Spec calls out "audio sync is critical, must record the exact `audio_start_offset_ms`". For a yt-dlp download where video and audio are extracted from the same source, the offset *is* 0. The field stays on the schema so we can populate it later if we move to a pipeline that records video and audio separately.

## TikTok embed: regex-only ID extraction, no HEAD redirect at submission

Spec mentions `vm.tiktok.com` short URLs need a HEAD request to resolve. **Decision**: do the redirect resolution in the worker (yt-dlp does this for free), not in the submission API. The submission API only validates that the URL has a tiktok.com host. The full URL is stored as-is; the canonical URL comes back in the worker's `info.json` if we ever need it.

## Frontend palette + typography: Simply Sing inspiration

`#FAF6F0` cream background, `#E27A56` warm coral accent, `#5B7F8C` muted blue-grey secondary, `#1A1714` near-black text. Display font: system serif fallback (no remote font fetch on first render). Tailwind tokens added under `theme.extend.colors.cream` etc. — the existing dark-palette tokens are kept so the practice routes (Mode B/C camera screens) can stay dark, where black is correct for skeleton overlay contrast.

## Fixtures: commented out, not deleted

Per spec hard-rule §3 ("do NOT delete the existing fixtures file"). `lib/dances/fixtures.ts` keeps the 3 routine fixtures as a commented block. The home page reads from the API; if Supabase isn't configured, the page surfaces an empty state with the "submit your first tiktok" CTA rather than silently falling back. This keeps the data flow honest.

## Phase 1 verification: scoped to what runs without Supabase

The SPECK calls for end-to-end verification ("run the worker against a hardcoded URL, confirm the resulting row + storage URLs resolve in Supabase"). That requires Supabase credentials + ffmpeg + the Python ML stack — none of which I can install for Jaiyen in this autonomous window. **Decision**: run the verification subset that *is* possible now and document the rest as a follow-up for Jaiyen.

What I verified now:
- All 10 worker modules pass `python -m py_compile` (syntax check)
- `worker/test_pipeline.py` runs 4 synthetic-pose tests against the pure-Python pieces (chunker, skill mapping) and passes
- TS type-check across the project passes (frontend / API code still compiles after the type extension)
- The existing 67 unit tests still pass

What Jaiyen needs to run (per SETUP_TODO.md §4) to close the verification loop:

```
python worker/main.py --once https://www.tiktok.com/@…/video/… \
  --local-only --out ./worker/out
```

That exercises yt-dlp + MediaPipe + librosa + skeleton-mp4 rendering end-to-end without needing Supabase yet. After that:

```
python worker/main.py --once <url>   # uploads to Supabase
```

with `.env.local` + the storage buckets in place. The expected outcome is a `dances` row with all fields populated and the four storage URLs (`pose_data_url`, `skeleton_video_url`, `audio_url`, `thumbnail_url`) returning 200.


## Mirror toggle scope: Mode A only

SPECK polish §Fix 2 calls for mirroring the reference video in Mode A AND Mode B. Mode B is the scored test page and has no reference video element — the user dances against reference audio only, with their own camera full-screen. The `groov_mirror_enabled` preference therefore only takes effect in Mode A's REF panel (copy/page.tsx). The toggle button is also only rendered in Mode A. Joint-angle DTW is mirroring-invariant by construction (joint angles are intrinsic geometry, not screen-space coordinates), so flipping the visual orientation does not affect scoring on either page.

## Library sort: created_at DESC (not usage-based)

SPECK polish §Fix 5. The library lists dances in `created_at DESC` order with `id DESC` as a tiebreaker. The previous order was `view_count DESC, ready_at DESC`, which combined with `bumpView` (which increments view_count on every visit to a dance detail page) made the last-opened dance creep to the top. That looked like a personalized "for you" sort but wasn't — it was just incidental usage tracking driving the order. A real usage-aware sort needs a clear UX (recency, mastery, recommendations) and is deferred.
