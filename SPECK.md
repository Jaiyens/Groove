#  v2 — Groove with URL submission, backend, and Simply-style library

## Read this first

This is a major architectural change. Read the existing `spec.md`, `DECISIONS.md`, and `OVERNIGHT_SUMMARY.md` in full before doing anything. Most of what was built last night stays. The pure-TS math layer, the knowledge graph + loader, the mastery store, the chunk-based Mode A/B/C practice loop — all of those remain.

What changes:
1. The library becomes a backend-served database instead of hardcoded fixtures
2. A "submit a TikTok URL" flow is added as a first-class feature
3. A Python worker service handles video download + pose extraction
4. Mode A (copy-along) uses a generated skeleton-only video instead of the real video
5. Mode B and Mode C (scored attempts) use TikTok's official embed for playback
6. The visual design gets a "Simply Sing / Simply Piano" aesthetic pass

Work autonomously. Commit after each numbered phase. Update DECISIONS.md as you go. Write BLOCKERS.md if anything truly stops you.

---

## The new architecture

### Frontend (existing Next.js app, redesigned)
- Library screen with backend-fetched dances + "submit a TikTok" CTA
- Submission flow: paste URL → polling loading state → dance appears in library
- Existing dance/chunk/copy/test/full routes mostly unchanged but with new visual design
- All consuming the API layer instead of fixtures

### Backend
- **API layer:** Next.js API routes (in the existing app under `/app/api/`)
- **Database:** Supabase Postgres (free tier is fine for now)
- **Storage:** Supabase Storage for pose JSON blobs and the generated skeleton videos
- **Worker service:** Separate Python service on a Railway or Fly.io instance for the heavy work (yt-dlp + MediaPipe + ffmpeg). Frontend talks to API → API queues a job → Worker picks it up → Worker writes results to Supabase → Frontend polls API until ready.

If Railway/Fly setup is too involved for tonight, fall back to running the worker as a Vercel Edge Function with extended timeouts, or as a long-running Python process Jaiyen can run locally for the demo. Document the tradeoff in DECISIONS.md.

### Data model (Supabase Postgres)

```sql
-- dances table
create table dances (
  id uuid primary key default gen_random_uuid(),
  tiktok_url text unique not null,
  title text,
  creator_handle text,
  duration_seconds float,
  bpm float,
  status text not null check (status in ('queued', 'processing', 'ready', 'failed')),
  error_message text,
  thumbnail_url text,
  pose_data_url text,  -- supabase storage URL for the pose JSON
  skeleton_video_url text, -- supabase storage URL for the generated skeleton mp4
  chunks_json jsonb, -- the auto-detected chunk boundaries
  required_skills jsonb, -- which skills from the knowledge graph this dance uses
  skill_weights jsonb,
  submitted_by_session_id text, -- anonymous session id for credit
  view_count int default 0,
  created_at timestamptz default now(),
  ready_at timestamptz
);

-- index for the library query
create index dances_ready_view_count_idx on dances(status, view_count desc) where status = 'ready';
```

### Worker pipeline (Python)

When a TikTok URL is submitted, the worker does this end to end:

1. **Download:** `yt-dlp` against the URL, save mp4 + extract audio
2. **Beat detection:** `librosa.beat.beat_track` on the audio to get beat timestamps and BPM
3. **Pose extraction:** MediaPipe Pose Landmarker on every frame of the video. Save the resulting per-frame landmarks as a JSON array.
4. **Auto-chunking:** Combine beat boundaries + pose-velocity peaks to find natural section breaks. Target 2-4 chunks per dance, each 3-8 seconds long. Algorithm: compute total joint angular velocity per frame, smooth with a 0.5s window, find local minima that align with beat boundaries, split there.
5. **Skill mapping:** For each chunk, identify which skills from `knowledge_graph.json` are present using the success criterion thresholds. (For v1, this can be approximate — just check which gross movement patterns occur.)
6. **Skeleton video generation:** Render an mp4 of just the skeleton dancing (white skeleton on black background) using ffmpeg + matplotlib or OpenCV. Same duration as the original, no audio. This is what Mode A plays back at slow speed.
7. **Thumbnail:** Extract a single frame from the video as a jpg, save as thumbnail.
8. **Write results to Supabase:** Upload pose JSON + skeleton video to Storage, update the `dances` row with all the metadata, set status to 'ready'.

If any step fails, set status to 'failed' with the error_message and notify the frontend.

### API routes (Next.js)

