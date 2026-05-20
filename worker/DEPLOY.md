# Worker deployment

## Local (fastest)

```bash
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.local .env  # or write SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY here
python main.py
```

The worker polls Supabase every 5s for `status='queued'` rows. Leave it running
in a terminal during demos.

## Railway

1. `railway init` in `worker/`.
2. Set env vars in the dashboard: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
3. Add a healthcheck command (optional): the worker is a long-running poller
   with no HTTP surface — set the deploy as a worker, not a web service.

## Fly.io

```bash
cd worker
fly launch --no-deploy
fly secrets set SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…
fly deploy
```

The Dockerfile is set up with ffmpeg baked in. Pose extraction is the most
expensive step — pin to at least 1 CPU / 1 GB RAM. Concurrency cap: 1 job at a
time. The worker checks for queued rows in a single thread.

## One-shot single-URL run

For verifying Phase 1 manually:

```bash
python main.py --once https://www.tiktok.com/@kpopwithjun/video/7497823641193254151
```

That runs the full pipeline on the given URL with no polling, uploads to
Supabase, and exits.

## Local-only (no Supabase) verification

```bash
python main.py --once https://… --local-only --out ./out
```

Writes all artifacts (video, audio, pose JSON, skeleton mp4, thumbnail) to
`./out` without touching Supabase. Useful for verifying the pipeline before
wiring up the database.
