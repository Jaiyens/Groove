"""
SPECK polish §Fix 3: AI-generated dance names.

Priority cascade:
  1. If the TikTok caption (`title`) already looks like a clean song
     title — e.g. "<Artist> - <Song>" or "<Song> by <Artist>" — keep
     it. We drop boilerplate ("original sound", "som original",
     "nhạc nền — …", "douyin dance") that TikTok injects.
  2. Otherwise send the first 15 s of the downloaded audio to Gemini
     2.5 Flash and ask it to either name the song or describe the
     genre in 2–4 words.
  3. Fallback: "@<username>'s dance".

Every Gemini call appends a JSON line to worker/logs/vlm_calls.log
with token usage and latency so we can audit cost later.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

log = logging.getLogger("worker.naming")

_LOG_PATH = Path(__file__).resolve().parent / "logs" / "vlm_calls.log"

# Phrases that mean "TikTok didn't get a usable title for this clip".
# Match case-insensitively; also strip when they appear at the end of a
# longer caption ("Fetty Wap - Birthday Bounce - original sound").
_BOILERPLATE = (
    "original sound",
    "som original",
    "sonido original",
    "nhạc nền",
    "nhac nen",
    "douyin dance",
    "tiktok dance",
)

_ARTIST_SONG = re.compile(r"^\s*(?P<artist>[^-–—]{1,40})\s*[-–—]\s*(?P<song>[^-–—]{1,60})\s*$")
_SONG_BY_ARTIST = re.compile(r"^\s*(?P<song>[^-–—]{1,60})\s+by\s+(?P<artist>[^-–—]{1,40})\s*$", re.IGNORECASE)

_PROMPT = (
    "Listen to this audio clip from a TikTok dance video. If you recognize "
    "the song, respond with \"<Artist> - <Song>\". If you don't recognize "
    "it but can describe the genre/style in 2-4 words, respond with that "
    "(e.g. \"Afrobeats groove\", \"K-pop chorus\", \"trap dance\"). "
    "Respond ONLY with the name, no quotes, no explanation."
)


def generate_display_name(
    *,
    title: Optional[str],
    creator_handle: Optional[str],
    audio_path: Optional[Path],
    dance_id: Optional[str] = None,
) -> str:
    """Run the three-step naming cascade and return a display string.

    Always returns a non-empty string. Errors are caught and the function
    falls through to the username-based fallback.
    """
    cleaned = _clean_caption(title)
    if cleaned:
        log.info("naming: kept caption %r → %r", title, cleaned)
        return cleaned

    if audio_path and audio_path.exists():
        try:
            via_gemini = _name_from_audio(audio_path, dance_id=dance_id, username=creator_handle)
            if via_gemini:
                log.info("naming: gemini %r", via_gemini)
                return via_gemini
        except Exception:
            log.exception("naming: gemini call failed; falling back")

    if creator_handle:
        return f"@{creator_handle.lstrip('@')}'s dance"
    return "untitled dance"


def _clean_caption(title: Optional[str]) -> Optional[str]:
    """Return a cleaned-up caption if it looks like a song title, else None."""
    if not title:
        return None
    raw = title.strip()
    if not raw:
        return None
    low = raw.lower()
    if any(bp in low for bp in _BOILERPLATE):
        # The caption is dominated by TikTok boilerplate — don't trust it
        # even if there's something real on the side. Send to Gemini.
        return None

    # Strip leading hashtags and TikTok-style attribution clutter.
    raw = re.sub(r"#\S+", "", raw).strip()
    raw = re.sub(r"\s+", " ", raw)

    m = _ARTIST_SONG.match(raw)
    if m:
        return f"{m.group('artist').strip()} - {m.group('song').strip()}"
    m = _SONG_BY_ARTIST.match(raw)
    if m:
        return f"{m.group('artist').strip()} - {m.group('song').strip()}"

    # No structural match. Accept it ONLY if it looks like a curated
    # title: at least one capitalized letter and not just a lowercase
    # word-salad. "fetty wap birthday nola bounce" looks like raw fan
    # search terms — send it to Gemini to canonicalize. "TAKA LA
    # DENTRO" and "City Girls x Camila" have caps and read like titles.
    if not (3 <= len(raw) <= 60):
        return None
    if not re.search(r"[A-Za-z]", raw) or raw.startswith("#"):
        return None
    has_upper = any(c.isupper() for c in raw)
    if has_upper:
        return raw
    return None


def _name_from_audio(
    audio_path: Path,
    *,
    dance_id: Optional[str],
    username: Optional[str],
) -> Optional[str]:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        log.info("naming: GEMINI_API_KEY not set")
        return None

    try:
        import google.generativeai as genai
    except ImportError:
        log.warning("naming: google-generativeai not installed")
        return None

    clip = _first_15s_clip(audio_path)
    if clip is None:
        return None

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-2.5-flash")

    full_config = {"thinking_config": {"thinking_budget": 0}}
    t0 = time.monotonic()
    audio_part = {"mime_type": "audio/wav", "data": clip.read_bytes()}
    try:
        resp = model.generate_content([_PROMPT, audio_part], generation_config=full_config)
    except (TypeError, ValueError):
        resp = model.generate_content([_PROMPT, audio_part])
    latency_ms = int((time.monotonic() - t0) * 1000)

    text = (getattr(resp, "text", None) or "").strip()
    _log_call(dance_id=dance_id, username=username, response_text=text, latency_ms=latency_ms, resp=resp)

    if not text:
        return None
    # Defensive: Gemini sometimes prefaces with quotes or "Song: ".
    text = text.strip().strip('"').strip("'")
    text = re.sub(r"^(song|title|name)\s*[:\-]\s*", "", text, flags=re.IGNORECASE)
    if len(text) < 2 or len(text) > 80:
        return None
    refusal_markers = ("i cannot", "i can't", "sorry", "unable to", "i am unable")
    if any(text.lower().startswith(m) for m in refusal_markers):
        return None
    return text


def _first_15s_clip(audio_path: Path) -> Optional[Path]:
    """Return a wav containing the first 15 s of the source. Falls back to
    the original file if ffmpeg isn't available."""
    out = audio_path.with_name(audio_path.stem + ".first15.wav")
    if out.exists():
        return out
    try:
        import subprocess

        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(audio_path),
                "-t", "15",
                "-ac", "1",
                "-ar", "16000",
                str(out),
            ],
            check=True,
        )
        return out
    except Exception:
        log.warning("naming: ffmpeg slice failed, sending full audio")
        return audio_path if audio_path.exists() else None


def _log_call(
    *,
    dance_id: Optional[str],
    username: Optional[str],
    response_text: str,
    latency_ms: int,
    resp,
) -> None:
    try:
        _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        usage = {}
        um = getattr(resp, "usage_metadata", None)
        if um is not None:
            usage = {
                "prompt_tokens": getattr(um, "prompt_token_count", None),
                "candidates_tokens": getattr(um, "candidates_token_count", None),
                "total_tokens": getattr(um, "total_token_count", None),
            }
        record = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "kind": "naming",
            "dance_id": dance_id,
            "username": username,
            "model": "gemini-2.5-flash",
            "latency_ms": latency_ms,
            "usage": usage,
            "response": response_text[:200],
        }
        with _LOG_PATH.open("a") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception:
        log.debug("vlm_calls.log append failed", exc_info=True)