- `POST /api/dances/submit` — body: `{ tiktok_url }`. Validates URL, inserts a row with status='queued', returns the dance ID. Notifies the worker (via a Supabase Postgres NOTIFY, or a simple polling pattern, or a Vercel cron).
- `GET /api/dances/:id` — returns the full dance record including status. Frontend polls this for the loading state.
- `GET /api/dances` — returns paginated library, sorted by `view_count desc`, status='ready'. Supports optional `?seed=true` to return just the seeded dances.
- `POST /api/dances/:id/view` — increments view_count when someone opens a dance to learn it.

---

## Phases

### Phase 0: Setup (do this first, do not skip)

1. Set up a Supabase project (Jaiyen will need to do this and paste the URL + anon key into `.env.local`). The Claude Code session can read the project ID from `.env.local` and use the Supabase CLI to apply migrations. If `.env.local` doesn't exist yet, write a `SETUP_TODO.md` with step-by-step instructions for Jaiyen and pause work on phases that require the backend.

2. Install dependencies:
   - Frontend: `@supabase/supabase-js`
   - Worker: Python with `yt-dlp`, `mediapipe`, `librosa`, `opencv-python`, `ffmpeg-python`, `supabase` (Python client)

3. Apply the database migration above. Confirm tables exist.

4. Initialize the worker service in a new directory `worker/` with a `requirements.txt`, a `main.py` that polls for queued dances, and a `Dockerfile` for deployment.

### Phase 1: Worker pipeline (build this before the frontend changes)

Build the worker end to end on a single test TikTok URL before touching the UI. The worker should:

1. Accept a URL (for testing, just hardcode one)
2. Download via yt-dlp
3. Run pose extraction on every frame
4. Detect beats and chunks
5. Generate the skeleton video
6. Write everything to Supabase Storage + Postgres

Verify by running it locally and confirming the resulting dance row in Supabase has all fields populated and the storage URLs resolve.

Commit: "phase 1: worker pipeline e2e on hardcoded URL"

### Phase 2: API routes

Build the 4 API routes above. Test each with curl. Make sure:
- `POST /api/dances/submit` actually triggers the worker (whether via polling or notify)
- `GET /api/dances/:id` returns status transitions correctly as the worker processes
- `GET /api/dances` returns the library sorted by views

Commit: "phase 2: API routes for submission, status, library, views"

### Phase 3: Library screen redesign

Replace the current home screen with a Simply-style library. Reference aesthetic:

- **Light mode by default** (cream/warm background, not the dark mode we built)
- **Color palette:** background `#FAF6F0`, primary text `#1A1714`, accent `#E27A56` (warm coral), secondary `#5B7F8C` (muted blue-grey)
- **Typography:** big, readable serif or rounded sans for headlines (Fraunces, DM Serif, or similar); clean sans for body
- **Cards:** rounded, generous padding, soft shadow, thumbnail image is the dominant element, title underneath
- **Spacing:** very intentional. Lots of whitespace. Cards take up real estate.
- **No emoji placeholders.** Use actual thumbnail images from the dance metadata.

Structure:
- Top: app name "Groove" in big friendly type, small subtitle "learn any tiktok dance"
- Hero card: featured dance (the most-viewed one), large rounded image, title, "tap to learn" CTA
- Section header: "trending" — horizontal scroll of 5-8 dance cards
- Section header: "new to the library" — vertical grid of recently-added dances
- Floating CTA at the bottom: "submit a tiktok" — big rounded button, accent color
- Bottom nav: Library (active), Progress, Profile

Data source: `GET /api/dances`. If the API is empty, show a Simply-style empty state with a big "submit your first tiktok" CTA.

Commit: "phase 3: library screen with simply-style design, backend-driven"

### Phase 4: Submit flow

Build the submission flow as a modal or full-screen overlay over the library:

1. Tap "submit a tiktok" → modal opens with a big text input "paste a tiktok link"
2. User pastes URL, taps submit
3. API call to `/api/dances/submit`, modal switches to a loading state with a friendly animation ("scanning the moves...", "finding the beat...", "breaking it into pieces..." — 3 status messages that rotate)
4. Poll `/api/dances/:id` every 2 seconds. When status='ready', the modal closes and the user is taken directly to `/dance/[newId]`. When status='failed', show an error with the message and a "try a different link" CTA.

For day 1, if the loading is going to take 30-60 seconds, that's fine — the loading screen should feel intentional and reassuring, not slow.

Commit: "phase 4: submit-a-tiktok flow with polling and loading states"

### Phase 5: Dance learning route redesign

