"""Supabase wrapper for the worker.

Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment.
Provides:
- claim_next_queued() — atomically flip a queued row to processing
- mark_failed(id, msg)
- upload_and_finalise(id, PipelineResult) — uploads all artifacts to Storage,
  updates the row with the resulting URLs, sets status='ready'.
"""

from __future__ import annotations

import logging
import os
import mimetypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from supabase import Client, create_client

from pipeline import PipelineResult

log = logging.getLogger("worker.store")

BUCKET_POSE = "pose-data"
BUCKET_SKELETON = "skeleton-videos"
BUCKET_AUDIO = "audio"
BUCKET_THUMBNAIL = "thumbnails"


def make_store() -> "SupabaseStore":
    raw_url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not raw_url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required"
        )
    url = _normalise_url(raw_url)
    client = create_client(url, key)
    return SupabaseStore(client, url)


def _normalise_url(raw: str) -> str:
    """The supabase client expects the base origin (https://xxx.supabase.co).
    Strip any trailing /rest/v1 or trailing slash a user might paste in."""
    url = raw.strip().rstrip("/")
    for suffix in ("/rest/v1", "/rest"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
    return url


class SupabaseStore:
    def __init__(self, client: Client, base_url: str):
        self.client = client
        self.base_url = base_url.rstrip("/")
        # Detect columns lazily so writes don't fail on a schema that's missing
        # the day-3 additions (low_quality, audio_start_offset_ms). Some
        # earlier migrations are still out there in user databases.
        self._columns: set[str] | None = None

    def _known_columns(self) -> set[str]:
        if self._columns is not None:
            return self._columns
        try:
            rows = self.client.table("dances").select("*").limit(1).execute().data
            if rows:
                self._columns = set(rows[0].keys())
                return self._columns
        except Exception:
            pass
        # Best-effort fallback: assume the v1 schema (no optional columns).
        self._columns = {
            "id", "tiktok_url", "title", "creator_handle",
            "duration_seconds", "bpm", "status", "error_message",
            "thumbnail_url", "pose_data_url", "skeleton_video_url",
            "audio_url", "chunks_json", "required_skills",
            "skill_weights", "submitted_by_session_id", "view_count",
            "created_at", "ready_at",
        }
        return self._columns

    def claim_next_queued(self) -> dict | None:
        # Find a queued row, optimistic-update it to processing.
        rows = (
            self.client.table("dances")
            .select("*")
            .eq("status", "queued")
            .order("created_at")
            .limit(1)
            .execute()
            .data
        )
        if not rows:
            return None
        row = rows[0]
        upd = (
            self.client.table("dances")
            .update({"status": "processing"})
            .eq("id", row["id"])
            .eq("status", "queued")
            .execute()
        )
        if not upd.data:
            # Lost the race to another worker
            return None
        return upd.data[0]

    def insert_queued(self, tiktok_url: str, mark_processing: bool = False) -> str:
        existing = (
            self.client.table("dances")
            .select("id")
            .eq("tiktok_url", tiktok_url)
            .maybeSingle()
            .execute()
            .data
            if hasattr(self.client.table("dances").select("id").eq("tiktok_url", tiktok_url), "maybeSingle")
            else None
        )
        if existing and existing.get("id"):
            dance_id = existing["id"]
            self.client.table("dances").update({
                "status": "processing" if mark_processing else "queued",
                "error_message": None,
            }).eq("id", dance_id).execute()
            return dance_id
        rows = (
            self.client.table("dances")
            .select("id")
            .eq("tiktok_url", tiktok_url)
            .limit(1)
            .execute()
            .data
        )
        if rows:
            dance_id = rows[0]["id"]
            self.client.table("dances").update({
                "status": "processing" if mark_processing else "queued",
                "error_message": None,
            }).eq("id", dance_id).execute()
            return dance_id
        row = (
            self.client.table("dances")
            .insert({
                "tiktok_url": tiktok_url,
                "status": "processing" if mark_processing else "queued",
            })
            .execute()
            .data[0]
        )
        return row["id"]

    def mark_failed(self, dance_id: str, message: str) -> None:
        self.client.table("dances").update({
            "status": "failed",
            "error_message": message[:2000],
        }).eq("id", dance_id).execute()

    def upload_and_finalise(self, dance_id: str, result: PipelineResult) -> None:
        urls: dict[str, str] = {}
        if result.pose_data_path:
            urls["pose_data_url"] = self._upload(
                BUCKET_POSE, f"{dance_id}/pose.json", result.pose_data_path
            )
        if result.skeleton_video_path:
            urls["skeleton_video_url"] = self._upload(
                BUCKET_SKELETON, f"{dance_id}/skeleton.mp4", result.skeleton_video_path
            )
        if result.audio_path:
            # Re-encode wav → mp3 for the browser; here we just upload the wav
            # and let the browser handle. (CDN cost > re-encode cost for now.)
            urls["audio_url"] = self._upload(
                BUCKET_AUDIO, f"{dance_id}/audio.wav", result.audio_path
            )
        if result.thumbnail_path:
            urls["thumbnail_url"] = self._upload(
                BUCKET_THUMBNAIL, f"{dance_id}/thumbnail.jpg", result.thumbnail_path
            )

        candidate: dict[str, Any] = {
            "status": "ready",
            "title": result.title,
            "creator_handle": result.creator_handle,
            "duration_seconds": result.duration_seconds,
            "bpm": result.bpm,
            "chunks_json": result.chunks,
            "required_skills": result.required_skills,
            "skill_weights": result.skill_weights,
            "low_quality": result.low_quality,
            "audio_start_offset_ms": result.audio_start_offset_ms,
            "ready_at": datetime.now(timezone.utc).isoformat(),
            **urls,
        }
        cols = self._known_columns()
        update = {k: v for k, v in candidate.items() if k in cols}
        dropped = sorted(set(candidate) - set(update))
        if dropped:
            log.warning("skipping columns missing from db schema: %s", dropped)
        self.client.table("dances").update(update).eq("id", dance_id).execute()

    def _upload(self, bucket: str, key: str, path: Path) -> str:
        log.debug("upload %s/%s ← %s", bucket, key, path)
        content_type, _ = mimetypes.guess_type(str(path))
        with path.open("rb") as fh:
            data = fh.read()
        # Idempotent: remove first if exists.
        try:
            self.client.storage.from_(bucket).remove([key])
        except Exception:
            pass
        self.client.storage.from_(bucket).upload(
            path=key,
            file=data,
            file_options={"content-type": content_type or "application/octet-stream"},
        )
        return f"{self.base_url}/storage/v1/object/public/{bucket}/{key}"
