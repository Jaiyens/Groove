# Day-2 build summary

> 2026-05-20 — Groove web prototype, second pass.
> Real knowledge graph wired in. Practice loop rebuilt as chunked
> copy-along → test → full attempt. Skeleton alignment + random-stops bugs
> fixed. Audio pipeline added.
>
> 67 unit tests pass, production build green, all routes return HTTP 200.

## What changed since the overnight build

| Area | Before (day 1) | After (day 2) |
| --- | --- | --- |
| Knowledge graph | 8-node stub `{nodes,version,generated_at}` | Real 46-node array (8 routines × 5 skill layers) |
| Loader | Only accepted object form | Accepts both bare array (production) and object form (legacy) |
| Fixtures | `Dance` duplicated bpm/duration/skills | `DanceFixture` (id/name/artist/video_url) merged with routine at runtime via `resolveDance(fixture, graph)` |
| Three fixtures | `fixture_apt` / `fixture_espresso` / `fixture_renegade` (stub IDs) | `routine_golden` / `routine_dead_dance` / `routine_not_cute_anymore` (real IDs) |
| Skeleton overlay | Hardcoded 430×700 canvas, no object-cover compensation, JS mirror conflicted with CSS mirror | `lib/pose/projection.ts` (Swift-portable cover math) + ResizeObserver + single CSS mirror |
| Detection loop | Restarted on every render (dance ref changed) | `useMemo` for dance + visibilitychange handler that re-anchors session clock |
| Audio | None | `lib/audio/danceAudio.ts` hook plays the routine's audio track in Mode B/C |
| Practice loop | One 16–28s attempt scoring the entire dance | Mode A (copy-along chunk loop) → Mode B (scored chunk test) → Mode C (full attempt) |
| Routes | `/practice/[danceId]` | `/dance/[id]`, `/dance/[id]/chunk/[i]/copy`, `/dance/[id]/chunk/[i]/test`, `/dance/[id]/full` |
| Chunk progression | n/a | `lib/graph/chunker.ts` (pure-TS) + `lib/mastery/chunkProgress.ts` (localStorage unlock state) + Duolingo-style progression UI |

## Modes, in words

- **Mode A (`/dance/[id]/chunk/[i]/copy`)** — reference video full-bleed with
  user camera as a corner PIP (tap PIP to swap). Loops the chunk's
  `[startMs, endMs]` window at 50/75/100% via `<SpeedToggle>`. No skeleton.
  Audio respects master volume.
- **Mode B (`/dance/[id]/chunk/[i]/test`)** — camera goes full-screen, skeleton
  overlay on, reference audio (not video) plays so the user has the beat. DTW
  scores only that chunk's pose window. On finish, popup shows the score
  vs. `PASS_THRESHOLD = 70`. Pass → next chunk unlocks. Below threshold →
  Try-again or Back-to-copy-along.
- **Mode C (`/dance/[id]/full`)** — gated on every chunk being passed.
  Audio-only, no reference video, full-routine DTW. Persists a mastery
  attempt and routes to `/results/[sessionId]`.

## Routes (live now)

```
/                                          200
/dance/routine_golden                      200
/dance/routine_dead_dance/chunk/0/copy     200
/dance/routine_dead_dance/chunk/0/test     200
/dance/routine_dead_dance/full             200
/drill/[skillId]                           still works
/results/[sessionId]                       still works
```

## Pure-TS additions (Swift-portable)

- [`lib/pose/projection.ts`](lib/pose/projection.ts) — `computeCoverGeometry()`
  + `projectNormalized()`. The math that maps normalized landmark coords →
  on-screen pixel coords through `object-fit: cover`. **6 new tests.**
- [`lib/graph/chunker.ts`](lib/graph/chunker.ts) — `chunkRoutine(routine,
  options)` returns 2–8 `Chunk { index, startMs, endMs, skills[], label }`.
  Default target 2.5s. **6 new tests.**
- [`lib/mastery/chunkProgress.ts`](lib/mastery/chunkProgress.ts) — per-dance
  unlock state in localStorage. `isChunkUnlocked` / `isChunkPassed` /
  `isFullUnlocked` / `recordChunkScore`. No tests (DOM-bound — exercised via
  the live UI).
