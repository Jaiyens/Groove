> ⚠️ **READ FIRST — overnight 2026-05-21 (round 5)**
>
> Round-5 (the five fixes from spec.md) is shipped in six commits, all
> on `main`. **One blocker remains:** the production reprocess of the
> existing rows did NOT run because `SUPABASE_SERVICE_ROLE_KEY` is
> empty in `.env.local`. Paste the key from your Supabase project
> settings → API, then run:
>
> ```bash
> cd worker && source venv/bin/activate
> python reprocess_all.py
> ```
>
> Until that runs, the live app still serves the round-4 pose JSON
> (auto_selected_person_id = p13 for @hearts2miraaa), so the wrong
> dancer's skeleton will continue to draw on the REF panel even though
> the new VLM detector picks the right one. The local run of the new
> pipeline against `/tmp/hearts2miraaa.mp4` confirms the VLM picks
> **P2** (the blonde dancer in the middle) with **`vlm_confidence =
> high`** — see commit `e6e715f` and the §Fix 5 verification below.

# Blockers — user action required

## 1. `SUPABASE_SERVICE_ROLE_KEY` is empty in `.env.local`

The key was cleared at some point (line 3 of `.env.local` reads
`SUPABASE_SERVICE_ROLE_KEY=` with nothing after the equals). Without
it:

- `npm run dev` → all `/api/dances/*` routes return HTTP 503
  ("Backend not configured. See SETUP_TODO.md."), so the library
  page renders empty and dance pages stay on "Loading…" forever.
- `worker/reprocess_all.py` aborts with
  `RuntimeError: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars
  are required`.

Get the key from Supabase Dashboard → Settings → API → `service_role`
(JWT starting `eyJ…`) and paste it into `.env.local`. **Do not commit
it.** `.env.local` is gitignored.

Once it's back, run the round-5 schema migration (idempotent) and
reprocess:

```bash
# In Supabase SQL editor, paste contents of:
#   supabase/migrations/0005_vlm_lead_detection.sql

cd worker && source venv/bin/activate
python reprocess_all.py
```

Expected result on @hearts2miraaa: `auto_selected_person_id` flips
from `p13` (round-4 heuristic, wrong dancer) to whichever track id
maps to the centered blonde dancer (verified locally as the VLM's
P2 pick).

## 2. (standing) HTTPS on the dev server (camera access on phone)

Modern browsers block `getUserMedia` on plain HTTP origins except
localhost. To use the phone camera, run the dev server with:

```bash
npm run dev -- --experimental-https
```

Next prints something like `https://192.168.4.38:3001` — visit that URL
on the phone. First load shows a "not trusted" warning; tap through it
("Visit website" on iOS, "Advanced → Proceed" on Chrome).
