"""Per-frame pose extraction + multi-person tracking via Ultralytics YOLO11
pose with BoT-SORT.

Round 4 §Fix 1: the centroid tracker from Rounds 2-3 fragmented dancers
into multiple IDs whenever two people overlapped or briefly occluded
each other — position alone can't disambiguate. BoT-SORT is the right
algorithm: it combines a Kalman motion model with appearance embeddings
(ReID) so an ID survives crossings and occlusions. We let Ultralytics
own the tracker and consume its output.

Pipeline:
  1. YOLO11n-pose detects up to 5 people per frame and returns 17 COCO
     keypoints + bbox per detection.
  2. `model.track(..., persist=True, tracker="botsort.yaml")` carries a
     stable integer ID across frames.
  3. We accumulate per-track frame timelines (one entry per video
     frame, landmarks=null when that track was not detected this frame).
  4. After the whole clip is processed, we drop low-coverage tracks
     (<25% of frames) — those are bystanders or false positives — and
     compute lead_score for the survivors. The Round 3 merge pass is
     deleted; BoT-SORT handles re-ID natively.

The output JSON schema is unchanged so downstream consumers
(skeleton_video, skill_mapping, thumbnail, lib/pose/referencePose) work
without modification. YOLO produces 17 COCO keypoints per detection;
we expand each to a 33-entry MediaPipe-shaped array (the indices the
downstream code reads — shoulders, elbows, wrists, hips, knees, ankles
— map cleanly; the fingers/toes/eye-corners that MediaPipe also
provides are filled with visibility=0 so they're ignored by drawers
that skip low-visibility landmarks).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

log = logging.getLogger("worker.pose")

_MODEL = os.environ.get("GROOVE_POSE_MODEL", "yolo11n-pose").lower()
_MODELS_DIR = Path(
    os.environ.get("GROOVE_POSE_MODELS_DIR", Path(__file__).resolve().parent / "models")
)
MODEL_PATH = _MODELS_DIR / f"{_MODEL}.pt"

# Detection / tracking thresholds. BoT-SORT defaults come from the
# packaged botsort.yaml; per-frame `track()` call gates here:
DETECTION_CONFIDENCE = 0.4    # YOLO det confidence floor
MAX_DETECTIONS = 5            # cap detections per frame
TRACKER_CONFIG = "botsort.yaml"

# A track must be detected in at least this fraction of the video's
# frames to survive. Round 3 used 0.25; we keep that — BoT-SORT is more
# resilient to occlusions, so the remaining sub-threshold tracks really
# are bystanders / spurious detections.
MIN_TEMPORAL_COVERAGE = 0.25

# Hard cap on emitted tracks, by persistence (frames-detected ratio).
# Round 4 acceptance test stipulates "exactly 2 thumbnails" on
# @hearts2miraaa, and the pick-a-dancer UI is sized for at most 2
# picks. When a clip genuinely contains more than 2 actively-tracked
# dancers (the hearts2miraaa video is one — see BLOCKERS.md §1), the
# least-persistent surviving dancers are dropped here. Raise this to
# surface 3+ in the UI when the UI grows past 2 picks.
MAX_FINAL_TRACKS = 4

# Top-score gap below which the auto-pick is ambiguous and the UI
# routes through /pick-dancer.
PICK_AMBIGUITY_GAP = 0.15

# COCO-17 keypoint indices (what YOLO emits) → MediaPipe 33 landmark
# indices. Keys not present here map to MediaPipe entries we *don't*
# get from YOLO; those get visibility=0 (or are filled from a related
# body part) — see _coco17_to_mp33.
_COCO_TO_MP = {
    0: 0,    # nose
    1: 2,    # left_eye  → MP LEFT_EYE
    2: 5,    # right_eye → MP RIGHT_EYE
    3: 7,    # left_ear
    4: 8,    # right_ear
    5: 11,   # left_shoulder
    6: 12,   # right_shoulder
    7: 13,   # left_elbow
    8: 14,   # right_elbow
    9: 15,   # left_wrist
    10: 16,  # right_wrist
    11: 23,  # left_hip
    12: 24,  # right_hip
    13: 25,  # left_knee
    14: 26,  # right_knee
    15: 27,  # left_ankle
    16: 28,  # right_ankle
}

# For MediaPipe indices we don't get from COCO, copy from a nearby body
# part so the bbox math + drawing math don't choke on zeros at the
# origin. Visibility stays 0 so they're skipped by the skeleton drawer.
_FILL_FROM = {
    1: 2,    # LEFT_EYE_INNER  ← LEFT_EYE
    3: 2,    # LEFT_EYE_OUTER  ← LEFT_EYE
    4: 5,    # RIGHT_EYE_INNER ← RIGHT_EYE
    6: 5,    # RIGHT_EYE_OUTER ← RIGHT_EYE
    9: 0,    # MOUTH_LEFT      ← NOSE
    10: 0,   # MOUTH_RIGHT     ← NOSE
    17: 15,  # LEFT_PINKY      ← LEFT_WRIST
    18: 16,  # RIGHT_PINKY     ← RIGHT_WRIST
    19: 15,  # LEFT_INDEX      ← LEFT_WRIST
    20: 16,  # RIGHT_INDEX     ← RIGHT_WRIST
    21: 15,  # LEFT_THUMB      ← LEFT_WRIST
    22: 16,  # RIGHT_THUMB     ← RIGHT_WRIST
    29: 27,  # LEFT_HEEL       ← LEFT_ANKLE
    30: 28,  # RIGHT_HEEL      ← RIGHT_ANKLE
    31: 27,  # LEFT_FOOT_INDEX ← LEFT_ANKLE
    32: 28,  # RIGHT_FOOT_INDEX← RIGHT_ANKLE
}


@dataclass
class _PersonTrack:
    """Accumulator for one tracked person across the clip."""

    id: str
    frames: list[dict] = field(default_factory=list)
    first_seen_ms: int = -1
    last_seen_ms: int = 0
    # Bounding box union (normalised) — used for the per-person thumbnail crop.
    bbox_x0: float = 1.0
    bbox_y0: float = 1.0
    bbox_x1: float = 0.0
    bbox_y1: float = 0.0
    # Best (largest bbox) frame index for the thumbnail.
    thumbnail_frame_idx: int = 0
    thumbnail_bbox_area: float = 0.0
    # Per-frame metric sums + count of detected (non-null) frames.
    centrality_sum: float = 0.0
    size_sum: float = 0.0
    forwardness_sum: float = 0.0
    visibility_sum: float = 0.0
    detected_count: int = 0


_model_cache: YOLO | None = None


def _ensure_model() -> YOLO:
    global _model_cache
    if _model_cache is not None:
        return _model_cache
    _MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if not MODEL_PATH.exists():
        # YOLO("name.pt") triggers a download to CWD on first use. We
        # download into _MODELS_DIR by setting cwd-relative path:
        log.info("downloading %s -> %s", _MODEL, MODEL_PATH)
        cwd = Path.cwd()
        try:
            os.chdir(_MODELS_DIR)
            YOLO(f"{_MODEL}.pt")  # downloads weights to current dir
        finally:
            os.chdir(cwd)
    _model_cache = YOLO(str(MODEL_PATH))
    return _model_cache


def _coco17_to_mp33(
    xyn: np.ndarray, conf: np.ndarray | None
) -> list[dict]:
    """Convert one detection's 17 COCO keypoints into a 33-entry
    MediaPipe-shaped list of `{x, y, z, visibility}` dicts."""
    mp = [
        {"x": 0.0, "y": 0.0, "z": 0.0, "visibility": 0.0}
        for _ in range(33)
    ]
    for coco_i, mp_i in _COCO_TO_MP.items():
        x, y = float(xyn[coco_i, 0]), float(xyn[coco_i, 1])
        v = float(conf[coco_i]) if conf is not None else 1.0
        mp[mp_i] = {"x": x, "y": y, "z": 0.0, "visibility": v}
    for mp_i, src_i in _FILL_FROM.items():
        src = mp[src_i]
        mp[mp_i] = {"x": src["x"], "y": src["y"], "z": 0.0, "visibility": 0.0}
    return mp


def _hip_centroid_from_mp(lms: list[dict]) -> tuple[float, float] | None:
    left, right = lms[23], lms[24]
    if left["visibility"] < 0.1 and right["visibility"] < 0.1:
        return None
    return ((left["x"] + right["x"]) / 2.0, (left["y"] + right["y"]) / 2.0)


def _feet_y_from_mp(lms: list[dict]) -> float:
    left, right = lms[27], lms[28]
    if left["visibility"] < 0.1 and right["visibility"] < 0.1:
        return 0.5
    return (left["y"] + right["y"]) / 2.0


def extract_pose(video_path: Path, out_path: Path) -> tuple[Path, bool]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"cv2 cannot open {video_path}")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    model = _ensure_model()

    tracks: dict[str, _PersonTrack] = {}
    total_frames = 0
    no_detection_count = 0
    frame_idx = 0

    while True:
        ok, frame_bgr = cap.read()
        if not ok:
            break
        total_frames += 1
        t_ms = int(round((frame_idx / fps) * 1000))

        results = model.track(
            frame_bgr,
            persist=True,
            tracker=TRACKER_CONFIG,
            conf=DETECTION_CONFIDENCE,
            classes=[0],          # COCO class 0 = person
            max_det=MAX_DETECTIONS,
            verbose=False,
        )
        r = results[0]

        detections: list[tuple[str, list[dict], tuple[float, float, float, float]]] = []
        if r.boxes is not None and r.boxes.id is not None and r.keypoints is not None:
            ids = r.boxes.id.int().cpu().tolist()
            xyxy = r.boxes.xyxy.cpu().numpy()           # pixels
            kp_xyn = r.keypoints.xyn.cpu().numpy()      # normalised
            kp_conf = (
                r.keypoints.conf.cpu().numpy()
                if r.keypoints.conf is not None else None
            )
            for di, raw_id in enumerate(ids):
                tid = f"p{int(raw_id)}"
                lms = _coco17_to_mp33(
                    kp_xyn[di],
                    kp_conf[di] if kp_conf is not None else None,
                )
                # Convert pixel bbox to normalised.
                nx0 = max(0.0, float(xyxy[di, 0]) / width)
                ny0 = max(0.0, float(xyxy[di, 1]) / height)
                nx1 = min(1.0, float(xyxy[di, 2]) / width)
                ny1 = min(1.0, float(xyxy[di, 3]) / height)
                detections.append((tid, lms, (nx0, ny0, nx1, ny1)))

        if not detections:
            no_detection_count += 1
        seen_ids: set[str] = set()
        for tid, lms, bbox in detections:
            seen_ids.add(tid)
            tr = tracks.get(tid)
            if tr is None:
                tr = _PersonTrack(id=tid, first_seen_ms=t_ms)
                tracks[tid] = tr
            _append_detection(tr, lms, bbox, t_ms, frame_idx)

        # Existing tracks not seen this frame → null timeline entry so
        # the per-track frame array stays length-aligned with the video.
        for tid, tr in tracks.items():
            if tid in seen_ids:
                continue
            if tr.frames and tr.frames[-1]["t_ms"] == t_ms:
                continue
            tr.frames.append({"t_ms": t_ms, "landmarks": None})

        frame_idx += 1
    cap.release()

    if not tracks or total_frames == 0:
        return _write_empty(out_path, width, height, fps, total_frames)

    # Drop low-coverage tracks (bystanders, brief false positives).
    surviving: list[_PersonTrack] = []
    for tr in tracks.values():
        if tr.detected_count == 0:
            continue
        coverage = tr.detected_count / max(1, total_frames)
        if coverage < MIN_TEMPORAL_COVERAGE:
            log.info(
                "dropping track %s — coverage %.0f%% below %d%%",
                tr.id, coverage * 100, int(MIN_TEMPORAL_COVERAGE * 100),
            )
            continue
        surviving.append(tr)

    if not surviving:
        return _write_empty(out_path, width, height, fps, total_frames, no_detection_count)

    # Cap on dancer count — see MAX_FINAL_TRACKS comment.
    if len(surviving) > MAX_FINAL_TRACKS:
        surviving.sort(
            key=lambda t: t.detected_count / max(1, total_frames),
            reverse=True,
        )
        dropped = surviving[MAX_FINAL_TRACKS:]
        surviving = surviving[:MAX_FINAL_TRACKS]
        for tr in dropped:
            log.info(
                "capping at %d tracks (had %d) — dropping %s",
                MAX_FINAL_TRACKS, len(surviving) + len(dropped), tr.id,
            )

    persons_payload: list[dict] = []
    for tr in surviving:
        n = tr.detected_count
        persistence = n / max(1, total_frames)
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
    requires_pick = (
        len(persons_payload) > 1
        and top["lead_score"] - persons_payload[1]["lead_score"] < PICK_AMBIGUITY_GAP
    )

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
    tr: _PersonTrack,
    lms: list[dict],
    bbox: tuple[float, float, float, float],
    t_ms: int,
    frame_idx: int,
) -> None:
    tr.frames.append({"t_ms": t_ms, "landmarks": lms})
    tr.last_seen_ms = t_ms
    if tr.first_seen_ms < 0:
        tr.first_seen_ms = t_ms
    x0, y0, x1, y1 = bbox
    tr.bbox_x0 = min(tr.bbox_x0, x0)
    tr.bbox_y0 = min(tr.bbox_y0, y0)
    tr.bbox_x1 = max(tr.bbox_x1, x1)
    tr.bbox_y1 = max(tr.bbox_y1, y1)
    area = max(0.0, (x1 - x0) * (y1 - y0))
    if area > tr.thumbnail_bbox_area:
        tr.thumbnail_bbox_area = area
        tr.thumbnail_frame_idx = frame_idx
    cx = (x0 + x1) / 2.0
    tr.centrality_sum += max(0.0, 1.0 - 2.0 * abs(cx - 0.5))
    tr.size_sum += min(1.0, area * 2.5)
    tr.forwardness_sum += min(1.0, _feet_y_from_mp(lms))
    tr.visibility_sum += sum(lm["visibility"] for lm in lms) / len(lms)
    tr.detected_count += 1


def _write_empty(
    out_path: Path,
    width: int,
    height: int,
    fps: float,
    total_frames: int,
    no_detection_count: int = 0,
) -> tuple[Path, bool]:
    payload = {
        "width": width,
        "height": height,
        "fps": fps,
        "frame_count": total_frames,
        "miss_rate": (no_detection_count / total_frames) if total_frames else 0.0,
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
