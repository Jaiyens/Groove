# Groove — web prototype

iOS-bound app that teaches users to dance TikTok choreography. Submit a
TikTok URL → a Python worker downloads it, extracts per-frame pose with
MediaPipe, detects beats with librosa, and auto-chunks the routine. The
frontend plays the worker-generated skeleton mp4 as a copy-along reference,
scores the user's camera feed against the routine using DTW, and embeds the
official TikTok on the results screen.

> **Status (2026-05-20, day 3 / v2):** library + submit flow + worker
> pipeline shipped. End-to-end runtime verification needs Jaiyen to provision
> Supabase + install Python deps — see [SETUP_TODO.md](SETUP_TODO.md).

## Stack

- **Frontend** — Next.js 14 (App Router) + TypeScript strict, Tailwind CSS
  with a cream Simply-style palette
- **MediaPipe Pose Landmarker** for browser-side body tracking (WASM, 33
  landmarks)
- **Backend** — Supabase Postgres + Storage, served via Next.js API routes
- **Worker** — Python (yt-dlp, MediaPipe, librosa, OpenCV, ffmpeg) running
  as a separate process; polls Supabase every 5s for queued submissions
- **Zod** for runtime validation of the knowledge graph JSON
- **localStorage** for mastery + chunk progression (per-device, no auth)

Pure-TS modules (`lib/pose`, `lib/scoring`, `lib/graph`, `lib/mastery`,
`lib/audio`, `lib/tiktok`) have zero DOM dependencies and port to Swift
one-for-one.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build
npm test             # 67 unit tests
npm run seed         # populate the library from seed_urls.txt
```

Backend setup (one-time):

```bash
# follow SETUP_TODO.md
# 1. Provision a Supabase project, paste env vars into .env.local
# 2. Apply supabase/migrations/0001_init.sql
# 3. Create storage buckets: pose-data, skeleton-videos, audio, thumbnails
```

Worker (one-time):

```bash
brew install ffmpeg            # macOS
cd worker
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py                 # long-running poller
# or one-shot:
python main.py --once <tiktok-url> --local-only --out ./out
```

## Routes

| Route | What it does |
| --- | --- |
| `/` | Library: featured dance + trending + recents, submit fab |
| `/api/dances` | GET — paginated list of ready dances, sorted by views |
| `/api/dances/submit` | POST — queue a new submission |
| `/api/dances/:id` | GET — full row incl. status (used by polling) |
| `/api/dances/:id/view` | POST — increment view_count |
| `/dance/[id]` | Lesson overview — chunk path + full attempt CTA |
| `/dance/[id]/chunk/[i]/copy` | Mode A — skeleton mp4 + audio, looped |
| `/dance/[id]/chunk/[i]/test` | Mode B — camera + skeleton overlay, audio |
| `/dance/[id]/full` | Mode C — full attempt, audio only |
| `/results/[sessionId]` | Score + skill breakdown + TikTok embed |
| `/drill/[skillId]` | Drill an individual skill |

## Practice loop (unchanged from day 2)

| Mode | Where the reference comes from | What's scored |
| --- | --- | --- |
| A — copy-along | worker's skeleton mp4 (`skeleton_video_url`) | nothing — just mirror practice |
| B — test | user camera + skeleton overlay; audio from `audio_url` | chunk-scoped DTW |
| C — full | audio only | full routine DTW |

Mode A loops the chunk's `[startMs, endMs]` window at 50 / 75 / 100% speed.
Mode B unlocks the next chunk when score ≥ 70. Mode C requires every chunk
to have passed.

## Architecture

```
app/                  ← Next.js App Router pages + /api/ routes
  api/dances/         ← submit, list, get, view-bump endpoints
  dance/              ← lesson overview + Mode A/B/C
  results/            ← scored results + TikTok embed

components/
  library/            ← Simply-style home (Hero / Trending / Recent / Fab)
  lesson/             ← ChunkPath, ProcessingState, TikTokEmbed
  submit/             ← SubmitModal (input → loading → error)
  (existing)          ← PhoneFrame, SkeletonOverlay, ScoreBreakdown, ...

lib/
  audio/              ← useDanceAudio hook
  dances/             ← types, API client, useDance hook, recordToDance
                        adapter, legacy fixtures (kept for reference)
  graph/              ← Zod loader, readiness, chunker, recommender
  mastery/            ← localStorage EMA + chunk progress
  pose/               ← MediaPipe wrapper + projection + joint angles
  scoring/            ← DTW + similarity + scorer + beat tracker
  supabase/           ← browser (anon) + server (service role) clients
  tiktok/             ← URL regex + embed URL builder

supabase/
  migrations/         ← 0001_init.sql

worker/
  main.py             ← polling loop / --once mode
  pipeline.py         ← 7-step orchestration
  download / audio_analysis / pose / chunker / skill_mapping /
  skeleton_video / thumbnail / store

public/data/
  knowledge_graph.json   ← 46-node graph (8 routines × 5 skill layers)
  reference_dances/      ← legacy mp4s (commented out of UI)
```

## Data model

Dances live in Supabase Postgres:

```sql
dances (
  id uuid PRIMARY KEY,
  tiktok_url text UNIQUE,
  status text CHECK (status in ('queued','processing','ready','failed')),
  title, creator_handle, duration_seconds, bpm,
  thumbnail_url, pose_data_url, skeleton_video_url, audio_url,
  chunks_json, required_skills, skill_weights,
  view_count, low_quality, audio_start_offset_ms,
  ...
)
```

Storage buckets: `pose-data`, `skeleton-videos`, `audio`, `thumbnails`.

The frontend reads via `GET /api/dances` (list, sorted by views) and
`GET /api/dances/:id` (poll while queued/processing).

## Deploy

```bash
# Frontend (Vercel)
vercel --prod
# Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#      SUPABASE_SERVICE_ROLE_KEY

# Worker (Railway / Fly — see worker/DEPLOY.md)
cd worker
fly launch --no-deploy
fly secrets set SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…
fly deploy
```

## License

Private prototype. Don't redistribute reference TikTok footage.
