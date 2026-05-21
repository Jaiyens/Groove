"""Thumbnail extraction.

`extract_thumbnail` produces the single library thumbnail. SPECK rev 3
§Issue 4: we used to grab frame ~0 (1.5s in), which produced near-
identical library cards for any creator whose videos all start in the
same idle pose (Charli). Now we pick from 30 / 50 / 70 % through the
clip, scored by pose confidence at that frame — so the chosen frame
is mid-movement and the body is fully tracked.

`extract_person_thumbnails` (Phase 3) crops one jpg per tracked person,
taken from the frame where that person's bounding box was largest.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import cv2

log = logging.getLogger("worker.thumbnail")


# Candidate offsets (as fractions of the video duration) for the library
# thumbnail. Tried in order; whichever has the highest pose confidence wins.
THUMBNAIL_CANDIDATE_OFFSETS = (0.30, 0.50, 0.70)
# A frame must clear this mean-visibility floor to be picked outright.
# Below it, we fall through to the next candidate; if none clear, we keep
# whichever scored highest.
THUMBNAIL_MIN_CONFIDENCE = 0.40


def extract_thumbnail(
    video_path: Path,
    out_path: Path,
    pose_json_path: Path | None = None,
    duration_seconds: float | None = None,
) -> Path:
    """Pick a distinctive single frame and write it to `out_path`.

    When `pose_json_path` is supplied, the function reads the auto-selected
    person's frames and scores the 30 / 50 / 70 % candidates by mean
    landmark visibility, picking the best. Without pose data it falls back
    to grabbing the 30 % frame directly via ffmpeg.
    """
    seconds = _pick_thumbnail_seconds(pose_json_path, duration_seconds)
    log.info("thumbnail: grabbing frame at %.2fs", seconds)
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(seconds),
            "-i", str(video_path),
            "-frames:v", "1",
            "-q:v", "3",
            str(out_path),
        ],
        check=True, capture_output=True,
    )
    log.info("thumbnail: %s", out_path)
    return out_path


def _pick_thumbnail_seconds(
    pose_json_path: Path | None,
    duration_seconds: float | None,
) -> float:
    """Return the timestamp (seconds) of the best candidate frame.

    Defaults to 30 % of the duration. When pose data is available we
    score each of the 30/50/70 % candidates by the mean visibility of
    their nearest landmark frame, return the highest-confidence one above
    the floor — or, if nothing clears, the best of the three anyway.
    """
    # Fall back: we don't know duration, can't do anything fancy. Use a
    # 1.5s constant so existing behaviour is preserved.
    if not duration_seconds or duration_seconds <= 0:
        return 1.5

    candidates = [duration_seconds * o for o in THUMBNAIL_CANDIDATE_OFFSETS]

    if not pose_json_path or not pose_json_path.exists():
        return candidates[0]

    try:
        doc = json.loads(pose_json_path.read_text())
        frames = doc.get("frames") or []
    except Exception:
        return candidates[0]
    if not frames:
        return candidates[0]

    scored: list[tuple[float, float]] = []  # (confidence, seconds)
    for sec in candidates:
        target_ms = sec * 1000.0
        frame = _nearest_frame(frames, target_ms)
        conf = _frame_confidence(frame)
        scored.append((conf, sec))

    # Prefer the first candidate that clears the floor (i.e. earlier wins
    # on a tie, matching the SPECK ordering of 30 → 50 → 70).
    for conf, sec in scored:
        if conf >= THUMBNAIL_MIN_CONFIDENCE:
            return sec
    # Nothing cleared. Pick the best we have, biased to the earlier
    # candidate on ties.
    scored.sort(key=lambda s: (-s[0], s[1]))
    return scored[0][1]


def _nearest_frame(frames: list[dict], target_ms: float) -> dict | None:
    """Binary-search the closest frame entry by t_ms. Returns the frame
    dict (may have landmarks: null)."""
    if not frames:
        return None
    lo, hi = 0, len(frames) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if frames[mid].get("t_ms", 0) < target_ms:
            lo = mid + 1
        else:
            hi = mid
    if lo > 0 and abs(frames[lo - 1].get("t_ms", 0) - target_ms) < abs(
        frames[lo].get("t_ms", 0) - target_ms
    ):
        return frames[lo - 1]
    return frames[lo]


def _frame_confidence(frame: dict | None) -> float:
    if not frame:
        return 0.0
    lms = frame.get("landmarks")
    if not lms:
        return 0.0
    return sum(float(lm.get("visibility", 0)) for lm in lms) / max(1, len(lms))


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
