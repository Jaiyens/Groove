"""Auto-chunking. Combine beat boundaries + pose velocity minima to find
section breaks. Target: 2-4 chunks per dance, each 3-8 seconds.

Algorithm (per SPECK.md step 4):
1. Compute total joint angular velocity per frame.
2. Smooth with a 0.5s window.
3. Find local minima that align with beat boundaries.
4. Split at those minima.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("worker.chunker")

MIN_CHUNK_S = 3.0
MAX_CHUNK_S = 8.0
TARGET_CHUNKS = 3  # aim for 2-4, default 3


@dataclass
class Chunk:
    index: int
    startMs: int
    endMs: int
    skills: list[str] = field(default_factory=list)
    label: str = ""


def auto_chunk(
    pose_json_path: Path,
    beat_times: list[float],
    duration_seconds: float,
) -> list[Chunk]:
    pose = json.loads(pose_json_path.read_text())
    frames = pose["frames"]
    fps = float(pose.get("fps") or 30.0)

    velocities = _velocity_per_frame(frames)
    smoothed = _smooth(velocities, window_size=max(1, int(round(0.5 * fps))))

    # Find local minima in smoothed velocity.
    minima_times_ms = _local_minima_times_ms(smoothed, fps)

    # Score each beat boundary by proximity to a velocity minimum within ~0.25s.
    candidate_split_times_ms: list[int] = []
    for b in beat_times:
        b_ms = int(round(b * 1000))
        if any(abs(b_ms - m) <= 250 for m in minima_times_ms):
            candidate_split_times_ms.append(b_ms)

    duration_ms = int(round(duration_seconds * 1000))
    split_times_ms = _pick_splits(candidate_split_times_ms, duration_ms)

    chunks: list[Chunk] = []
    prev = 0
    for i, t in enumerate(split_times_ms + [duration_ms]):
        chunks.append(
            Chunk(
                index=i,
                startMs=prev,
                endMs=t,
                label=f"section {i + 1}",
            )
        )
        prev = t
    log.info(
        "chunks: %d (durations ms: %s)",
        len(chunks), [c.endMs - c.startMs for c in chunks],
    )
    return chunks


def _velocity_per_frame(frames: list[dict]) -> list[float]:
    velocities: list[float] = [0.0]
    last_landmarks: list[dict] | None = None
    for frame in frames:
        lms = frame.get("landmarks")
        if lms is None or last_landmarks is None:
            velocities.append(velocities[-1] if velocities else 0.0)
            last_landmarks = lms
            continue
        total = 0.0
        for cur, prev in zip(lms, last_landmarks):
            dx = cur["x"] - prev["x"]
            dy = cur["y"] - prev["y"]
            total += math.hypot(dx, dy)
        velocities.append(total / len(lms))
        last_landmarks = lms
    return velocities[1:]


def _smooth(values: list[float], window_size: int) -> list[float]:
    if window_size <= 1:
        return list(values)
    out: list[float] = []
    half = window_size // 2
    n = len(values)
    for i in range(n):
        a = max(0, i - half)
        b = min(n, i + half + 1)
        s = sum(values[a:b]) / (b - a)
        out.append(s)
    return out


def _local_minima_times_ms(values: list[float], fps: float) -> list[int]:
    minima: list[int] = []
    for i in range(1, len(values) - 1):
        if values[i] < values[i - 1] and values[i] < values[i + 1]:
            minima.append(int(round((i / fps) * 1000)))
    return minima


def _pick_splits(candidates: list[int], duration_ms: int) -> list[int]:
    """From a list of candidate split times, pick TARGET_CHUNKS-1 splits that
    yield chunks within [MIN_CHUNK_S, MAX_CHUNK_S]."""
    if duration_ms <= MIN_CHUNK_S * 1000:
        return []
    desired = max(1, min(TARGET_CHUNKS - 1, len(candidates)))
    if not candidates:
        # Fall back to evenly distributed cuts.
        step = duration_ms // (desired + 1)
        return [step * (i + 1) for i in range(desired)]

    # Sort candidates, then greedily pick splits that respect min spacing.
    candidates = sorted(set(candidates))
    chosen: list[int] = []
    prev = 0
    target_spacing = duration_ms / (desired + 1)
    for _ in range(desired):
        # Pick the candidate closest to (prev + target_spacing).
        target = prev + target_spacing
        best = None
        best_dist = math.inf
        for c in candidates:
            if c - prev < MIN_CHUNK_S * 1000:
                continue
            if c >= duration_ms - MIN_CHUNK_S * 1000:
                continue
            d = abs(c - target)
            if d < best_dist:
                best_dist = d
                best = c
        if best is None:
            break
        chosen.append(best)
        prev = best
        candidates = [c for c in candidates if c > best]
    return chosen
