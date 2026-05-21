"""Per-frame pose extraction using MediaPipe Tasks PoseLandmarker.

Multi-person aware (Phase 3 / SPECK §3). MediaPipe Pose Landmarker is
configured with num_poses=5 so it returns up to five detections per
frame. A simple centroid tracker assigns stable person IDs across
frames; we then compute a lead_score per person from centrality, size,
forwardness, and persistence, and auto-select the top scorer.

Output JSON shape (frames[] is preserved at top level for backwards
compatibility — those frames are the AUTO-SELECTED person's track, which
is what `lib/pose/referencePose.ts` consumes today):

    {
      "width":  <int>,
      "height": <int>,
      "fps":    <float>,
      "frame_count": <int>,
      "miss_rate":   <float>,         # fraction of frames with NO detection
      "mean_visibility": <float>,
      "low_quality": <bool>,
      "dancer_count": <int>,          # number of distinct tracked persons
      "auto_selected_person_id": <str>,
      "requires_dancer_pick": <bool>, # true when top score is close to 2nd
      "persons": [
        {
          "id": "p0",
          "lead_score": 0.74,
          "centrality": 0.81,         # 1 = exactly centred horizontally
          "size":       0.62,
          "forwardness":0.55,
          "persistence":0.93,
          "bbox":       [x0, y0, x1, y1],  # union bbox in normalized coords
          "frames": [{ "t_ms": int, "landmarks": [...]|None }],
        },
        ...
      ],
      "frames": [ ... auto-selected person's frames ... ]
    }
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

log = logging.getLogger("worker.pose")

# Default to the FULL model per SPECK §4.1 — better limb accuracy on
# real phone footage; about 2× slower than `lite`. Worker is offline so
# the speed hit is acceptable. Override via GROOVE_POSE_MODEL=lite if
# you want the small model.
_MODEL = os.environ.get("GROOVE_POSE_MODEL", "full").lower()
if _MODEL not in {"full", "lite", "heavy"}:
    _MODEL = "full"
MODEL_URL = (
    f"https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    f"pose_landmarker_{_MODEL}/float16/1/pose_landmarker_{_MODEL}.task"
)
MODEL_CACHE = Path(
    os.environ.get(
        "GROOVE_POSE_MODEL_CACHE",
        Path.home() / ".cache" / "groove" / f"pose_landmarker_{_MODEL}.task",
    )
)

# Max tracked persons per frame. Worker uses 5; the spec wanted "all
# detected, up to 5". MediaPipe Pose Landmarker supports multiple poses via
# the num_poses option.
MAX_POSES = 5

# Centroid-tracker tuning.
# Max hip-midpoint distance (in normalized image coords) to match a new
# detection to an existing track. Hip jumps of >25% screen width between
# frames are treated as a different person.
TRACK_MATCH_MAX_DIST = 0.25
# Drop a track if it hasn't been seen for this many ms.
TRACK_DROP_AFTER_MS = 500

# If the top lead_score's gap over second place is below this, the worker
# flags requires_dancer_pick=true and lets the user choose.
PICK_AMBIGUITY_GAP = 0.15


def _ensure_model() -> Path:
    if MODEL_CACHE.exists():
        return MODEL_CACHE
    MODEL_CACHE.parent.mkdir(parents=True, exist_ok=True)
    log.info("downloading pose landmarker model (%s) -> %s", _MODEL, MODEL_CACHE)
    urllib.request.urlretrieve(MODEL_URL, MODEL_CACHE)
    return MODEL_CACHE


@dataclass
class _PersonTrack:
    """Mutable accumulator for one tracked person across the clip."""

    id: str
    frames: list[dict] = field(default_factory=list)
    # Last hip midpoint, used by the next frame's matcher.
    last_centroid: tuple[float, float] | None = None
    last_seen_ms: int = 0
    # Bounding box union (normalized coords), used by thumbnail cropping.
    bbox_x0: float = 1.0
    bbox_y0: float = 1.0
    bbox_x1: float = 0.0
    bbox_y1: float = 0.0
    # Best (largest bbox) frame index for thumbnail extraction.
    thumbnail_frame_idx: int = 0
    thumbnail_bbox_area: float = 0.0
    # Score accumulators (per detected frame).
    centrality_sum: float = 0.0
    size_sum: float = 0.0
    forwardness_sum: float = 0.0
    visibility_sum: float = 0.0
    detected_count: int = 0


def _hip_centroid(lms: list[dict]) -> tuple[float, float] | None:
    # MediaPipe pose landmark indices: 23 = left hip, 24 = right hip.
    if len(lms) < 25:
        return None
    left, right = lms[23], lms[24]
    return ((left["x"] + right["x"]) / 2.0, (left["y"] + right["y"]) / 2.0)


def _bbox(lms: list[dict]) -> tuple[float, float, float, float]:
    xs = [lm["x"] for lm in lms]
    ys = [lm["y"] for lm in lms]
    return (min(xs), min(ys), max(xs), max(ys))


def _feet_y(lms: list[dict]) -> float:
    # MediaPipe: 27 left ankle, 28 right ankle, 31/32 foot index. Use ankles
    # since they're more reliably visible. Higher y = closer to bottom of
    # frame (MediaPipe origin is top-left).
    if len(lms) < 29:
        return 0.5
    return (lms[27]["y"] + lms[28]["y"]) / 2.0


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
        num_poses=MAX_POSES,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    tracks: dict[str, _PersonTrack] = {}
    next_track_id = 0
    total_frames = 0
    no_detection_count = 0

    with mp_vision.PoseLandmarker.create_from_options(options) as landmarker:
        frame_idx = 0
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break
            total_frames += 1
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=frame_rgb)
            t_ms = int(round((frame_idx / fps) * 1000))
            result = landmarker.detect_for_video(mp_image, t_ms)

            detections: list[list[dict]] = []
            for pose_lms in (result.pose_landmarks or []):
                detections.append([
                    {
                        "x": float(lm.x),
                        "y": float(lm.y),
                        "z": float(lm.z),
                        "visibility": float(getattr(lm, "visibility", 1.0)),
                    }
                    for lm in pose_lms
                ])

            if not detections:
                no_detection_count += 1
                # Every existing track gets a "null" frame so its frames
                # array stays time-aligned with the video.
                for tr in tracks.values():
                    tr.frames.append({"t_ms": t_ms, "landmarks": None})
            else:
                # Greedy match: each detection to its nearest existing track
                # within TRACK_MATCH_MAX_DIST.
                used_track_ids: set[str] = set()
                unmatched: list[list[dict]] = []
                # Build (dist, track_id, det_index) triples sorted ascending.
                candidates: list[tuple[float, str, int]] = []
                for di, det in enumerate(detections):
                    c = _hip_centroid(det)
                    if c is None:
                        unmatched.append(det)
                        continue
                    for tr in tracks.values():
                        if tr.last_centroid is None:
                            continue
                        if t_ms - tr.last_seen_ms > TRACK_DROP_AFTER_MS:
                            continue
                        d = (
                            (c[0] - tr.last_centroid[0]) ** 2
                            + (c[1] - tr.last_centroid[1]) ** 2
                        ) ** 0.5
                        if d <= TRACK_MATCH_MAX_DIST:
                            candidates.append((d, tr.id, di))
                candidates.sort()

                matched_det_indices: set[int] = set()
                for _d, tid, di in candidates:
                    if tid in used_track_ids or di in matched_det_indices:
                        continue
                    used_track_ids.add(tid)
                    matched_det_indices.add(di)
                    _append_detection(tracks[tid], detections[di], t_ms, frame_idx)

                # Any detection that didn't match → new track.
                for di, det in enumerate(detections):
                    if di in matched_det_indices:
                        continue
                    tid = f"p{next_track_id}"
                    next_track_id += 1
                    tracks[tid] = _PersonTrack(id=tid)
                    _append_detection(tracks[tid], det, t_ms, frame_idx)
                # Tracks that DIDN'T match this frame: still append a null
                # so their frames stay time-aligned.
                for tid, tr in tracks.items():
                    if tid in used_track_ids:
                        continue
                    if tr.last_seen_ms == 0 and tr.detected_count == 1 and tr.frames[-1]["t_ms"] == t_ms:
                        # Brand-new track that just got created above — already appended.
                        continue
                    if tr.frames and tr.frames[-1]["t_ms"] == t_ms:
                        continue
                    tr.frames.append({"t_ms": t_ms, "landmarks": None})
            frame_idx += 1
    cap.release()

    if not tracks:
        # Nothing detected anywhere. Keep the file shape parseable.
        payload = {
            "width": width,
            "height": height,
            "fps": fps,
            "frame_count": total_frames,
            "miss_rate": 1.0 if total_frames > 0 else 0.0,
            "mean_visibility": 0.0,
            "low_quality": True,
            "dancer_count": 0,
            "auto_selected_person_id": None,
            "requires_dancer_pick": False,
            "persons": [],
            "frames": [],
        }
        out_path.write_text(json.dumps(payload))
        return out_path, True

    persons_payload: list[dict] = []
    for tr in tracks.values():
        if tr.detected_count == 0:
            continue
        n = tr.detected_count
        persistence = n / max(1, total_frames)
        # Normalize each score to [0, 1].
        # centrality: distance from horizontal centre, inverted. avg over detected
        # frames. 0.5 is the centre; max distance = 0.5 → score 0.
        # We accumulated (1 - 2*|x - 0.5|) into centrality_sum.
        centrality = tr.centrality_sum / n
        size = tr.size_sum / n
        forwardness = tr.forwardness_sum / n
        lead_score = (
            0.30 * centrality
            + 0.30 * size
            + 0.20 * forwardness
            + 0.20 * persistence
        )
        bbox = [tr.bbox_x0, tr.bbox_y0, tr.bbox_x1, tr.bbox_y1]
        persons_payload.append(
            {
                "id": tr.id,
                "lead_score": lead_score,
                "centrality": centrality,
                "size": size,
                "forwardness": forwardness,
                "persistence": persistence,
                "visibility": tr.visibility_sum / max(1, n),
                "bbox": bbox,
                "thumbnail_frame_idx": tr.thumbnail_frame_idx,
                "frames": tr.frames,
            }
        )
    persons_payload.sort(key=lambda p: p["lead_score"], reverse=True)

    top = persons_payload[0]
    auto_id = top["id"]
    requires_pick = False
    if len(persons_payload) > 1:
        second = persons_payload[1]
        if top["lead_score"] - second["lead_score"] < PICK_AMBIGUITY_GAP:
            requires_pick = True

    # Top-level frames = the auto-selected person, kept for downstream code
    # that doesn't know about multi-person yet.
    top_frames = top["frames"]

    miss_rate = no_detection_count / max(1, total_frames)
    mean_vis = top["visibility"]
    low_quality = miss_rate > 0.15 or mean_vis < 0.4

    payload = {
        "width": width,
        "height": height,
        "fps": fps,
        "frame_count": total_frames,
        "miss_rate": miss_rate,
        "mean_visibility": mean_vis,
        "low_quality": low_quality,
        "dancer_count": len(persons_payload),
        "auto_selected_person_id": auto_id,
        "requires_dancer_pick": requires_pick,
        "persons": persons_payload,
        "frames": top_frames,
    }
    out_path.write_text(json.dumps(payload))
    log.info(
        "pose: %d frames, %d person(s), top=%s lead=%.2f, pick=%s, low_quality=%s",
        total_frames,
        len(persons_payload),
        auto_id,
        top["lead_score"],
        requires_pick,
        low_quality,
    )
    return out_path, low_quality


def _append_detection(
    tr: _PersonTrack, lms: list[dict], t_ms: int, frame_idx: int
) -> None:
    tr.frames.append({"t_ms": t_ms, "landmarks": lms})
    centroid = _hip_centroid(lms)
    tr.last_centroid = centroid
    tr.last_seen_ms = t_ms
    bbox = _bbox(lms)
    tr.bbox_x0 = min(tr.bbox_x0, bbox[0])
    tr.bbox_y0 = min(tr.bbox_y0, bbox[1])
    tr.bbox_x1 = max(tr.bbox_x1, bbox[2])
    tr.bbox_y1 = max(tr.bbox_y1, bbox[3])

    # Per-frame metric components for the lead_score.
    if centroid is not None:
        # centrality: 1 when centroid is exactly at x=0.5, 0 at edges.
        tr.centrality_sum += max(0.0, 1.0 - 2.0 * abs(centroid[0] - 0.5))
    # size: bbox area as a fraction of the unit image. Clamp to [0, 1].
    area = max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
    tr.size_sum += min(1.0, area * 2.5)  # *2.5 so a 40%-of-frame body scores ~1
    # Capture the best-area frame for the thumbnail crop.
    if area > tr.thumbnail_bbox_area:
        tr.thumbnail_bbox_area = area
        tr.thumbnail_frame_idx = frame_idx
    # forwardness: feet near the bottom of the frame.
    tr.forwardness_sum += min(1.0, _feet_y(lms))
    # mean visibility for low-quality flag.
    tr.visibility_sum += sum(lm["visibility"] for lm in lms) / len(lms)
    tr.detected_count += 1
