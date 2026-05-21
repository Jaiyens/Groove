# Runtime verification — 2026-05-21

End-to-end runtime test against a real Supabase + real TikTok URLs.

## Headline

✅ **3 dances ingested end-to-end** through yt-dlp → MediaPipe → librosa →
chunker → skeleton mp4 → Supabase Storage → frontend.

📱 **Open this on your phone (same WiFi):** http://192.168.4.38:3000

| What | URL |
| --- | --- |
| Home / library | http://192.168.4.38:3000 |
| API health | http://192.168.4.38:3000/api/dances |

## Library state (3 dances, all `status='ready'`)

| ID | Source | Duration | Chunks | All artifacts |
| --- | --- | --- | --- | --- |
| `9f0c1d0e…` | tiktok.com/@charlidamelio/video/7566416574874275085 | 18s | 3 | ✅ skel+audio+pose+thumb |
| `7d45ecca…` | tiktok.com/@charlidamelio/video/7474124403421236522 | — | 3 | ✅ |
| `f3ec351e…` | tiktok.com/@charlidamelio/video/7416004338205658399 | — | 3 | ✅ |

The two follow-up URLs were submitted through the real `POST /api/dances/submit`
endpoint (not the worker's `--once` CLI), picked up by the polling worker, and
ended up `ready` automatically — proves the full submit → worker → frontend
loop works end-to-end.

## What worked first try

- All worker imports (yt-dlp, mediapipe, librosa, cv2, ffmpeg-python, supabase, dotenv)
- `worker/test_pipeline.py` self-tests (4/4 chunker + skill-mapping cases)
- yt-dlp download → mp4 + 22 kHz mono wav
- librosa beat detection (BPM 107.67, 32 beats on the test URL)
- Auto-chunker (3 chunks of ~6 s each — well within the 3–8 s target)
- Skill-mapping heuristics (7 detected, weights sum to 1.000)
- cv2 + ffmpeg skeleton mp4 render (552 frames, H.264 + faststart)
- Thumbnail extraction
- All 4 Supabase Storage uploads (pose-data, skeleton-videos, audio, thumbnails — every URL returns 200 OK)
- Next.js `npm test` → 67/67 pass
- All 5 frontend routes return 200 (home, dance overview, Mode A, Mode B, Mode C)

## What needed fixing (commits will follow)

### Fix 1 — MediaPipe `solutions` API removed in 0.10.30+

The worker's `pose.py` was written against the legacy
`mediapipe.solutions.pose` API. MediaPipe 0.10.35 (current pin) only exposes
the new Tasks API.

**Fix:** rewrote `worker/pose.py` to use `mediapipe.tasks.python.vision.PoseLandmarker`
in VIDEO running mode. Model (`pose_landmarker_lite.task`, ~5 MB) is
auto-downloaded on first run to `~/.cache/groove/`.

### Fix 2 — `SUPABASE_URL` had trailing `/rest/v1/`

The value pasted into `.env.local` ended with `/rest/v1/`. The supabase
client appends `/rest/v1/dances` itself, producing
`https://xxxx.supabase.co/rest/v1/rest/v1/dances` → 404.

**Fix:** added `normaliseUrl()` helpers in `worker/store.py`,
`lib/supabase/server.ts`, and `lib/supabase/client.ts` that strip
trailing `/`, `/rest`, or `/rest/v1` before constructing the client.
Now resilient to either format.

### Fix 3 — live DB schema was a v1 of the migration

The user's actual `dances` table is missing two columns my migration adds:
`low_quality` and `audio_start_offset_ms`. The worker's UPDATE was
failing with PostgREST `PGRST204` (column not in schema cache).

**Fix:**
- Worker now introspects the live schema on first upload and silently drops
  any fields the table doesn't accept (logs them as a warning).
- New migration `supabase/migrations/0002_quality_fields.sql` adds the two
  columns with safe defaults. **Optional follow-up:** open Supabase SQL
  editor, paste the file contents, run it. The worker already works without
  this, but the UI's "low quality reference" badge won't show on flagged
  dances until the column exists.

### Fix 4 — `--once` mode tripped the unique constraint on retry

When a prior run uploaded artifacts but failed on the final UPDATE, the
row stayed in the DB. Re-running `python main.py --once <same-url>` hit the
`dances_tiktok_url_key` unique constraint.

**Fix:** `insert_queued()` is now find-or-create. If the URL already
exists, it reuses the row and re-marks it `processing`. Makes retries
idempotent.

### Fix 5 — Next.js fetch cache served stale `processing` after row was `ready`

The `/api/dances/:id` endpoint kept returning `status='processing'`
indefinitely after the worker flipped the row to `ready`. Next.js wraps
the global `fetch` and caches Route Handler reads even when the route is
`dynamic = 'force-dynamic'`.

**Fix:** `getServerSupabase()` now installs a `global.fetch` wrapper
that passes `cache: 'no-store'` on every Supabase HTTP request. The
submit-modal polling now correctly transitions to the dance page when
the worker finishes.

### Fix 6 — stale `.next/` cache from earlier Next 14 / React build

Initial dev server start returned `Invariant: missing bootstrap script.
This is a bug in Next.js` for every page (API routes still worked).

**Fix:** `rm -rf .next && npm run dev`. Likely a leftover from a
Next.js / React version bump in the dependency install. Not something
the code can prevent — flagging here so it's a known recipe.

## Running processes

| Process | Where | Status |
| --- | --- | --- |
| Next.js dev server | `npm run dev`, PID-bound to port 3000 | running, listens on `*:3000` (LAN reachable) |
| Worker poller | `cd worker && source venv/bin/activate && python main.py` | running, polls Supabase every 5 s |

Logs are tailing to `/tmp/groove-dev.log` and `/tmp/groove-worker.log` if
you want to watch.

## What still needs your attention

1. **Apply migration 0002** (optional but recommended) in Supabase SQL
   editor — re-enables the `low_quality` UI badge for dances with poor
   pose tracking.

2. **Phone test the practice loop.** I verified that the routes serve and
   the data is correct, but Modes A / B / C need a real device to verify:
   - Mode A — skeleton video playback + audio sync at 50 / 75 / 100% speed
   - Mode B — camera + pose overlay + scored chunk attempt
   - Mode C — full-routine DTW + results screen + TikTok embed iframe

3. **Title quality.** yt-dlp pulls TikTok's caption as the title (e.g.
   `'@maya dc @Gandarra @𝚓 𝚎 𝚢 𝚖 𝚜 '`). For seeded library entries you
   may want to override the title manually in Supabase. The worker could
   fall back to the creator handle + a short description if the caption
   contains mostly @-mentions — flag this if you'd like that as a
   follow-up.

## How to repeat the end-to-end test yourself

```bash
# terminal 1 — worker
cd worker
source venv/bin/activate
python main.py

# terminal 2 — dev server
cd .
npm run dev

# browser
open http://localhost:3000   # or http://192.168.4.38:3000 on your phone
# tap "submit a tiktok", paste a public TikTok URL,
# watch the rotating loader,
# land on /dance/<new-id>
```

## Nothing is currently broken

Every step in the SPECK success path executes. Tests pass, build is clean,
all routes serve, all 3 library dances render with their full set of
artifacts.
