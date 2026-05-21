"""Per-frame pose extraction using MediaPipe Tasks PoseLandmarker.

Multi-person aware. MediaPipe Pose Landmarker is configured with
num_poses=5 so it returns up to five detections per frame. A centroid
tracker assigns stable person IDs across frames; we then compute a
lead_score per person from centrality, size, forwardness, and
persistence, and auto-select the top scorer.

The tracker is tolerant of brief occlusions and partial-frame exits —
SPECK rev 3 §Issue 1: the old 0.5s expiry was fragmenting a single
dancer into 5+ person IDs whenever they walked past another dancer.
Fixes layered in here:
  1. Active-tracking window is 2500 ms (was 500 ms).
  2. Within an additional 2500 ms after expiry, a new detection can
     re-attach to an existing ID if its centroid is close AND its
     bbox size is within 30% of the expired track's average.
  3. After the per-frame loop, a merge pass collapses non-overlapping
     tracks that look like the same person.
  4. Tracks with <25% temporal coverage of the video are dropped.
  5. Final person count is capped at 4 (highest persistence wins).

Output JSON shape (frames[] is preserved at top level for backwards
compatibility — those frames are the AUTO-SELECTED person's track, which
is what `lib/pose/referencePose.ts` consumes today):

    {
      "width":  <int>,
      "height": <int>,
      "fps":    <float>,
      "frame_count": <int>,
      "miss_rate":   <float>,
      "mean_visibility": <float>,
      "low_quality": <bool>,
      "dancer_count": <int>,
      "auto_selected_person_id": <str>,
      "requires_dancer_pick": <bool>,
      "persons": [{ id, lead_score, ..., frames }],
      "frames": [ ... auto-selected person's frames ... ]
    }
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

log = logging.getLogger("worker.pose")

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

# Up to N concurrent poses per frame. MediaPipe Pose Landmarker supports
# multi-person via num_poses.
MAX_POSES = 5

# Tracker tuning. See module docstring + SPECK rev 3 §Issue 1.
TRACK_MATCH_MAX_DIST = 0.25
TRACK_ACTIVE_WINDOW_MS = 2500
TRACK_REATTACH_WINDOW_MS = 2500  # additional grace after expiry, with size check
SIZE_MATCH_TOLERANCE = 0.30
MERGE_GAP_MAX_MS = 5000          # post-pass merge candidates must be ≤5s apart in time
MIN_TEMPORAL_COVERAGE = 0.25     # tracks present in <25% of frames are dropped
MAX_FINAL_TRACKS = 4

# requires_dancer_pick threshold (top-score gap).
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
    first_seen_ms: int = -1
    # Bounding box union (normalized coords) over the track's lifetime —
    # used for the per-person thumbnail crop.
    bbox_x0: float = 1.0
    bbox_y0: float = 1.0
    bbox_x1: float = 0.0
    bbox_y1: float = 0.0
    # Best (largest bbox) frame index for the thumbnail.
    thumbnail_frame_idx: int = 0
    thumbnail_bbox_area: float = 0.0
    # Per-frame metric sums + count of detected (non-null) frames.
    centrality_sum: float = 0.0
    size_sum: float = 0.0          # mean per-frame bbox area * 2.5 (clamped)
    raw_area_sum: float = 0.0      # mean per-frame raw bbox area (for size matching)
    forwardness_sum: float = 0.0
    visibility_sum: float = 0.0
    detected_count: int = 0

    def mean_raw_area(self) -> float:
        return self.raw_area_sum / self.detected_count if self.detected_count else 0.0


def _hip_centroid(lms: list[dict]) -> tuple[float, float] | None:
    if len(lms) < 25:
        return None
    left, right = lms[23], lms[24]
    return ((left["x"] + right["x"]) / 2.0, (left["y"] + right["y"]) / 2.0)


def _bbox(lms: list[dict]) -> tuple[float, float, float, float]:
    xs = [lm["x"] for lm in lms]
    ys = [lm["y"] for lm in lms]
    return (min(xs), min(ys), max(xs), max(ys))


def _feet_y(lms: list[dict]) -> float:
    if len(lms) < 29:
        return 0.5
    return (lms[27]["y"] + lms[28]["y"]) / 2.0


def _size_similar(a: float, b: float) -> bool:
    """True when two areas are within SIZE_MATCH_TOLERANCE of each other."""
    if a <= 0 or b <= 0:
        return False
    big = max(a, b)
    return abs(a - b) / big <= SIZE_MATCH_TOLERANCE


def _centroid_dist(
    a: tuple[float, float] | None,
    b: tuple[float, float] | None,
) -> float:
    if a is None or b is None:
        return float("inf")
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


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
                for tr in tracks.values():
                    tr.frames.append({"t_ms": t_ms, "landmarks": None})
                frame_idx += 1
                continue

            # --- match detections to existing tracks --------------------
            # Two-tier matching: ACTIVE candidates (last seen within
            # TRACK_ACTIVE_WINDOW_MS) only need distance ≤ MAX_DIST.
            # STALE candidates (within an additional TRACK_REATTACH_WINDOW_MS)
            # also need bbox size within SIZE_MATCH_TOLERANCE — this re-attaches
            # the same dancer after an occlusion instead of spawning a new ID.
            # Tracks older than active+reattach are ignored for this frame.
            candidates: list[tuple[float, str, int]] = []
            det_centroids: list[tuple[float, float] | None] = [
                _hip_centroid(det) for det in detections
            ]
            det_areas: list[float] = []
            for det in detections:
                b = _bbox(det)
                det_areas.append(max(0.0, (b[2] - b[0]) * (b[3] - b[1])))

            for di, det_c in enumerate(det_centroids):
                if det_c is None:
                    continue
                for tr in tracks.values():
                    if tr.last_centroid is None:
                        continue
                    age = t_ms - tr.last_seen_ms
                    if age > TRACK_ACTIVE_WINDOW_MS + TRACK_REATTACH_WINDOW_MS:
                        continue
                    d = _centroid_dist(det_c, tr.last_centroid)
                    if d > TRACK_MATCH_MAX_DIST:
                        continue
                    if age > TRACK_ACTIVE_WINDOW_MS:
                        # Re-attach window: also require size match.
                        if not _size_similar(det_areas[di], tr.mean_raw_area()):
                            continue
                    candidates.append((d, tr.id, di))
            candidates.sort()

            used_track_ids: set[str] = set()
            matched_det_indices: set[int] = set()
            for _d, tid, di in candidates:
                if tid in used_track_ids or di in matched_det_indices:
                    continue
                used_track_ids.add(tid)
                matched_det_indices.add(di)
                _append_detection(tracks[tid], detections[di], t_ms, frame_idx)

            # Unmatched detections → new tracks.
            for di, det in enumerate(detections):
                if di in matched_det_indices:
                    continue
                tid = f"p{next_track_id}"
                next_track_id += 1
                tracks[tid] = _PersonTrack(id=tid, first_seen_ms=t_ms)
                _append_detection(tracks[tid], det, t_ms, frame_idx)
                used_track_ids.add(tid)

            # Existing tracks that didn't match this frame → null frame so
            # their timeline stays aligned with the video.
            for tid, tr in tracks.items():
                if tid in used_track_ids:
                    continue
                if tr.frames and tr.frames[-1]["t_ms"] == t_ms:
                    continue
                tr.frames.append({"t_ms": t_ms, "landmarks": None})

            frame_idx += 1
    cap.release()

    if not tracks or total_frames == 0:
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

    # --- post-processing: merge non-overlapping look-alike tracks ------
    # SPECK rev 3 §Issue 1.3: two tracks where one ends before the other
    # begins, the centroid positions are close, and the body sizes are
    # similar → collapse into one. Iterate until stable.
    track_list = list(tracks.values())
    merged = True
    while merged:
        merged = False
        track_list.sort(key=lambda t: t.first_seen_ms)
        for i in range(len(track_list)):
            a = track_list[i]
            if a.detected_count == 0:
                continue
            for j in range(i + 1, len(track_list)):
                b = track_list[j]
                if b.detected_count == 0:
                    continue
                # Non-overlapping in time: a fully before b OR b fully before a.
                if not (a.last_seen_ms < b.first_seen_ms or b.last_seen_ms < a.first_seen_ms):
                    continue
                # Bridge gap must be small enough to plausibly be the same person.
                if a.last_seen_ms < b.first_seen_ms:
                    gap = b.first_seen_ms - a.last_seen_ms
                    earlier, later = a, b
                else:
                    gap = a.first_seen_ms - b.last_seen_ms
                    earlier, later = b, a
                if gap > MERGE_GAP_MAX_MS:
                    continue
                # Spatial + size similarity at the junction.
                if _centroid_dist(earlier.last_centroid, later.last_centroid) > TRACK_MATCH_MAX_DIST:
                    continue
                if not _size_similar(earlier.mean_raw_area(), later.mean_raw_area()):
                    continue
                _merge_tracks_inplace(earlier, later)
                # Drop the later one; restart pass.
                track_list.remove(later)
                merged = True
                break
            if merged:
                break

    # --- coverage filter + cap -----------------------------------------
    surviving: list[_PersonTrack] = []
    for tr in track_list:
        if tr.detected_count == 0:
            continue
        coverage = tr.detected_count / max(1, total_frames)
        if coverage < MIN_TEMPORAL_COVERAGE:
            log.info(
                "dropping track %s — coverage %.0f%% below %d%% floor",
                tr.id, coverage * 100, int(MIN_TEMPORAL_COVERAGE * 100),
            )
            continue
        surviving.append(tr)

    if not surviving:
        payload = {
            "width": width,
            "height": height,
            "fps": fps,
            "frame_count": total_frames,
            "miss_rate": no_detection_count / max(1, total_frames),
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

    surviving.sort(
        key=lambda t: t.detected_count / max(1, total_frames),
        reverse=True,
    )
    if len(surviving) > MAX_FINAL_TRACKS:
        log.info(
            "capping at %d tracks (had %d)", MAX_FINAL_TRACKS, len(surviving),
        )
        surviving = surviving[:MAX_FINAL_TRACKS]

    # --- compose persons payload ---------------------------------------
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
    requires_pick = False
    if len(persons_payload) > 1:
        second = persons_payload[1]
        if top["lead_score"] - second["lead_score"] < PICK_AMBIGUITY_GAP:
            requires_pick = True

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
        "pose: %d frames, %d person(s) after merge+filter, top=%s lead=%.2f, pick=%s, low_quality=%s",
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
    if tr.first_seen_ms < 0:
        tr.first_seen_ms = t_ms
    bbox = _bbox(lms)
    tr.bbox_x0 = min(tr.bbox_x0, bbox[0])
    tr.bbox_y0 = min(tr.bbox_y0, bbox[1])
    tr.bbox_x1 = max(tr.bbox_x1, bbox[2])
    tr.bbox_y1 = max(tr.bbox_y1, bbox[3])

    if centroid is not None:
        tr.centrality_sum += max(0.0, 1.0 - 2.0 * abs(centroid[0] - 0.5))
    area = max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
    tr.size_sum += min(1.0, area * 2.5)
    tr.raw_area_sum += area
    if area > tr.thumbnail_bbox_area:
        tr.thumbnail_bbox_area = area
        tr.thumbnail_frame_idx = frame_idx
    tr.forwardness_sum += min(1.0, _feet_y(lms))
    tr.visibility_sum += sum(lm["visibility"] for lm in lms) / len(lms)
    tr.detected_count += 1


def _merge_tracks_inplace(target: _PersonTrack, source: _PersonTrack) -> None:
    """Fold `source` into `target` (target wins ID; source's frames are
    merged in chronological order). Used by the post-pass collapse of
    non-overlapping look-alike tracks. Detected-frame metric sums are
    additive; bbox union expands."""
    # Interleave frames by t_ms so the merged track stays time-sorted.
    combined = sorted(target.frames + source.frames, key=lambda f: f["t_ms"])
    # Drop duplicate-ts nulls if both tracks emitted a null for the same
    # frame index (avoid double-counting "missing").
    deduped: list[dict] = []
    seen_ts: set[int] = set()
    for f in combined:
        if f["t_ms"] in seen_ts and f["landmarks"] is None:
            continue
        if f["t_ms"] in seen_ts:
            # Prefer the entry with landmarks. Replace the prior null.
            for i in range(len(deduped) - 1, -1, -1):
                if deduped[i]["t_ms"] == f["t_ms"] and deduped[i]["landmarks"] is None:
                    deduped[i] = f
                    break
            continue
        deduped.append(f)
        seen_ts.add(f["t_ms"])
    target.frames = deduped

    target.first_seen_ms = min(target.first_seen_ms, source.first_seen_ms)
    if source.last_seen_ms > target.last_seen_ms:
        target.last_seen_ms = source.last_seen_ms
        target.last_centroid = source.last_centroid
    target.bbox_x0 = min(target.bbox_x0, source.bbox_x0)
    target.bbox_y0 = min(target.bbox_y0, source.bbox_y0)
    target.bbox_x1 = max(target.bbox_x1, source.bbox_x1)
    target.bbox_y1 = max(target.bbox_y1, source.bbox_y1)
    if source.thumbnail_bbox_area > target.thumbnail_bbox_area:
        target.thumbnail_bbox_area = source.thumbnail_bbox_area
        target.thumbnail_frame_idx = source.thumbnail_frame_idx
    target.centrality_sum += source.centrality_sum
    target.size_sum += source.size_sum
    target.raw_area_sum += source.raw_area_sum
    target.forwardness_sum += source.forwardness_sum
    target.visibility_sum += source.visibility_sum
    target.detected_count += source.detected_count
