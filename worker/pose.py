"""Per-frame pose extraction using MediaPipe Tasks PoseLandmarker.

(MediaPipe >= 0.10.30 removed the legacy `mediapipe.solutions` API; this
module uses the Tasks API instead. Model is auto-downloaded on first run.)

Output JSON shape:

    {
      "width": <int>,
      "height": <int>,
      "fps": <float>,
      "frames": [
        { "t_ms": 0, "landmarks": [{x, y, z, visibility}, ..., x33] },
        ...
      ]
    }

Marks the dance `low_quality` if more than 15% of frames have no detection or
low overall confidence (mean visibility < 0.4).
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

log = logging.getLogger("worker.pose")

# pose_landmarker_lite is ~5 MB. Heavy is more accurate but ~2× slower; lite
# is plenty for the 720p-ish vertical phone footage we get from TikTok.
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
)
MODEL_CACHE = Path(
    os.environ.get(
        "GROOVE_POSE_MODEL_CACHE",
        Path.home() / ".cache" / "groove" / "pose_landmarker_lite.task",
    )
)


def _ensure_model() -> Path:
    if MODEL_CACHE.exists():
        return MODEL_CACHE
    MODEL_CACHE.parent.mkdir(parents=True, exist_ok=True)
    log.info("downloading pose landmarker model → %s", MODEL_CACHE)
    urllib.request.urlretrieve(MODEL_URL, MODEL_CACHE)
    return MODEL_CACHE


def extract_pose(video_path: Path, out_path: Path) -> tuple[Path, bool]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"cv2 cannot open {video_path}")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    model_path = _ensure_model()
    options = mp_vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp_vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    frames: list[dict] = []
    misses = 0
    visibilities: list[float] = []

    with mp_vision.PoseLandmarker.create_from_options(options) as landmarker:
        frame_idx = 0
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
            t_ms = int(round((frame_idx / fps) * 1000))
            result = landmarker.detect_for_video(mp_image, t_ms)

            if not result.pose_landmarks:
                frames.append({"t_ms": t_ms, "landmarks": None})
                misses += 1
            else:
                lms = [
                    {
                        "x": float(lm.x),
                        "y": float(lm.y),
                        "z": float(lm.z),
                        "visibility": float(getattr(lm, "visibility", 1.0)),
                    }
                    for lm in result.pose_landmarks[0]
                ]
                frames.append({"t_ms": t_ms, "landmarks": lms})
                visibilities.append(
                    sum(lm["visibility"] for lm in lms) / len(lms)
                )
            frame_idx += 1
    cap.release()

    total = len(frames) or 1
    miss_rate = misses / total
    mean_vis = float(np.mean(visibilities)) if visibilities else 0.0
    low_quality = miss_rate > 0.15 or mean_vis < 0.4

    payload = {
        "width": width,
        "height": height,
        "fps": fps,
        "frame_count": total,
        "miss_rate": miss_rate,
        "mean_visibility": mean_vis,
        "frames": frames,
    }
    out_path.write_text(json.dumps(payload))
    log.info(
        "pose: %d frames, miss_rate=%.2f, mean_vis=%.2f, low_quality=%s",
        total, miss_rate, mean_vis, low_quality,
    )
    return out_path, low_quality
