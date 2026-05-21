"""One-shot helper: re-fetch metadata for every ready dance in Supabase and
rewrite its title using the new `clean_title()` heuristic.

Usage:
    cd worker
    source venv/bin/activate
    python refresh_titles.py            # all ready dances
    python refresh_titles.py --id <uuid>  # one specific dance

Idempotent — running it twice produces the same title.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv

from download import clean_title
from store import make_store

load_dotenv()
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("worker.refresh_titles")


def fetch_metadata(url: str) -> dict:
    """yt-dlp --skip-download --dump-json — returns the same `info` dict the
    full download flow would have produced."""
    proc = subprocess.run(
        [
            "yt-dlp",
            "--no-warnings",
            "--no-progress",
            "--skip-download",
            "--dump-json",
            url,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--id", help="refresh a single dance by id")
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="show proposed titles without writing them back",
    )
    args = p.parse_args(argv)

    store = make_store()
    query = store.client.table("dances").select(
        "id, tiktok_url, title, creator_handle"
    ).eq("status", "ready")
    if args.id:
        query = query.eq("id", args.id)
    rows = query.execute().data or []

    if not rows:
        log.info("no ready dances to refresh")
        return 0

    log.info("refreshing %d dance(s)", len(rows))
    for row in rows:
        dance_id = row["id"]
        url = row["tiktok_url"]
        old = row.get("title")
        try:
            info = fetch_metadata(url)
        except Exception as exc:
            log.warning("skip %s (%s): %s", dance_id, url, exc)
            continue
        creator = info.get("uploader") or info.get("uploader_id") or row.get(
            "creator_handle"
        )
        new = clean_title(info, creator)
        log.info("%s: %r → %r", dance_id, old, new)
        if args.dry_run:
            continue
        update: dict = {}
        if new and new != old:
            update["title"] = new
        if creator and creator != row.get("creator_handle"):
            update["creator_handle"] = creator
        if update:
            store.client.table("dances").update(update).eq("id", dance_id).execute()
    return 0


if __name__ == "__main__":
    sys.exit(main())
