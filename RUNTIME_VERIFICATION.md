# Runtime verification — 2026-05-21 (round 2)

End-of-fix-pass status. Real-phone testing revealed the prior overnight
build had Mode A built around the wrong reference (skeleton-only video),
broken camera + audio, broken back nav, ugly titles, and dead buttons.
All of that is fixed in this pass; the palette, multi-person, and pose
tracking work also landed. See SPECK.md for the prompt; commits below
match the phase numbers there.

📱 **Open this on your phone (same WiFi):** https://192.168.4.38:3000
*(must be **https** for the camera to work — see BLOCKERS.md §4 for the
one-line dev-server fix)*

## Headline

✅ **All 5 phases implemented and code-committed.** Static / synthetic
verification done (typecheck clean, 67/67 tests pass, production build
green, worker self-tests pass). Live phone verification needs four
one-time user actions (BLOCKERS.md) — none of them are coding tasks.

## What shipped (commits in `main`)

```
f9fd7bb track refreshed spec for the second-round fix work
902eef8 phase 1.5 + 1.1 backend: video_url column, original-mp4 upload, clean titles
3d86d99 phase 1.1-1.3: Mode A duet redesign, camera UX, audio via real video
67743ff phase 1.4: back navigation actually goes back
ec0d0ca phase 1.6: stub /progress and /profile so the bottom nav stops 404-ing
906165c phase 2: direction 3 palette — off-white + hot-pink restraint
873233e phase 3: multi-person dance support + pick-a-dancer flow
8426328 phase 4: pose-tracker reliability + framing onboarding
```

## What's actually in each phase

### Phase 1 — critical functional fixes

| # | Was | Now |
| --- | --- | --- |
| 1.1 Mode A reference | worker-rendered skeleton-only mp4 (looked like a stick figure) | Real TikTok video on top half, user camera on bottom half (duet split-screen). Skeleton lines are an opt-in toggle overlaid on the reference. Falls back to the skeleton mp4 only when video_url is null (legacy rows). |
| 1.2 Camera | "no camera" empty state | New CameraPermissionBanner distinguishes insecure-context (HTTPS) / requesting / needs-tap / denied / unavailable. The HTTPS case is the most common phone failure and gets a specific message + pointer to BLOCKERS.md. |
| 1.3 Audio | silent | Comes from the reference video element directly. Subsumed by 1.1. If iOS Safari blocks autoplay-with-sound the video falls back to muted and shows a "tap for sound" pill that unmutes on tap. |
| 1.4 Back nav | hardcoded Link to "/" | Every back arrow on every non-home screen now calls router.back() with a sensible fallback. Mode A, Mode B, Mode C, drill, results, dance overview, pick-dancer, frame-check. |
| 1.5 Titles | "@maya dc @Gandarra @𝚓 𝚎 𝚢 𝚖 𝚜" (TikTok caption) | worker/download.clean_title() prefers iTunes-style track + artist, falls back to the description with @mentions / #hashtags / dc-credits stripped, truncated to ~32 chars. Existing rows can be rewritten with `python worker/refresh_titles.py` (idempotent). |
| 1.6 Dead UI | /progress, /profile bottom-nav tabs 404'd | Stub placeholder pages with the bottom nav so the tabs land somewhere real. /profile also gets a "re-calibrate framing" entry (Phase 4 wire-up). Lock icons on locked chunks remain inert by design. |

### Phase 2 — Direction 3 palette

- Token-level rewrite of `tailwind.config.ts`. Names (`cream`, `ink`,
  `coral`, etc.) kept stable; only the **values** change. Off-white
  `#F8F8F6`, white surfaces, near-black text, electric hot pink
  `#FF3E7F`.
- Inter loaded via `next/font/google` (weights 400 + 500 only).
  Wordmark is now lowercase "groove" with -0.02em tracking. `font-serif`
  remaps to the same Inter stack so no markup churn.
- Hot pink restraint: SubmitFab, active bottom-nav tab, big results
  score, top-skill row in ScoreBreakdown, processing spinner accent.
  All other CTAs (HeroCard, ChunkPath final, results "drill it",
  ProcessingState, SubmitModal) are black (`bg-ink text-cream-card`).
- Camera screens (Mode A duet, Mode B, Mode C) deliberately stay dark.

### Phase 3 — multi-person dance support

Worker:
- `worker/pose.py` rewritten. `num_poses=5`, a greedy centroid tracker
  matches detections to persistent person IDs by hip-midpoint distance.
- Per-person `lead_score = 0.3*centrality + 0.3*size + 0.2*forwardness
  + 0.2*persistence`; highest scorer → `auto_selected_person_id`. When
  the gap to second place is <0.15, `requires_dancer_pick = true`.
- Pose JSON now carries a `persons` array (id, lead_score, sub-scores,
  bbox, full frames track) **plus** the legacy top-level `frames` (the
  auto-selected person) so referencePose.ts keeps working unchanged.
