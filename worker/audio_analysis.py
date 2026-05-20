"""Beat detection via librosa.beat.beat_track."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np

log = logging.getLogger("worker.audio")


@dataclass
class BeatInfo:
    bpm: float
    beat_times_seconds: list[float]


def detect_beats(audio_path: Path) -> BeatInfo:
    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    if y.size == 0:
        return BeatInfo(bpm=0.0, beat_times_seconds=[])
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    bpm = float(np.asarray(tempo).reshape(-1)[0]) if np.size(tempo) else 0.0
    log.info("beats: bpm=%.2f, count=%d", bpm, len(beat_times))
    return BeatInfo(bpm=bpm, beat_times_seconds=[float(t) for t in beat_times])
