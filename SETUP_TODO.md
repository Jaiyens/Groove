# Setup TODO — Jaiyen, do these before the v2 backend works

The v2 build adds a Supabase backend + a Python worker. The code is in place
and self-contained. To wake it up you need to do the following — one-time
setup, ~20 minutes.

---

## 1. Supabase project (5 min)

1. Go to https://app.supabase.com → **New Project**.
   - Name: `groove` (or whatever)
   - Database password: save it somewhere
   - Region: closest to you
2. Wait for the project to provision.
3. From **Settings → API**, copy:
   - `Project URL` (looks like `https://xxxx.supabase.co`)
   - `anon public` key (JWT starting `eyJ…`)
   - `service_role` key (JWT — KEEP SECRET, do not commit)
4. Copy [`.env.example`](.env.example) to `.env.local` at the repo
   root and fill in:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ…
   SUPABASE_SERVICE_ROLE_KEY=eyJ…
   GEMINI_API_KEY=…   # spec.md round-5 §Fix 5; get from aistudio.google.com
   ```

   `GEMINI_API_KEY` powers the worker's primary lead-dancer detector.
   Missing → the worker falls back to a stronger geometric heuristic
   automatically. Cost is ~$0.002 per ingested dance.

5. Apply the migrations. From the Supabase dashboard, open **SQL Editor**,
   paste the contents of each file under
   [`supabase/migrations/`](supabase/migrations/) in numeric order
   (0001, 0002, …, 0005) and run them. (Or use the Supabase CLI:
   `supabase db push` after `supabase login`.) The round-5 migration
   `0005_vlm_lead_detection.sql` adds `vlm_confidence` + `vlm_reasoning`
   columns that the worker writes after detecting the lead dancer.

6. Create two **Storage buckets** (public-read):
   - `pose-data` — for the per-dance pose JSON
   - `skeleton-videos` — for the generated skeleton mp4s
   - `audio` — for the dance audio mp3s
   - `thumbnails` — for dance thumbnails

   In Supabase dashboard: Storage → New bucket → public. Repeat for all four.

---

## 2. Install Node dep (1 min)

```bash
npm install
```

This pulls in `@supabase/supabase-js` (already added to `package.json`).

---

## 3. Python worker (10 min)

The worker lives in [`worker/`](worker/). It runs locally (or you can deploy
to Railway / Fly later — see `worker/DEPLOY.md`).

System deps:

```bash
# macOS
brew install ffmpeg
# (yt-dlp is already installed in this env)
```

Python deps:

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

> ⏱ **First-time install is slow.** `ultralytics` (Round 4 §Fix 1) pulls
> `torch` + `torchvision` wheels — expect 10–20 minutes on a fresh
> machine. The 6 MB `yolo11n-pose.pt` weights download lazily on the
> first `extract_pose` call and are cached in `worker/models/` (also
> gitignored).

Add the Supabase env vars to a `.env` inside `worker/` (the worker uses the
service role key, since it bypasses RLS to write rows):

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ…
```

Start the worker:

```bash
python main.py
```

It will poll the `dances` table for `status='queued'` rows every 5 seconds,
process them end-to-end, and update the row to `status='ready'` (or `failed`
with an error_message).

---

## 4. Verify end-to-end (3 min)

1. Start the Next app: `npm run dev` (port 3000).
2. Start the worker: `cd worker && python main.py`.
3. Open http://localhost:3000.
4. Tap **submit a tiktok** → paste a public TikTok URL (e.g. one of the
   knowledge graph routine sources from `public/data/knowledge_graph.json`).
5. Submit → modal shows polling loading state.
6. Worker logs should show: download → pose extraction → chunking →
   skeleton video → upload → row update.
7. Modal closes when status flips to `ready`, you land on `/dance/<new-id>`.

---

## 5. Seed the library (2 min, only after the above works)

```bash
npm run seed
```

Reads `seed_urls.txt` (already populated with the 8 routine source URLs from
the knowledge graph) and submits each via `POST /api/dances/submit`, polling
until ready.

---

## What if I want to test the frontend without the worker?

The library will be empty. The empty state ("submit your first tiktok") will
show. The submit flow will queue rows but they'll sit at `status='queued'`
forever until a worker picks them up.

For UI-only iteration without Supabase, you can `npm run dev` and the
home page will detect the missing env vars and fall back to the old fixture
library (kept commented out in `lib/dances/fixtures.ts` for emergency
reference).
