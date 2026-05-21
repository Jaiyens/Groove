> ⚠️ **READ FIRST — overnight 2026-05-21 (round 5)**
>
> Round-5 (the five fixes from spec.md) is shipped in seven commits,
> all on `main`. **One blocker remains:** the *production* reprocess
> did NOT push back to Supabase because `SUPABASE_SERVICE_ROLE_KEY` is
> empty in `.env.local`. I extended `worker/reprocess_all.py` with a
> `--local-only` mode and ran it end-to-end against the cached
> hearts2miraaa video pulled from the public storage URL — that
> confirms the new pipeline picks **P2** (the blonde dancer in the
> middle) with **`vlm_confidence = high`**. Artifacts are at
> `/tmp/groove-reprocess/9fff5b9b-7a84-4316-94ed-9ebf943343c4/`.
>
> To actually push the new pose JSON / skeleton mp4 / person thumbs to
> production: paste the service-role key into `.env.local`, apply
> migration `0005_vlm_lead_detection.sql` in the Supabase SQL editor,
> then:
>
> ```bash
> cd worker && source venv/bin/activate
> python reprocess_all.py   # without --local-only
> ```

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