The existing `/dance/[id]`, `/dance/[id]/chunk/[i]/copy`, `/dance/[id]/chunk/[i]/test`, `/dance/[id]/full` routes get a visual refresh in the same Simply style, and three functional changes:

1. **Mode A (copy):** the reference video shown is now the GENERATED SKELETON VIDEO (`skeleton_video_url` from the dance record). Plays at the user's chosen speed (50/75/100%). Looping the chunk. No actual TikTok video here.

2. **Mode B (test):** the camera goes full screen with skeleton overlay (existing behavior). The reference dance's AUDIO plays in the background. The audio source is also from the worker's output — the worker should have saved an audio-only mp3 to Supabase Storage. (Add this to the worker pipeline.)

3. **Mode C (full):** same as Mode B but with the full dance, all chunks chained. After the user completes, results screen shows. Then, on the results screen, BELOW the score, embed the official TikTok using the official TikTok embed iframe so users can see the original. This satisfies the "watch the real thing" desire without us hosting the video.

The chunk progression visual on `/dance/[id]` should look like Simply Piano's lesson tree — rounded nodes with locked/unlocked/mastered states, connecting lines, very deliberate.

Commit: "phase 5: dance learning routes redesigned with skeleton video + tiktok embed"

### Phase 6: Day 1 seeding

Jaiyen will provide ~10-20 TikTok URLs to seed the library plus the 8 routines from the knowledge graph. For the 8 graph routines, the URLs are already in the `sources` field of each routine node. For Jaiyen's picks, he'll paste them.

Write a script `scripts/seed_library.ts` that:
1. Reads a list of URLs from `seed_urls.txt`
2. Calls `POST /api/dances/submit` on each
3. Polls until all are ready
4. Logs success/failure for each

Run it once to populate. After that, the library is alive.

Commit: "phase 6: seeding script + initial library populated"

### Phase 7: Polish

- Verify all 67 tests still pass after the refactor
- Fix any responsive design issues on mobile
- Verify the production build succeeds
- Update README with deployment instructions (Supabase setup, env vars, worker deploy)
- Update OVERNIGHT_SUMMARY.md with final state

Commit: "phase 7: polish, docs, verification"

---

## Critical implementation notes

1. **Mobile is the only target.** Don't worry about desktop layout beyond the existing PhoneFrame component. The user is on their phone.

2. **The seed dances might NOT have perfect pose tracking.** Some TikTok dances have the dancer too far from the camera, or with cluttered backgrounds. The worker should mark these with a `low_quality` flag and the frontend should warn the user. Don't try to filter them out automatically — let the user decide if they want to learn from a low-quality reference.

3. **Audio sync is critical.** Mode B/C will fail if the audio is even 100ms off from when the camera starts. The worker must record the exact `audio_start_offset_ms` from the original video so the frontend can sync.

4. **Skeleton video generation is the riskiest step.** If matplotlib + ffmpeg is slow or produces ugly results, fall back to rendering it client-side from the pose JSON using Canvas (no server file at all). Document the choice in DECISIONS.md.

5. **TikTok embed iframe quirks:** the iframe requires a specific URL format `https://www.tiktok.com/embed/v2/{video_id}`. Extract the video ID from the user-submitted URL using regex. Some shortened URLs (vm.tiktok.com) need to be resolved first via a HEAD request to follow the redirect.

6. **Rate limits:** TikTok will rate-limit if you're hammering it. Add exponential backoff on yt-dlp failures, cap submissions to 1 per session per minute.

7. **Cost watch:** Supabase free tier is fine for ~50 users. Railway/Fly will probably run $5-10/month. Pose extraction on the worker is the most expensive step; consider rate-limiting to 1 concurrent job for now.

---

## Hard rules

1. Do NOT change the math layer (DTW, joint angles, scoring). Those are tested and correct.
2. Do NOT change the knowledge graph structure or loader. The graph stays in `public/data/knowledge_graph.json` and continues to drive readiness/recommender/skills logic.
3. Do NOT delete the existing fixtures file in this commit. Comment it out and keep it for reference until the backend is verified working.
4. Do NOT hardcode any TikTok URLs in the frontend. All dance data flows through the API.
5. Do NOT skip Phase 1 verification. The worker must produce a complete `dances` row end-to-end before any frontend work begins. If the worker pipeline breaks, the rest of the architecture is moot.
6. Commit after each phase so the work is reviewable in chunks.

## Order of operations

Strictly: Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7.

Do not work on later phases in parallel. The backend must be verified working before any UI redesign.

Begin.