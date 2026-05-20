"""
Groove worker — polls Supabase for queued dance submissions, runs the
end-to-end pipeline, writes results back.

Usage:
    python main.py                    # long-running poller
    python main.py --once <url>       # process a single URL and exit
    python main.py --once <url> --local-only --out ./out
                                       # produce artifacts locally, no upload
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
import traceback
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

from pipeline import PipelineConfig, PipelineResult, run_pipeline
from store import SupabaseStore, make_store

load_dotenv()
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

logging.basicConfig(
    level=os.environ.get("WORKER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("worker")

POLL_INTERVAL_SECONDS = float(os.environ.get("WORKER_POLL_INTERVAL", "5"))
WORK_DIR = Path(os.environ.get("WORKER_WORK_DIR", "/tmp/groove-worker"))

_STOP = False


def _handle_signal(signum, _frame):
    global _STOP
    log.info("received signal %s, draining…", signum)
    _STOP = True


def poll_loop(store: SupabaseStore, work_dir: Path) -> None:
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    log.info("worker started (polling every %.1fs)", POLL_INTERVAL_SECONDS)
    while not _STOP:
        try:
            row = store.claim_next_queued()
        except Exception:
            log.exception("claim_next_queued failed")
            time.sleep(POLL_INTERVAL_SECONDS)
            continue
        if not row:
            time.sleep(POLL_INTERVAL_SECONDS)
            continue
        log.info("processing %s (%s)", row["id"], row["tiktok_url"])
        try:
            _process_row(store, row, work_dir)
        except Exception as exc:
            log.exception("pipeline failed for %s", row["id"])
            store.mark_failed(row["id"], str(exc))


def _process_row(store: SupabaseStore, row: dict, work_dir: Path) -> None:
    dance_id = row["id"]
    tiktok_url = row["tiktok_url"]
    job_dir = work_dir / dance_id
    job_dir.mkdir(parents=True, exist_ok=True)
    cfg = PipelineConfig(url=tiktok_url, out_dir=job_dir)
    result = run_pipeline(cfg)
    log.info("pipeline complete, uploading artifacts for %s", dance_id)
    store.upload_and_finalise(dance_id, result)
    log.info("dance %s ready", dance_id)


def run_once(url: str, out: Path, local_only: bool) -> None:
    out.mkdir(parents=True, exist_ok=True)
    cfg = PipelineConfig(url=url, out_dir=out)
    result = run_pipeline(cfg)
    log.info("pipeline complete; artifacts in %s", out)
    if local_only:
        result.write_manifest(out / "manifest.json")
        return
    store = make_store()
    record_id = store.insert_queued(url, mark_processing=True)
    store.upload_and_finalise(record_id, result)
    log.info("inserted + finalised %s", record_id)


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--once", metavar="URL", help="process a single URL and exit")
    p.add_argument("--out", type=Path, default=Path("./out"))
    p.add_argument(
        "--local-only",
        action="store_true",
        help="skip Supabase upload (only useful with --once)",
    )
    args = p.parse_args(argv)

    if args.once:
        run_once(args.once, args.out, args.local_only)
        return 0

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    store = make_store()
    poll_loop(store, WORK_DIR)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
