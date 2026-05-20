"""Render a white-skeleton-on-black mp4 from the pose JSON.

Uses OpenCV to draw frames + ffmpeg to encode. Output is silent, same fps as
the original, same duration. The frontend's Mode A plays this back at
50/75/100% speed.

If pose tracking is missing for a frame, we render an empty black frame so
the video stays length-matched to the original.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import cv2
import numpy as np

log = logging.getLogger("worker.skeleton")

WIDTH = 720
HEIGHT = 1280

# MediaPipe pose connections (subset matching its drawing utility's POSE_CONNECTIONS)
POSE_CONNECTIONS = [
    # face
    (0, 1), (1, 2), (2, 3), (3, 7),
    (0, 4), (4, 5), (5, 6), (6, 8),
    # shoulders
    (9, 10),
    (11, 12),
    # arms
    (11, 13), (13, 15),
    (12, 14), (14, 16),
    (15, 17), (17, 19), (19, 21), (15, 21),
    (16, 18), (18, 20), (20, 22), (16, 22),
    # torso
    (11, 23), (12, 24), (23, 24),
    # legs
    (23, 25), (25, 27), (27, 29), (29, 31), (27, 31),
    (24, 26), (26, 28), (28, 30), (30, 32), (28, 32),
]


def render_skeleton(
    pose_json_path: Path,
    out_path: Path,
    duration_s: float,
    fps: float,
) -> Path:
    pose = json.loads(Path(pose_json_path).read_text())
    frames = pose["frames"]
    if not frames:
        raise RuntimeError("no pose frames to render")
    frame_fps = float(pose.get("fps") or fps or 30.0)

    raw_path = out_path.with_suffix(".raw.mp4")
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(raw_path), fourcc, frame_fps, (WIDTH, HEIGHT))
    if not writer.isOpened():
        raise RuntimeError("cv2.VideoWriter would not open")

    for frame in frames:
        canvas = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
        lms = frame.get("landmarks")
        if lms is not None:
            _draw_skeleton(canvas, lms)
        writer.write(canvas)
    writer.release()

    # Re-encode to H.264 + faststart so the browser can play it inline.
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(raw_path),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-an",
            str(out_path),
        ],
        check=True, capture_output=True,
    )
    raw_path.unlink(missing_ok=True)
    log.info("skeleton mp4: %s (%d frames @ %.2f fps)", out_path, len(frames), frame_fps)
    return out_path


def _draw_skeleton(canvas: np.ndarray, lms: list[dict]) -> None:
    pts = [
        (int(lm["x"] * WIDTH), int(lm["y"] * HEIGHT), lm.get("visibility", 1.0))
        for lm in lms
    ]
    # bones
    for a, b in POSE_CONNECTIONS:
        if a >= len(pts) or b >= len(pts):
            continue
        xa, ya, va = pts[a]
        xb, yb, vb = pts[b]
        if va < 0.3 or vb < 0.3:
            continue
        cv2.line(canvas, (xa, ya), (xb, yb), (255, 255, 255), thickness=4, lineType=cv2.LINE_AA)
    # joints
    for x, y, v in pts:
        if v < 0.3:
            continue
        cv2.circle(canvas, (x, y), 6, (255, 255, 255), thickness=-1, lineType=cv2.LINE_AA)
