"""Thumbnail extraction.

`extract_thumbnail` produces the single library thumbnail (1.5s in).
`extract_person_thumbnails` (Phase 3 / SPECK §3) crops one jpg per
tracked person, taken from the frame where that person's bounding box
was largest. Output paths are returned in the same order as `persons`.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import cv2

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


def extract_person_thumbnails(
    video_path: Path,
    pose_json_path: Path,
    out_dir: Path,
) -> dict[str, Path]:
    """Per-person crops, keyed by person id. Empty dict when single-person.

    Reads the pose JSON for each person's `bbox` (union over the clip) and
    `thumbnail_frame_idx` (the largest-bbox frame). Crops a square-ish
    region around the bbox with a 15% padding so the head/feet aren't
    chopped, writes JPGs to `out_dir/person-<id>.jpg`.
    """
    payload = json.loads(pose_json_path.read_text())
    persons = payload.get("persons") or []
    if len(persons) <= 1:
        return {}

    width = int(payload.get("width") or 0)
    height = int(payload.get("height") or 0)
    fps = float(payload.get("fps") or 30.0)
    if width == 0 or height == 0:
        return {}

    out_dir.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return {}

    results: dict[str, Path] = {}
    try:
        for p in persons:
            frame_idx = int(p.get("thumbnail_frame_idx") or 0)
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ok, frame = cap.read()
            if not ok:
                # Fallback to the second-most-likely frame: 1 second in.
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(fps))
                ok, frame = cap.read()
                if not ok:
                    continue
            x0, y0, x1, y1 = p.get("bbox") or [0.0, 0.0, 1.0, 1.0]
            # Add 15% padding to the union bbox.
            px = 0.15 * (x1 - x0)
            py = 0.15 * (y1 - y0)
            x0 = max(0.0, x0 - px)
            y0 = max(0.0, y0 - py)
            x1 = min(1.0, x1 + px)
            y1 = min(1.0, y1 + py)
            cx0, cy0 = int(x0 * width), int(y0 * height)
            cx1, cy1 = int(x1 * width), int(y1 * height)
            if cx1 - cx0 < 16 or cy1 - cy0 < 16:
                continue
            crop = frame[cy0:cy1, cx0:cx1]
            out_path = out_dir / f"person-{p['id']}.jpg"
            cv2.imwrite(str(out_path), crop, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            results[p["id"]] = out_path
    finally:
        cap.release()
    return results
