"""Skill mapping. For each chunk, identify which gross movement patterns
(skills from the knowledge graph) are present.

V1 strategy: approximate. For each chunk, compute simple features
(arm-swing range, hip-shift range, body-roll signature, shoulder-isolation
signature) and map to skill ids when above empirical thresholds. This is
intentionally rough — the spec says "check which gross movement patterns
occur". Real per-move labels are a later improvement.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from chunker import Chunk

log = logging.getLogger("worker.skills")

# Knowledge-graph node ids that the v1 mapper can detect. Imported from
# public/data/knowledge_graph.json (we ship a copy in the worker so it can
# run standalone — see scripts/sync_graph.ts to refresh).
KNOWN_SKILLS = {
    "posture_alignment",
    "weight_shift_basic",
    "shoulder_isolation",
    "hip_isolation",
    "two_step",
    "body_roll",
    "arm_wave",
    "side_glide",
}


def map_skills(pose_path: Path, chunks: "list[Chunk]") -> tuple[list[str], dict[str, float]]:
    pose = json.loads(Path(pose_path).read_text())
    frames = pose["frames"]
    fps = float(pose.get("fps") or 30.0)

    all_skills: set[str] = set()
    weights: dict[str, float] = {}

    for chunk in chunks:
        chunk_frames = _frames_in_range(frames, chunk.startMs, chunk.endMs, fps)
        skills = _detect_skills(chunk_frames)
        chunk.skills = skills
        for s in skills:
            all_skills.add(s)
            weights[s] = weights.get(s, 0.0) + 1.0

    # Always include posture_alignment as a baseline (matches v1 routine nodes).
    all_skills.add("posture_alignment")
    weights.setdefault("posture_alignment", 0.5)

    # Normalise weights to sum to ~1.0.
    total = sum(weights.values()) or 1.0
    weights = {k: round(v / total, 4) for k, v in weights.items()}

    return sorted(all_skills), weights


def _frames_in_range(frames: list[dict], start_ms: int, end_ms: int, fps: float) -> list[dict]:
    return [f for f in frames if f.get("landmarks") and start_ms <= f["t_ms"] < end_ms]


def _detect_skills(frames: list[dict]) -> list[str]:
    """Cheap heuristics. Each returns a skill id if the pattern shows up."""
    if not frames:
        return ["posture_alignment"]
    skills: set[str] = {"posture_alignment"}

    # MediaPipe pose landmark indices (subset we use):
    # 11 = left_shoulder, 12 = right_shoulder
    # 13 = left_elbow,    14 = right_elbow
    # 15 = left_wrist,    16 = right_wrist
    # 23 = left_hip,      24 = right_hip
    # 27 = left_ankle,    28 = right_ankle

    def _range(idx: int, axis: str) -> float:
        xs = [f["landmarks"][idx][axis] for f in frames]
        return max(xs) - min(xs)

    hip_range_x = max(_range(23, "x"), _range(24, "x"))
    shoulder_range_y = max(_range(11, "y"), _range(12, "y"))
    wrist_range_xy = max(_range(15, "x"), _range(15, "y"), _range(16, "x"), _range(16, "y"))
    ankle_range_x = max(_range(27, "x"), _range(28, "x"))

    if hip_range_x > 0.08:
        skills.add("hip_isolation")
        skills.add("weight_shift_basic")
    if shoulder_range_y > 0.06:
        skills.add("shoulder_isolation")
    if wrist_range_xy > 0.20:
        skills.add("arm_wave")
    if ankle_range_x > 0.06:
        skills.add("two_step")
    if hip_range_x > 0.05 and shoulder_range_y > 0.05:
        skills.add("body_roll")

    return sorted(s for s in skills if s in KNOWN_SKILLS)
