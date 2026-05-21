"""Re-run the pose pipeline over every status='ready' dance in Supabase.

SPECK round-4 §"After fixes — re-process the existing dances": the
centroid-tracker pose JSON shipped to existing rows needs to be
replaced with BoT-SORT output. This script downloads each row's cached
video.mp4 + audio.wav from Storage, re-runs the post-download steps of
the pipeline (pose extraction, chunker, skill mapping, skeleton render,
thumbnails), and uploads the new artifacts back. Beats are re-computed
locally from the existing audio.

If a row's video.mp4 is missing or the new run blows up, the row is
marked status='failed' with the error message and the loop continues.

Usage:
    cd worker
    source venv/bin/activate
    python reprocess_all.py             # all ready rows
    python reprocess_all.py --id <uuid> # one specific dance
    python reprocess_all.py --dry-run   # list what would be reprocessed
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import traceback
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

from pipeline import PipelineResult  # noqa: E402

logging.basicConfig(
    level=os.environ.get("WORKER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("worker.reprocess")

WORK_DIR = Path(os.environ.get("WORKER_WORK_DIR", "/tmp/groove-reprocess"))


def fetch(url: str, dest: Path) -> None:
    log.info("download %s", url)
    with urllib.request.urlopen(url, timeout=120) as resp, dest.open("wb") as fh:
        shutil.copyfileobj(resp, fh)


def reprocess_one(store, row: dict) -> bool:
    dance_id = row["id"]
    video_url = row.get("video_url")
    audio_url = row.get("audio_url")
    if not video_url:
        raise RuntimeError("row has no video_url; cannot reprocess without the cached mp4")

    job_dir = WORK_DIR / dance_id
    if job_dir.exists():
        shutil.rmtree(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)

    video_path = job_dir / "video.mp4"
    audio_path = job_dir / "audio.wav"
    fetch(video_url, video_path)

    if audio_url:
        fetch(audio_url, audio_path)
    else:
        # Extract audio from the mp4 with ffmpeg.
        log.info("no audio_url; extracting via ffmpeg")
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", "22050", str(audio_path)],
            check=True, capture_output=True,
        )

    # Probe video for fps + duration (needed by skeleton render).
    import cv2  # noqa: E402
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    duration_s = float(row.get("duration_seconds") or (frame_count / fps if fps else 0.0))

    from audio_analysis import detect_beats  # noqa: E402
    from chunker import auto_chunk  # noqa: E402
    from pose import extract_pose  # noqa: E402
    from skeleton_video import render_skeleton  # noqa: E402
    from skill_mapping import map_skills  # noqa: E402
    from thumbnail import extract_person_thumbnails, extract_thumbnail  # noqa: E402

    log.info("[%s] beats", dance_id)
    beat_info = detect_beats(audio_path)

    log.info("[%s] pose (BoT-SORT)", dance_id)
    pose_path, low_quality = extract_pose(video_path, job_dir / "pose.json")

    log.info("[%s] chunker", dance_id)
    chunks = auto_chunk(pose_path, beat_info.beat_times_seconds, duration_s)

    log.info("[%s] skills", dance_id)
    skills, weights = map_skills(pose_path, chunks)
    for c, ch in zip([c.__dict__ for c in chunks], chunks):
        c["skills"] = ch.skills

    log.info("[%s] skeleton mp4", dance_id)
    sk_path = render_skeleton(pose_path, job_dir / "skeleton.mp4", duration_s=duration_s, fps=fps)

    log.info("[%s] thumbnail", dance_id)
    thumb_path = extract_thumbnail(video_path, job_dir / "thumbnail.jpg", pose_path, duration_s)

    pose_doc = json.loads(pose_path.read_text())
    dancer_count = int(pose_doc.get("dancer_count") or 1)
    auto_id = pose_doc.get("auto_selected_person_id")
    requires_pick = bool(pose_doc.get("requires_dancer_pick"))

    person_thumbs: dict[str, Path] = {}
    if dancer_count > 1:
        person_thumbs = extract_person_thumbnails(
            video_path, pose_path, job_dir / "persons"
        )

    result = PipelineResult(
        url=row.get("tiktok_url", ""),
        out_dir=job_dir,
        title=row.get("title"),
        creator_handle=row.get("creator_handle"),
        duration_seconds=duration_s,
        bpm=beat_info.bpm,
        beats=beat_info.beat_times_seconds,
        chunks=[c.__dict__ for c in chunks],
        required_skills=skills,
        skill_weights=weights,
        pose_data_path=pose_path,
        skeleton_video_path=sk_path,
        video_path=video_path,
        audio_path=audio_path,
        thumbnail_path=thumb_path,
        dancer_count=dancer_count,
        auto_selected_person_id=auto_id,
        requires_dancer_pick=requires_pick,
        person_thumbnails=person_thumbs,
        low_quality=low_quality,
        audio_start_offset_ms=0,
    )

    log.info("[%s] upload artifacts (dancer_count=%d, low_quality=%s)", dance_id, dancer_count, low_quality)
    store.upload_and_finalise(dance_id, result)
    log.info("[%s] DONE", dance_id)
    return True


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--id", help="reprocess a single dance id")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    from store import make_store  # noqa: E402
    store = make_store()

    q = store.client.table("dances").select("*").eq("status", "ready").order("created_at")
    if args.id:
        q = q.eq("id", args.id)
    rows = q.execute().data or []

    if not rows:
        log.warning("no ready dances found")
        return 0

    log.info("found %d dance(s) to reprocess", len(rows))
    for r in rows:
        log.info(
            "  - %s @%s '%s' (%.1fs)",
            r["id"], r.get("creator_handle"), r.get("title"), r.get("duration_seconds") or 0,
        )

    if args.dry_run:
        return 0

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    succeeded, failed = 0, 0
    for row in rows:
        dance_id = row["id"]
        try:
            reprocess_one(store, row)
            succeeded += 1
        except Exception as exc:
            failed += 1
            log.error("[%s] FAILED: %s", dance_id, exc)
            traceback.print_exc()
            try:
                store.mark_failed(dance_id, f"reprocess: {exc}")
            except Exception:
                log.exception("[%s] could not mark failed", dance_id)
    log.info("done — %d succeeded, %d failed", succeeded, failed)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
