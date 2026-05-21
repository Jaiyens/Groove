# Blockers — user action required

Items the autonomous fix pass cannot complete on its own. None are fatal —
the rest of the work continues; these only unblock specific verification or
quality-of-life improvements.

---

## 1. Apply migrations in Supabase

Two new migrations from this fix pass need to be applied:

```sql
-- supabase/migrations/0003_video_url.sql   (Phase 1.1)
-- supabase/migrations/0004_multi_person.sql (Phase 3)
```

Both are `alter table ... add column if not exists` — idempotent and
safe to re-run.

### 1a. `0003_video_url.sql`

Phase 1.1 (new Mode A) adds a `video_url` column to `dances`. Until you run
this migration, the worker can still upload artifacts but `video_url` will
be silently dropped (the worker's schema-introspection layer drops unknown
columns — see RUNTIME_VERIFICATION.md fix #3).

**Steps:**

1. Supabase dashboard → SQL Editor → New query
2. Paste the contents of `supabase/migrations/0003_video_url.sql`
3. Run

Idempotent — safe to run again.

### 1b. `0004_multi_person.sql`

Adds the columns Phase 3 (multi-person dance) needs:

- `dancer_count int default 1`
- `auto_selected_person_id text`
- `person_thumbnails jsonb`
- `requires_dancer_pick boolean default false`

## 2. Create the `videos` and `person-thumbnails` storage buckets in Supabase

Two new buckets:

| Bucket | Why |
| --- | --- |
| `videos` | Mode A's duet view plays the original TikTok mp4 from here. |
| `person-thumbnails` | Pick-a-dancer screen reads per-person crops from here when the video has 2+ dancers. |

**Steps (for each):**

1. Supabase dashboard → Storage → New bucket
2. Public: **yes** (same as `skeleton-videos`)
3. Create

After this, restart the worker (it caches the schema on first poll, so a
restart re-introspects new columns).

## 3. Re-process the three existing library dances

The existing rows in `dances` were ingested before `video_url` /
`videos` bucket existed. They will keep working — Mode A falls back to the
skeleton video for any row whose `video_url` is null — but you'll only see
Charli's actual body once the row has both.

**Two options:**

A. **Re-run the worker on each URL** (cleanest, gives a fresh download,
   updated titles, and populates video_url):

   ```bash
   cd worker
   source venv/bin/activate
   # for each tiktok_url in the dances table
   python main.py --once <tiktok_url>
   ```

B. **Just refresh titles in-place** (faster, leaves video_url null):

   ```bash
   cd worker
   source venv/bin/activate
   python refresh_titles.py
   # add --dry-run first to preview the proposed titles
   ```

## 4. Enable HTTPS on the dev server (camera access on phone)

Modern browsers block `getUserMedia` on plain HTTP origins except
`localhost`. Right now the LAN URL is `http://192.168.4.38:3000`, which
silently denies camera access on iOS Safari and Chrome — that's the root
cause of "no camera" in Mode A on a real phone (the code is fine; the
origin is the problem).

**Pick one:**

A. **Next.js built-in `--experimental-https`** (zero-config, recommended):

   ```bash
   npm run dev -- --experimental-https
   # Next prints something like https://192.168.4.38:3001 — visit that
   # URL on your phone. First load shows a "not trusted" warning; tap
   # through it ("Visit website" on iOS, "Advanced -> Proceed" on Chrome).
   ```

   The browser will then prompt for camera permission as normal.

B. **`mkcert` for a properly-trusted local CA** (no warning):

   ```bash
   brew install mkcert nss
   mkcert -install
   mkcert localhost 192.168.4.38
   # Move the generated .pem files into ./certs/, then:
   HTTPS=true SSL_CRT_FILE=./certs/192.168.4.38+1.pem \
   SSL_KEY_FILE=./certs/192.168.4.38+1-key.pem npm run dev
   ```

Until HTTPS is on, Mode A's camera UI will show the "Camera blocked"
banner with a one-tap "request access" button — but the browser will
refuse to even prompt the user. The banner explains why.

## 5. (Optional) Provide a 2-dancer TikTok URL for Phase 3 verification

Phase 3 ships multi-person dance detection. Verifying the "pick a dancer"
flow needs a TikTok with 2+ people clearly dancing in-frame for most of
the clip. Drop a URL here when convenient — until then, Phase 3 ships
with the worker change + UI, but the verification pass uses a synthetic
2-person pose fixture rather than a real TikTok.

---

Update this file as items get resolved. Items removed once they're done.
