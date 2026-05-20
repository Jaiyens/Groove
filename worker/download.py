"""yt-dlp wrapper. Downloads the TikTok and extracts a wav for librosa."""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("worker.download")


@dataclass
class DownloadedMedia:
    video_path: Path
    audio_path: Path
    title: str | None
    creator_handle: str | None
    duration_seconds: float
    fps: float


def download_tiktok(url: str, out_dir: Path) -> DownloadedMedia:
    out_dir.mkdir(parents=True, exist_ok=True)

    info_path = out_dir / "info.json"
    video_template = str(out_dir / "video.%(ext)s")

    # yt-dlp does the redirect resolution for short URLs automatically.
    cmd = [
        "yt-dlp",
        "--no-warnings",
        "--no-progress",
        "--retries", "3",
        "--write-info-json",
        "--no-write-playlist-metafiles",
        "-f", "mp4/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
        "--merge-output-format", "mp4",
        "-o", video_template,
        url,
    ]
    _run(cmd)

    # yt-dlp writes <id>.info.json by default; rename for predictability.
    info_jsons = list(out_dir.glob("video.info.json"))
    if not info_jsons:
        info_jsons = list(out_dir.glob("*.info.json"))
    if info_jsons:
        info_jsons[0].rename(info_path)

    video_path = next(out_dir.glob("video.mp4"), None)
    if video_path is None:
        # Some TikToks come down as webm — re-encode to mp4 for downstream tools.
        webm = next(out_dir.glob("video.*"), None)
        if not webm:
            raise RuntimeError("yt-dlp produced no video output")
        video_path = out_dir / "video.mp4"
        _run([
            "ffmpeg", "-y", "-i", str(webm),
            "-c:v", "libx264", "-c:a", "aac",
            str(video_path),
        ])

    info: dict = {}
    if info_path.exists():
        info = json.loads(info_path.read_text())

    title = info.get("title") or info.get("description")
    creator_handle = info.get("uploader") or info.get("uploader_id")
    duration_seconds = float(info.get("duration") or 0.0)
    fps = float(info.get("fps") or 30.0)

    audio_path = out_dir / "audio.wav"
    _run([
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "22050", "-ac", "1",
        str(audio_path),
    ])

    if duration_seconds <= 0:
        # Fallback: read from ffprobe.
        duration_seconds = _probe_duration(video_path)

    return DownloadedMedia(
        video_path=video_path,
        audio_path=audio_path,
        title=title,
        creator_handle=creator_handle,
        duration_seconds=duration_seconds,
        fps=fps,
    )


def _run(cmd: list[str]) -> None:
    log.debug("$ %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f"{cmd[0]} failed: {proc.stderr.strip() or proc.stdout.strip()}"
        )


def _probe_duration(video_path: Path) -> float:
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True, text=True, check=False,
    )
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0
