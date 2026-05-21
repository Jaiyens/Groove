"""Three-layer lead-dancer detector (spec.md round-5 §Fix 5).

Layer 1: Gemini 2.5 Flash VLM looks at the opening frame with
labelled bounding boxes drawn around each detected person and returns
which one is the lead. This is the primary signal — the geometric
heuristic from Round 4 broke on multi-person clips where dancers stand
shoulder-to-shoulder at the same depth (e.g. @hearts2miraaa).

Layer 2: When dancer_count >= 2, the picker is shown as confirmation.
For dancer_count >= 3 the picker is ALWAYS shown regardless of VLM
confidence — an intentional safety policy to keep the user in the
loop on crowded shots.

Layer 3: If the VLM call fails (no API key, network down, parse
error), we fall back to a stronger geometric heuristic that weights
opening-frame centrality more heavily than the old formula.

Cost: gemini-2.5-flash with thinking disabled is ~$0.002 / call. We
log every call to worker/logs/vlm_calls.log with token counts.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

log = logging.getLogger("worker.lead_detector")


# ----- public API --------------------------------------------------

@dataclass
class LeadDetection:
    """Result of running the three-layer detector on a multi-person clip.

    `lead_track_id` is one of the input person IDs ("p1", "p2", ...).
    `confidence` is "high" | "medium" | "low" | None (None when we
    fell through to the heuristic). `reasoning` is a short
    human-readable string suitable for showing in the picker UI.
    """

    lead_track_id: str
    confidence: Optional[str]
    reasoning: str
    source: str  # "vlm" | "heuristic"


def detect_lead_dancer(
    opening_frame_bgr: Optional[np.ndarray],
    track_bboxes_pixels: dict[str, tuple[float, float, float, float]],
    person_summaries: list[dict],
    *,
    username: Optional[str],
    dance_id: Optional[str] = None,
) -> LeadDetection:
    """Pick the lead dancer.

    `track_bboxes_pixels` is {track_id: (x0, y0, x1, y1)} in pixel
    coords for the opening frame. `person_summaries` is the per-track
    metric dicts already computed by the pose pipeline (lead_score,
    opening_centrality, etc.) — used by the heuristic fallback.
    """
    if not person_summaries:
        raise ValueError("no persons to choose from")
    if len(person_summaries) == 1:
        only = person_summaries[0]
        return LeadDetection(
            lead_track_id=only["id"],
            confidence=None,
            reasoning="only one dancer detected",
            source="heuristic",
        )

    # Layer 1: VLM.
    if opening_frame_bgr is not None and track_bboxes_pixels:
        try:
            res = _detect_lead_vlm(
                opening_frame_bgr,
                track_bboxes_pixels,
                username=username,
                dance_id=dance_id,
            )
            if res is not None:
                return res
        except Exception:
            log.exception("VLM lead detection raised; falling through to heuristic")

    # Layer 3: heuristic safety net.
    return _detect_lead_heuristic(person_summaries)


def compute_lead_score_heuristic(
    persistence: float,
    opening_centrality: float,
    size_avg: float,
    forwardness_avg: float,
) -> float:
    """spec.md round-5 §Layer 3 formula. Opening-frame centrality
    dominates because that's the strongest cue for "who is the camera
    framed around" in the first second of a TikTok dance."""
    return (
        0.5 * opening_centrality
        + 0.2 * size_avg
        + 0.15 * forwardness_avg
        + 0.15 * persistence
    )


# ----- VLM (Layer 1) -----------------------------------------------

_LOG_PATH = Path(__file__).resolve().parent / "logs" / "vlm_calls.log"
_PROMPT_TEMPLATE = """\
This is a frame from a TikTok dance video. The numbered boxes
(P1, P2, P3, ...) mark each person detected. Identify which numbered
person is the LEAD or MAIN dancer — the one the camera is framed
around, who initiates moves, or who appears central to the
choreography. Consider:
- Who is most centered in the frame
- Who appears closest to the camera
- Whose body language suggests they're leading (e.g., facing the
  camera directly, standing slightly forward)
- The TikTok username is {username_label} — they posted the video,
  so they are likely the lead

Respond ONLY with a JSON object:
{{"lead_person_id": "P1", "confidence": "high|medium|low", "reasoning": "short explanation"}}
"""


