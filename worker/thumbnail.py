"""Extract a representative frame from the video for the library thumbnail."""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

log = logging.getLogger("worker.thumbnail")


def extract_thumbnail(video_path: Path, out_path: Path, at_seconds: float = 1.5) -> Path:
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(at_seconds),
            "-i", str(video_path),
            "-frames:v", "1",
            "-q:v", "3",
            str(out_path),
        ],
        check=True, capture_output=True,
    )
    log.info("thumbnail: %s", out_path)
    return out_path
