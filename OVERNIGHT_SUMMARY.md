# Overnight build summary

> 2026-05-20 — Groove web prototype.
> All 20 numbered steps in SPECK.md completed, 20 commits on `main`, 54 unit
> tests pass, production build is green.

## What works end-to-end

| Surface | Status |
| --- | --- |
| Home (`/`) | Greeting + streak placeholder, gradient featured card (Apt.), For You list (Espresso, Renegade) with weighted % ready badges loaded from stub graph |
| Practice (`/practice/[danceId]`) | Camera permission flow, MediaPipe pose detection on live video, skeleton overlay on canvas, PiP reference video tile, correction toast hints throttled to 5 Hz, live beat-aligned sync score, progress bar with beat tick marks, rewind/pause/skip controls, dance-end → records attempt + navigates to results |
| Results (`/results/[sessionId]`) | Big color-coded overall score, delta-vs-last-attempt, per-skill bar breakdown, auto-recommended next drill from weighted recommender, "Drill it" CTA + "Run it again" |
| Drill (`/drill/[skillId]`) | Camera path + pose loop, countdown timer over `drill_duration_seconds`, live effort meter, final score updates mastery EMA, deep-links back to source results |
| `/not-found` + global `error.tsx` | Cover bad route + runtime exceptions |

All routes return HTTP 200 on the local dev server (verified at step 19).

## Numbers

- **Source**: 6 components, 7 lib subtrees, 4 pages, 5 test files
- **Tests**: 54 (graph 6, mastery 8, readiness 4, recommender 3, joint angles 10, DTW 9, scorer 9, beat tracker 5)
- **Production bundle**: ~112 kB shared, ~118 kB for the heaviest route (practice)
- **Commits**: 20 (one per spec step, plus `step 19` empty commit to mark verification)

## Pure-TS Swift-portable modules (zero DOM)

These translate one-for-one to Swift when iOS native takes over:

- [lib/pose/jointAngles.ts](lib/pose/jointAngles.ts) — joint-angle math
- [lib/pose/types.ts](lib/pose/types.ts) — landmark + vector types
- [lib/scoring/dtw.ts](lib/scoring/dtw.ts) — Sakoe-Chiba band DTW
- [lib/scoring/similarity.ts](lib/scoring/similarity.ts) — cosine + euclidean
- [lib/scoring/scorer.ts](lib/scoring/scorer.ts) — end-to-end + correctionHint
- [lib/scoring/beatTracker.ts](lib/scoring/beatTracker.ts) — BPM phase tracker
- [lib/graph/types.ts](lib/graph/types.ts), [loader.ts](lib/graph/loader.ts), [readiness.ts](lib/graph/readiness.ts), [recommender.ts](lib/graph/recommender.ts)
- [lib/mastery/store.ts](lib/mastery/store.ts) — EMA tracker with pluggable backend

The MediaPipe wrapper (`lib/pose/poseExtractor.ts`) is the only browser-bound
module in `lib/`; its Swift equivalent is Apple Vision's
`VNDetectHumanBodyPose3DRequest`.

## What's stubbed / what Jaiyen needs to do tomorrow

1. **Replace the knowledge graph.**
   ```
   public/data/knowledge_graph.json   ← paste the real graph here
   ```
   The Zod validator in [lib/graph/loader.ts](lib/graph/loader.ts) will throw
   with precise `path` + `reason` if the schema deviates. Cross-reference
   checks confirm every `prerequisites[]` and `required_skills[]` id exists.

2. **Reconnect dance fixtures to the real graph.**
   Edit [lib/dances/fixtures.ts](lib/dances/fixtures.ts) so each `required_skills`
   array points at real graph node IDs instead of `stub_*` placeholders.
   Optionally rename one routine node's `id` to equal a dance fixture id
   (e.g. `fixture_apt`) — the readiness/recommender will then use that
   routine's `skill_weights`, exercising the weighted path. Otherwise it
   falls back to uniform weights, which is fine.

3. **Drop in real reference videos.**
   `public/data/reference_dances/{apt,espresso,renegade}.mp4`. Original or
   licensed footage only — hard rule #3.

4. **Replace synthetic reference pose data.**
   [lib/scoring/syntheticReference.ts](lib/scoring/syntheticReference.ts)
   generates a placeholder "neutral with subtle motion" reference so the
   live score has variance for the demo. Replace by precomputing pose
   landmarks for each reference video and loading them as a JSON sidecar.

5. **Run it end-to-end.**
   ```
   npm install && npm run dev
   open http://localhost:3000
   ```

6. **Ship.**
   ```
   vercel --prod
   ```
   No env vars required.

## Known gaps / shortcuts (documented in DECISIONS.md)

- **MediaPipe live-stream mode** — the SDK exposes only `IMAGE` and `VIDEO`
  running modes. We use `VIDEO` with monotonic timestamps, which is the
  documented MediaPipe pattern for real-time webcam input (functionally
  equivalent to LIVE_STREAM).
- **Beat tracker** — BPM-driven, not audio-onset-detection. Spec allows
  hardcoded BPM per fixture for v1; real onset detection deferred to iOS
  where AVFoundation makes it cleaner.
- **Per-skill scoring** — partitions beats uniformly across
  `dance.required_skills`. Real choreography labels with per-move
  timestamp ranges will replace this. The partition strategy is isolated
  to one function (`partitionBeatsToSkills` in `lib/scoring/scorer.ts`) so
  swapping is trivial.
- **Streak / search bar / bottom-nav non-Home tabs** — visual stubs (Trophy,
  Stats, Profile route to `/`). Spec doesn't require them to be functional;
  the home page nails the look-and-feel only.
- **Reference videos missing** — PiP gracefully shows "no video / placeholder"
  panel; the rest of the loop still works.
- **Next.js 14.2.15** — there is a published security advisory on this minor.
  For local prototyping it's fine; bump before any external deploy.

## Blockers hit

None. [BLOCKERS.md](BLOCKERS.md) is empty.

## How to verify locally in 60 seconds

```bash
npm install
npm test               # 54/54 pass
npm run build          # green
npm run dev            # open http://localhost:3000
```

1. **Home** — 3 dance cards visible; all show `0%` (no attempts yet).
2. **Pick "Apt."** — camera permission prompt; allow it; 3-2-1 countdown;
   skeleton overlay tracks your body; sync score on the bottom updates as
   you move; PiP shows a "no video" panel.
3. **Wait 28 seconds** (or hit skip) — auto-routes to results. Score is
   color-coded; per-skill bars; "Body roll" is the recommended drill
   (highest weight in stub routine).
4. **Tap "Drill it"** — drill screen; countdown; live effort meter;
   completes at the duration shown in the top-right.
5. **Back to home** — Apt. card now shows a non-zero `% ready` badge.

## Commit log

```
$ git log --oneline
87f104d step 19: verified production build + dev server …
29021f3 step 18: README with setup, swap instructions …
60757e8 step 17: polish — fix hint throttle, add not-found and error …
ef57f95 step 16: drill screen with countdown, live effort score, mastery update on finish
e1262f5 step 15: results screen with per-skill breakdown + Next Up drill card
0e0bc36 step 12: end-to-end scorer with frame/beat aggregation + correctionHint + 9 tests
…
314a92e step 1:  init Next.js 14 + TypeScript + Tailwind with dark-mode phone frame layout
```

All 20 spec steps committed individually for easy step-by-step review.
