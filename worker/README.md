# Groove worker

End-to-end pipeline that turns a TikTok URL into the artifacts Groove's
frontend needs: pose JSON, skeleton mp4, audio wav, thumbnail jpg, plus
auto-detected chunks + skill mapping.

## Pipeline (per SPECK.md §"Worker pipeline")

1. `download.py` — yt-dlp + ffmpeg → mp4 + 22 kHz mono wav
2. `audio_analysis.py` — librosa beat tracker → BPM + beat timestamps
3. `pose.py` — MediaPipe Pose Landmarker per-frame → JSON
4. `chunker.py` — velocity-minima ∩ beats → 2–4 chunks of 3–8 s
5. `skill_mapping.py` — gross-movement heuristics → knowledge-graph skills
6. `skeleton_video.py` — white-on-black skeleton mp4 (cv2 + ffmpeg)
7. `thumbnail.py` — single frame at 1.5 s
8. `store.py` — upload artifacts → Supabase Storage; update `dances` row

## Run modes

```bash
python main.py                                # long-poller (default)
python main.py --once <tiktok-url>            # one-shot, uploads to Supabase
python main.py --once <url> --local-only --out ./out
                                              # one-shot, local artifacts only
```

The local-only mode is how to verify the pipeline before standing up Supabase.

## Deps

- System: `ffmpeg`, `yt-dlp`
- Python: see `requirements.txt`

## Env

Reads `.env` in the worker dir AND `.env.local` in the repo root. Required:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ…
```

(Or `NEXT_PUBLIC_SUPABASE_URL` — both are accepted.)
