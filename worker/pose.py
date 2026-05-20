"""Per-frame pose extraction using MediaPipe Pose Landmarker.

Output JSON shape (matches what `lib/scoring/scorer.ts` expects to consume
once a frontend loader is wired up):

    {
      "width": <int>,
      "height": <int>,
      "fps": <float>,
      "frames": [
        { "t_ms": 0, "landmarks": [{x, y, z, visibility}, …, x33] },
        …
      ]
    }

Marks the dance `low_quality` if more than 15% of frames have no detection or
low overall confidence (mean visibility < 0.4).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import cv2
import mediapipe as mp

log = logging.getLogger("worker.pose")

POSE_LANDMARKER = mp.solutions.pose


def extract_pose(video_path: Path, out_path: Path) -> tuple[Path, bool]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"cv2 cannot open {video_path}")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    frames: list[dict] = []
    misses = 0
    visibilities: list[float] = []

    with POSE_LANDMARKER.Pose(
        static_image_mode=False,
        model_complexity=1,
        smooth_landmarks=True,
        enable_segmentation=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as pose:
        frame_idx = 0
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            result = pose.process(frame_rgb)
            t_ms = int(round((frame_idx / fps) * 1000))
            if result.pose_landmarks is None:
                frames.append({"t_ms": t_ms, "landmarks": None})
                misses += 1
            else:
                lms = [
                    {
                        "x": float(lm.x),
                        "y": float(lm.y),
                        "z": float(lm.z),
                        "visibility": float(lm.visibility),
                    }
                    for lm in result.pose_landmarks.landmark
                ]
                frames.append({"t_ms": t_ms, "landmarks": lms})
                visibilities.append(
                    sum(lm["visibility"] for lm in lms) / len(lms)
                )
            frame_idx += 1
    cap.release()

    total = len(frames) or 1
    miss_rate = misses / total
    mean_vis = sum(visibilities) / len(visibilities) if visibilities else 0.0
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
