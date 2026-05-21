"""
End-to-end pipeline: yt-dlp → librosa → MediaPipe → chunker → skeleton mp4 →
thumbnail. Produces a PipelineResult dataclass that the caller can hand to
the Supabase uploader.

Each step writes intermediate artifacts to disk so they can be inspected
(useful for debugging low-quality dances).
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

log = logging.getLogger("worker.pipeline")


@dataclass
class PipelineConfig:
    url: str
    out_dir: Path


@dataclass
class PipelineResult:
    url: str
    out_dir: Path
    title: str | None = None
    creator_handle: str | None = None
    duration_seconds: float | None = None
    bpm: float | None = None
    beats: list[float] = field(default_factory=list)
    chunks: list[dict[str, Any]] = field(default_factory=list)
    required_skills: list[str] = field(default_factory=list)
    skill_weights: dict[str, float] = field(default_factory=dict)
    pose_data_path: Path | None = None
    skeleton_video_path: Path | None = None
    video_path: Path | None = None
    audio_path: Path | None = None
    thumbnail_path: Path | None = None
    # Phase 3 multi-person metadata. None / empty when single-dancer.
    dancer_count: int = 1
    auto_selected_person_id: str | None = None
    requires_dancer_pick: bool = False
    person_thumbnails: dict[str, Path] = field(default_factory=dict)
    low_quality: bool = False
    audio_start_offset_ms: int = 0
    error: str | None = None

    def write_manifest(self, path: Path) -> None:
        manifest: dict[str, Any] = asdict(self)
        # Paths → relative strings for portability
        for key in (
            "out_dir",
            "pose_data_path",
            "skeleton_video_path",
            "video_path",
            "audio_path",
            "thumbnail_path",
        ):
            value = manifest.get(key)
            manifest[key] = str(value) if value else None
        manifest["person_thumbnails"] = {
            k: str(v) for k, v in (self.person_thumbnails or {}).items()
        }
        path.write_text(json.dumps(manifest, indent=2))


def run_pipeline(cfg: PipelineConfig) -> PipelineResult:
    cfg.out_dir.mkdir(parents=True, exist_ok=True)
    result = PipelineResult(url=cfg.url, out_dir=cfg.out_dir)

    # 1. Download
    from download import download_tiktok

    log.info("[1/7] download")
    media = download_tiktok(cfg.url, cfg.out_dir)
    result.title = media.title
    result.creator_handle = media.creator_handle
    result.duration_seconds = media.duration_seconds
    result.audio_path = media.audio_path
    result.video_path = media.video_path

    # 2. Beat detection
    from audio_analysis import detect_beats

    log.info("[2/7] beats")
    beat_info = detect_beats(media.audio_path)
    result.bpm = beat_info.bpm
    result.beats = beat_info.beat_times_seconds

    # 3. Pose extraction
    from pose import extract_pose

    log.info("[3/7] pose")
    pose_path, low_quality = extract_pose(media.video_path, cfg.out_dir / "pose.json")
    result.pose_data_path = pose_path
    result.low_quality = low_quality

    # 4. Auto-chunking
    from chunker import auto_chunk

    log.info("[4/7] chunks")
    chunks = auto_chunk(pose_path, beat_info.beat_times_seconds, media.duration_seconds)
    result.chunks = [c.__dict__ for c in chunks]

    # 5. Skill mapping
    from skill_mapping import map_skills

    log.info("[5/7] skills")
    skills, weights = map_skills(pose_path, chunks)
    result.required_skills = skills
    result.skill_weights = weights
    for c, ch in zip(result.chunks, chunks):
        c["skills"] = ch.skills

    # 6. Skeleton video
    from skeleton_video import render_skeleton

    log.info("[6/7] skeleton video")
    sk_path = render_skeleton(
        pose_path,
        cfg.out_dir / "skeleton.mp4",
        duration_s=media.duration_seconds,
        fps=media.fps,
    )
    result.skeleton_video_path = sk_path

    # 7. Thumbnail (library + per-person)
    from thumbnail import extract_person_thumbnails, extract_thumbnail

    log.info("[7/7] thumbnail")
    thumb = extract_thumbnail(
        media.video_path,
        cfg.out_dir / "thumbnail.jpg",
        pose_json_path=pose_path,
        duration_seconds=media.duration_seconds,
    )
    result.thumbnail_path = thumb

    # Read multi-person metadata out of pose.json so the upload step can
    # write it back to the row.
    try:
        pose_doc = json.loads(pose_path.read_text())
        result.dancer_count = int(pose_doc.get("dancer_count") or 1)
        result.auto_selected_person_id = pose_doc.get("auto_selected_person_id")
        result.requires_dancer_pick = bool(pose_doc.get("requires_dancer_pick"))
    except Exception:
        pass

    if result.dancer_count > 1:
        person_thumbs = extract_person_thumbnails(
            media.video_path, pose_path, cfg.out_dir / "persons"
        )
        result.person_thumbnails = person_thumbs

    return result


def shell(cmd: list[str], cwd: Path | None = None) -> str:
    log.debug("$ %s", " ".join(cmd))
    proc = subprocess.run(cmd, cwd=cwd, check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"stderr: {proc.stderr.strip()}"
        )
    return proc.stdout