def _detect_lead_vlm(
    opening_frame_bgr: np.ndarray,
    track_bboxes_pixels: dict[str, tuple[float, float, float, float]],
    *,
    username: Optional[str],
    dance_id: Optional[str],
) -> Optional[LeadDetection]:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        log.info("GEMINI_API_KEY not set; skipping VLM detector")
        return None

    try:
        import google.generativeai as genai
        from PIL import Image
    except ImportError:
        log.warning("google-generativeai or Pillow not installed; skipping VLM")
        return None

    # Sort track IDs by horizontal order so the labels go left → right
    # (more intuitive for the model and for our debug dumps).
    sorted_ids = sorted(
        track_bboxes_pixels.keys(),
        key=lambda tid: (track_bboxes_pixels[tid][0] + track_bboxes_pixels[tid][2]) / 2.0,
    )
    label_to_tid: dict[str, str] = {f"P{i + 1}": tid for i, tid in enumerate(sorted_ids)}
    tid_to_label = {tid: label for label, tid in label_to_tid.items()}

    annotated = _annotate_frame(opening_frame_bgr, track_bboxes_pixels, tid_to_label)

    # Debug dump for inspection — only when WORKER_DEBUG=1.
    if os.environ.get("WORKER_DEBUG") == "1":
        debug_dir = Path(__file__).resolve().parent / "debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        stem = dance_id or "lead-debug"
        cv2.imwrite(str(debug_dir / f"{stem}_opening_annotated.jpg"), annotated)

    pil = Image.fromarray(cv2.cvtColor(annotated, cv2.COLOR_BGR2RGB))

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-2.5-flash")
    username_label = f"@{username.lstrip('@')}" if username else "unknown"
    prompt = _PROMPT_TEMPLATE.format(username_label=username_label)

    # Try to disable thinking for cost / latency. Some SDK versions
    # raise (TypeError / ValueError) on unknown keys instead of silently
    # ignoring them — fall back to the minimal config in that case.
    full_config = {
        "response_mime_type": "application/json",
        "thinking_config": {"thinking_budget": 0},
    }
    minimal_config = {"response_mime_type": "application/json"}

    t0 = time.monotonic()
    try:
        resp = model.generate_content([pil, prompt], generation_config=full_config)
    except (TypeError, ValueError):
        try:
            resp = model.generate_content([pil, prompt], generation_config=minimal_config)
        except (TypeError, ValueError):
            # Even minimal config rejected — try a plain call.
            resp = model.generate_content([pil, prompt])
    latency_ms = int((time.monotonic() - t0) * 1000)

    text = (resp.text or "").strip()
    _log_call(dance_id, username, len(label_to_tid), text, latency_ms, resp)
    parsed = _parse_vlm_json(text)
    if parsed is None:
        log.warning("VLM response not JSON-parseable: %r", text[:200])
        return None

    label = str(parsed.get("lead_person_id") or "").strip().upper()
    confidence = str(parsed.get("confidence") or "").strip().lower()
    reasoning = str(parsed.get("reasoning") or "").strip() or "VLM did not provide reasoning"
    if label not in label_to_tid:
        log.warning("VLM returned unknown label %r (known: %s)", label, list(label_to_tid))
        return None
    if confidence not in {"high", "medium", "low"}:
        log.warning("VLM returned unknown confidence %r; clamping to low", confidence)
        confidence = "low"
    return LeadDetection(
        lead_track_id=label_to_tid[label],
        confidence=confidence,
        reasoning=reasoning,
        source="vlm",
    )


_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_vlm_json(text: str) -> Optional[dict]:
    # The SDK with response_mime_type=json should return raw JSON, but
    # be lenient — some responses wrap in code fences or prose.
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[len("json"):].strip()
    try:
        return json.loads(text)
    except Exception:
        match = _JSON_OBJ_RE.search(text)
        if match is None:
            return None
        try:
            return json.loads(match.group(0))
        except Exception:
            return None


def _annotate_frame(
    frame_bgr: np.ndarray,
    track_bboxes_pixels: dict[str, tuple[float, float, float, float]],
    tid_to_label: dict[str, str],
) -> np.ndarray:
    out = frame_bgr.copy()
    for tid, (x0, y0, x1, y1) in track_bboxes_pixels.items():
        label = tid_to_label.get(tid, tid)
        pt1 = (int(round(x0)), int(round(y0)))
        pt2 = (int(round(x1)), int(round(y1)))
        # Outer red rectangle, white inner stroke for contrast.
        cv2.rectangle(out, pt1, pt2, (0, 0, 255), 6)
        cv2.rectangle(out, pt1, pt2, (255, 255, 255), 2)
        # Label background: filled rect, white text.
        font = cv2.FONT_HERSHEY_SIMPLEX
        scale = 1.2
        thickness = 3
        (tw, th), baseline = cv2.getTextSize(label, font, scale, thickness)
        bg_x0, bg_y0 = pt1[0], max(0, pt1[1] - th - 12)
        bg_x1, bg_y1 = bg_x0 + tw + 16, bg_y0 + th + 12
        cv2.rectangle(out, (bg_x0, bg_y0), (bg_x1, bg_y1), (0, 0, 0), -1)
        cv2.putText(
            out, label, (bg_x0 + 8, bg_y1 - 8 - baseline // 2),
            font, scale, (255, 255, 255), thickness, cv2.LINE_AA,
        )
    return out


def _log_call(
    dance_id: Optional[str],
    username: Optional[str],
    n_persons: int,
    response_text: str,
    latency_ms: int,
    resp,
) -> None:
    """Append a JSON-line cost record per spec hard rule §3."""
    try:
        _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        usage = {}
        try:
            um = getattr(resp, "usage_metadata", None)
            if um is not None:
                usage = {
                    "prompt_tokens": getattr(um, "prompt_token_count", None),
                    "candidates_tokens": getattr(um, "candidates_token_count", None),
                    "total_tokens": getattr(um, "total_token_count", None),
                }
        except Exception:
            pass
        record = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "dance_id": dance_id,
            "username": username,
            "model": "gemini-2.5-flash",
            "n_persons": n_persons,
            "latency_ms": latency_ms,
            "usage": usage,
            "response_preview": (response_text or "")[:240],
        }
        with _LOG_PATH.open("a") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception:
        log.exception("failed to write vlm_calls.log")


# ----- heuristic (Layer 3) -----------------------------------------

def _detect_lead_heuristic(person_summaries: list[dict]) -> LeadDetection:
    # Recompute lead_score using the round-5 formula so we don't
    # silently mix old/new scoring across rows.
    rescored = []
    for p in person_summaries:
        score = compute_lead_score_heuristic(
            persistence=p.get("persistence", 0.0),
            opening_centrality=p.get("opening_centrality", 0.0),
            size_avg=p.get("size", 0.0),
            forwardness_avg=p.get("forwardness", 0.0),
        )
        rescored.append((score, p))
    rescored.sort(key=lambda t: t[0], reverse=True)
    top_score, top = rescored[0]
    return LeadDetection(
        lead_track_id=top["id"],
        confidence=None,
        reasoning="VLM unavailable, used heuristic fallback",
        source="heuristic",
    )
