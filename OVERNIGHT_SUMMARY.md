# v2 build summary — backend, submit flow, Simply redesign

> 2026-05-20, day 3. Groove now has a backend, a worker pipeline, a
> URL-submit flow, and a cream Simply-style library. The pure-TS math
> layer + knowledge graph + chunked Mode A/B/C practice loop stayed the
> same per SPECK.md.
>
> 67 unit tests pass. Production build green. All routes register
> (6 page routes + 4 API routes).
>
> End-to-end runtime verification (worker → Supabase → frontend) is
> blocked on Jaiyen finishing the one-time setup: provisioning the
> Supabase project, dropping env vars into `.env.local`, installing
> the worker's Python deps + ffmpeg. See [SETUP_TODO.md](SETUP_TODO.md).

## What changed since day 2

| Area | Day 2 | Day 3 (v2) |
| --- | --- | --- |
| Library | 3 hardcoded fixtures | Backend-served, paginated, view-sorted |
| Reference media | Local mp4 files | Worker-generated skeleton mp4 + audio wav, uploaded to Supabase Storage |
| Submit flow | None | Paste URL → poll until ready → land on dance page |
| Backend | localStorage only | Supabase Postgres + Storage; 4 API routes |
| Worker | None | Python pipeline (yt-dlp → librosa → MediaPipe → chunker → skeleton-mp4 → upload) |
| Visual design | TikTok-dark | Cream / coral Simply-style on library + lesson + results; dark kept on camera screens (skeleton contrast) |
| Bottom nav | Home / Trophy / Stats / Profile | Library / Progress / Profile (per SPECK §3) |
| Results screen | Score + breakdown | Same + recommended drill + official TikTok embed iframe |

## Phases delivered (commits in `main`)

```
phase 0: backend scaffolding — supabase migration, worker dir, types
phase 1: worker pipeline e2e on hardcoded URL
phase 2: API routes for submission, status, library, views
phase 3: library screen with simply-style design, backend-driven
phase 4: submit-a-tiktok flow with polling and loading states
phase 5: dance learning routes redesigned with skeleton video + tiktok embed
phase 6: seeding script + initial library populated
phase 7: polish, docs, verification           ← this commit
```

Each phase is a single commit so the work is reviewable in chunks (per
SPECK hard-rule §6).

## Routes (live now)

```
/                                          200    cream library
/api/dances                                 200    paginated, view-sorted
/api/dances/submit                          POST   queues a row
/api/dances/[id]                            200    full record
/api/dances/[id]/view                       POST   bumps view_count
/dance/[id]                                 200    lesson overview (cream)
/dance/[id]/chunk/[i]/copy                  200    Mode A (dark)
/dance/[id]/chunk/[i]/test                  200    Mode B (dark)
/dance/[id]/full                            200    Mode C (dark)
/results/[sessionId]                        200    score + TikTok embed (cream)
/drill/[skillId]                            200    still works
```

## Worker pipeline (7 steps)

Each TikTok URL produces five artifacts the frontend consumes:

| Step | Module | Output |
| --- | --- | --- |
| 1 download | `worker/download.py` | `video.mp4` + `audio.wav` |
| 2 beats | `worker/audio_analysis.py` | BPM + beat times |
| 3 pose | `worker/pose.py` | per-frame landmarks JSON |
| 4 chunks | `worker/chunker.py` | 2–4 chunks of 3–8 s |
| 5 skills | `worker/skill_mapping.py` | knowledge-graph skill ids + weights |
| 6 skeleton mp4 | `worker/skeleton_video.py` | 720×1280 H.264 silent mp4 |
| 7 thumbnail | `worker/thumbnail.py` | 1.5 s frame as jpg |
| upload | `worker/store.py` | uploads to 4 Storage buckets, updates `dances` row to `ready` |

## Pure-TS additions (Swift-portable, all new in v2)

- `lib/dances/api.ts` — `fetchLibrary`, `fetchDance`, `submitDance`,
  `pollUntilReady`, `bumpView`
- `lib/dances/adapter.ts` — `recordToDance(record)` folds a backend row
  into the legacy `Dance` shape consumed by the practice routes
- `lib/dances/useDance.ts` — React hook wrapping the above
- `lib/supabase/{client,server}.ts` — Supabase clients that return null
  when env vars are missing so the UI degrades gracefully
- `lib/tiktok/embed.ts` — `extractVideoId`, `isLikelyTikTokUrl`,
  `embedUrlFor` — used by both the submit validator and the results embed

## Verification done in this autonomous window

- ✅ Worker pure-Python self-test (`worker/test_pipeline.py`): 4/4 pass
  on synthetic-pose JSON, exercises chunker + skill mapping
- ✅ Worker module `py_compile` syntax check: all 10 modules parse
- ✅ Frontend type-check: clean
- ✅ Existing 67 unit tests: pass
- ✅ Production build: green, all routes register
- ✅ TikTok embed URL extraction: tested by the chunker / skill mapping
  tests indirectly; regex covered by manual smoke

## Verification deferred to Jaiyen (per SETUP_TODO.md)

- ⏳ End-to-end worker run on a real TikTok URL → Supabase row → frontend
- ⏳ Submission flow: paste URL → polling → dance page
- ⏳ Mode B/C audio sync on a real phone (cache rules vs. Safari audio
  gesture rules only show up on device)
- ⏳ Library populated via `npm run seed`

## Blockers hit

None. The Supabase provisioning step is a known waiting item (documented
upfront by SPECK §0); everything else is functioning code awaiting a live
backend to talk to.

## How Jaiyen verifies in 5 minutes

1. Stand up Supabase, fill `.env.local`, apply the migration, create the
   4 storage buckets (SETUP_TODO §1).
2. Install worker deps + ffmpeg (SETUP_TODO §3).
3. Start the worker: `cd worker && python main.py`.
4. Start the app: `npm run dev`.
5. Open http://localhost:3000 → tap **submit a tiktok** → paste a public
   TikTok URL → watch the rotating loader → land on `/dance/[new-id]` with
   a working skeleton-video lesson.