- [`lib/dances/fixtures.ts`](lib/dances/fixtures.ts) — `resolveDance(fixture,
  graph)` is the new merge entry point.

## Browser-bound additions

- [`lib/audio/danceAudio.ts`](lib/audio/danceAudio.ts) — `useDanceAudio` hook.
  Owns its own `<Audio>` element so it survives Mode A → Mode B unmount.
  Returns `{ play, pause, seekMs, setVolume, setPlaybackRate, stop, state }`.
- [`components/SpeedToggle.tsx`](components/SpeedToggle.tsx) — 50/75/100% pill.
- [`components/VolumeControl.tsx`](components/VolumeControl.tsx) — header
  mute toggle + reveal-on-focus slider.
- [`components/ChunkProgression.tsx`](components/ChunkProgression.tsx) —
  Duolingo-style locked/unlocked/passed chunk list + Final card.

## What Jaiyen still needs to do

1. **Drop in real reference clips.** Three mp4s in
   `public/data/reference_dances/`:
   - `golden.mp4` (~16s, 123 BPM)
   - `dead_dance.mp4` (~20s, 124 BPM)
   - `not_cute_anymore.mp4` (~15s, 99 BPM)

   With these in place, Mode A's reference video and Mode B/C's audio both
   start working automatically — no code changes.

2. **Precompute per-dance reference pose data.** Mode B and Mode C still
   score against `lib/scoring/syntheticReference.ts` (a programmatic
   neutral-with-subtle-motion vector). The DTW path is already correctly
   chunk-scoped — the only swap needed is the reference frame source.
   Suggested: precompute landmarks per reference mp4 once, save as
   `public/data/reference_pose/<routine_id>.json`, load that into
   `lib/scoring/scorer.ts` via a new `loadReferenceFrames(routine_id)`.

3. **Real per-move skill timestamps.** The chunker currently distributes
   `required_skills` across chunks by uniform array-index slicing. When you
   have human-labeled per-move timestamp ranges (e.g.
   `{ skill: 'side_glide', startMs: 3200, endMs: 4100 }`), wire them into
   `chunkRoutine()` instead of the current uniform partition.

4. **Live-test the loop on a phone.** The desktop dev view sits inside an
   iPhone frame and is good for layout, but the camera dimensions + Safari
   audio gesture rules only show up on a real device. Practice each chunk
   end-to-end at least once.

## Known gaps (kept from day-1, still true)

- **Beat tracker** — BPM-driven, no real audio-onset detection. Deferred to
  iOS native.
- **Per-skill scoring** — uniform partition over `dance.required_skills`.
- **Streak / search bar / bottom-nav extras** — visual stubs.
- **MediaPipe live-stream mode** — SDK only exposes IMAGE / VIDEO. We use
  VIDEO with monotonic timestamps (the documented MediaPipe pattern).

## How to verify locally in 90 seconds

```bash
npm install
npm test          # 67/67 pass
npm run build     # green
npm run dev       # open http://localhost:3000 (or 3001)
```

1. **Home** — 3 dance cards: Golden, The Dead Dance, Not Cute Anymore.
2. **Tap Golden** → lesson overview with 6 chunks, only chunk 1 unlocked.
3. **Tap chunk 1** → Mode A: camera PIP in corner, reference panel shows
   "no video" placeholder (until mp4 is dropped in). SpeedToggle works.
4. **Tap "I got it · test"** → Mode B: camera full-screen, skeleton overlay
   lines up with body, 3-2-1 countdown, score updates as you move, score
   popup with pass/fail.
5. **Pass it** → next chunk unlocks. Repeat until "Full attempt" unlocks.
6. **Full attempt** → audio-only, scores the whole routine, routes to
   `/results/[sessionId]` with per-skill breakdown.

## Commits since day 1

```
task 5: dance audio hook + volume control
task 2: fix skeleton overlay alignment + random stops
task 1: wire in real knowledge graph
```

…plus the day-2 final commit that ships the chunker, the 4 new routes,
SpeedToggle / ChunkProgression / VolumeControl components, and the updated
docs.

## Blockers hit

None.
