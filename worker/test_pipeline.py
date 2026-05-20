"""Worker self-test. Exercises the pure-Python pipeline pieces (chunker,
skill mapping) on synthetic input — no MediaPipe / librosa / ffmpeg needed.

Run:  python test_pipeline.py
Run via Phase 1 verification script in the repo root: scripts/verify_phase1.sh
"""

from __future__ import annotations

import json
import math
import tempfile
import unittest
from pathlib import Path

from chunker import auto_chunk, MIN_CHUNK_S, MAX_CHUNK_S
from skill_mapping import map_skills


def _synth_landmarks(t_s: float) -> list[dict]:
    """33-landmark MediaPipe pose with a few moving joints. Phase = t_s."""
    # Whole-body sway: hips travel horizontally, arms swing.
    hip_x = 0.5 + 0.1 * math.sin(2 * math.pi * t_s)
    arm_x = 0.5 + 0.25 * math.sin(2 * math.pi * t_s * 1.0)
    ankle_x = 0.5 + 0.08 * math.sin(2 * math.pi * t_s)
    shoulder_y = 0.3 + 0.07 * math.sin(2 * math.pi * t_s)
    lm = [{"x": 0.5, "y": 0.3 + i * 0.02, "z": 0.0, "visibility": 0.9} for i in range(33)]
    lm[11]["y"] = shoulder_y                     # left shoulder
    lm[12]["y"] = shoulder_y + 0.01              # right shoulder
    lm[15]["x"] = arm_x; lm[15]["y"] = 0.5       # left wrist
    lm[16]["x"] = 1 - arm_x; lm[16]["y"] = 0.5   # right wrist
    lm[23]["x"] = hip_x                          # left hip
    lm[24]["x"] = 1 - hip_x                      # right hip
    lm[27]["x"] = ankle_x                        # left ankle
    lm[28]["x"] = 1 - ankle_x                    # right ankle
    return lm


def _make_pose_json(duration_s: float, fps: float = 30.0) -> Path:
    frames = []
    n = int(round(duration_s * fps))
    for i in range(n):
        t_s = i / fps
        frames.append({"t_ms": int(round(t_s * 1000)), "landmarks": _synth_landmarks(t_s)})
    payload = {
        "width": 720, "height": 1280, "fps": fps,
        "frame_count": n, "miss_rate": 0.0, "mean_visibility": 0.9,
        "frames": frames,
    }
    tmp = Path(tempfile.mkstemp(suffix=".json")[1])
    tmp.write_text(json.dumps(payload))
    return tmp


class ChunkerTests(unittest.TestCase):
    def test_produces_2_to_4_chunks_for_short_clip(self):
        pose = _make_pose_json(duration_s=12.0)
        beats = [i * 0.5 for i in range(24)]
        chunks = auto_chunk(pose, beats, 12.0)
        self.assertGreaterEqual(len(chunks), 2)
        self.assertLessEqual(len(chunks), 4)

    def test_chunks_cover_full_duration(self):
        pose = _make_pose_json(duration_s=10.0)
        chunks = auto_chunk(pose, [i * 0.5 for i in range(20)], 10.0)
        self.assertEqual(chunks[0].startMs, 0)
        self.assertEqual(chunks[-1].endMs, 10000)
        for a, b in zip(chunks, chunks[1:]):
            self.assertEqual(a.endMs, b.startMs)

    def test_chunks_within_min_max_duration_when_possible(self):
        pose = _make_pose_json(duration_s=15.0)
        chunks = auto_chunk(pose, [i * 0.5 for i in range(30)], 15.0)
        for c in chunks:
            dur_s = (c.endMs - c.startMs) / 1000
            self.assertGreaterEqual(dur_s, MIN_CHUNK_S - 0.5)  # tiny tolerance
            self.assertLessEqual(dur_s, MAX_CHUNK_S + 2.0)


class SkillMappingTests(unittest.TestCase):
    def test_detects_arm_wave_and_weight_shift(self):
        pose_path = _make_pose_json(duration_s=10.0)
        beats = [i * 0.5 for i in range(20)]
        chunks = auto_chunk(pose_path, beats, 10.0)
        skills, weights = map_skills(pose_path, chunks)
        self.assertIn("posture_alignment", skills)
        # The synthetic dance moves wrists ±0.25 in x: should fire arm_wave.
        self.assertIn("arm_wave", skills)
        # And hips ±0.1 in x: should fire hip_isolation + weight_shift_basic.
        self.assertIn("weight_shift_basic", skills)
        # Skill weights normalised to ~1.
        self.assertAlmostEqual(sum(weights.values()), 1.0, places=2)


if __name__ == "__main__":
    unittest.main()