- New `worker/thumbnail.extract_person_thumbnails` crops one JPG per
  tracked person from its largest-bbox frame; store.py uploads to a
  new `person-thumbnails` bucket.

Schema (`0004_multi_person.sql`): `dancer_count`,
`auto_selected_person_id`, `person_thumbnails (jsonb)`,
`requires_dancer_pick`.

Frontend:
- `/dance/[id]/pick-dancer` renders the per-person thumbnails in a 2-up
  grid; tap → `POST /api/dances/[id]/dancer` writes back the choice and
  clears `requires_dancer_pick`.
- Dance overview auto-redirects to pick-dancer when needed and gains a
  "change dancer" link for multi-person rows.

### Phase 4 — pose tracking reliability + framing onboarding

- `lib/pose/poseExtractor.ts` switched from `pose_landmarker_lite` to
  `pose_landmarker_full` (~2× slower per detection, materially better
  limb tracking on real phone footage). `PoseResult` carries a per-frame
  `confidence` (mean landmark visibility).
- Stuck-skeleton bug fixed: Mode B, Mode C, and Drill all set
  `landmarks: null` when detection returns nothing, so the canvas hides
  rather than freezing the last frame. `SkeletonOverlay.staleAfterMs`
  tightened from 1000 ms to 400 ms.
- New `components/FramingToast` watches the per-frame confidence. When
  it drops <0.5 for >1.5s a "adjust your framing" pill appears; tapping
  it overlays a translucent body silhouette for 2s. Toast dismisses
  when confidence recovers above 0.7.
- New `/onboarding/frame-check` route. Camera full-screen with a
  silhouette guide; when every tracked joint sits inside the silhouette
  for 2 consecutive seconds the outline turns green and the "got it"
  CTA enables. Skip allowed. On confirm,
  `lib/pose/framingCalibration` writes `framing_calibrated=1` to
  localStorage. Mode B, Mode C, and Drill gate on it.
- `/profile` exposes a "re-calibrate framing" entry that clears the
  flag and routes through the onboarding.

## Verification done in this pass

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean (one pre-existing `TS5097` test import warning, unrelated) |
| `npm test` | 67 / 67 pass |
| `npm run build` | green, all 14 routes register (was 6) |
| `python -m py_compile worker/*.py` | all modules parse |
| `python worker/test_pipeline.py` | 4 / 4 pass (chunker + skill mapping) |

## Verification that needs you (BLOCKERS.md)

1. **Apply migrations 0003 + 0004** in Supabase SQL Editor.
2. **Create the `videos` and `person-thumbnails` storage buckets** (public, same settings as `skeleton-videos`).
3. **Re-process the 3 existing library dances** so they pick up
   `video_url` + the new titles. Either:
   - `python worker/main.py --once <tiktok_url>` (full re-ingest), or
   - `python worker/refresh_titles.py` (titles only, leaves video_url empty)
4. **Switch the dev server to HTTPS** so the phone can use its camera:
   `npm run dev -- --experimental-https` (Next prints the cert-trusted
   `https://192.168.4.38:3001` to visit).

After 1–4 are done, the phone test cycle for the SPECK success path:

| Step | Expected |
| --- | --- |
| 1. open the library URL | wordmark "groove" in Inter, hot-pink "submit a tiktok" fab, clean titles |
| 2. tap a Charli dance | dance overview loads with proper title; "back to library" arrow returns to the library |
| 3. tap section 1 | Mode A loads with Charli's actual video on top, your camera on bottom; audio plays. Toggle "skeleton" top-right to overlay the pose lines |
| 4. tap "I got it · test" | first time: routed through `/onboarding/frame-check` — stand back so all joints fit the silhouette for 2 s, tap "got it"; second time: straight into Mode B |
| 5. Mode B runs to completion | score appears; if ≥70, chunk 2 unlocks; if you wander out of frame mid-test you get the "adjust your framing" pill |
| 6. submit a 2-person TikTok | once worker finishes processing, the dance overview auto-redirects to `/dance/[id]/pick-dancer`; pick one, continue. The "change dancer" link in the overview re-opens the screen any time |

## What didn't change

- The pure-TS math layer (DTW, joint angles, scoring) is untouched per
  SPECK hard-rule §2. 67 tests still cover it.
- The dark-themed camera screens kept their colour scheme — black is
  the right backdrop for the white skeleton overlay; SPECK §Phase 2
  was about the cream / lesson / library surfaces.
- The worker pipeline shape: still 7 sequential steps producing the
  same artifacts plus the new video.mp4 and per-person thumbnails.

## Logs / process state

| Process | Where | Status |
| --- | --- | --- |
| Next.js dev server | `npm run dev` | running on http://192.168.4.38:3000 (LAN reachable); use `--experimental-https` to make the phone happy |
| Worker poller | `cd worker && python main.py` | unchanged — poll loop still 5 s |
