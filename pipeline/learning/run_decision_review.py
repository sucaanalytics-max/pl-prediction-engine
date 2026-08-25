"""
Produce the manager's decision review for every gameweek that has sealed.

I/O lives here; the judgements live in ``decision_review``. That split is not
decoration: the classification rules are the part that must be right, and they are
testable only if they take payloads rather than fetch them.

Reads, and never writes, ``predictions/fpl/ledger/``. The seal is the evidence this
whole artifact rests on — a producer that could touch it would be able to
manufacture the precedence it claims.
"""
from __future__ import annotations

import argparse
import json
import logging
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from pipeline.config import (
    CURRENT_SEASON,
    FPL_ENTRIES,
    FPL_ENTRY_PICKS,
    FPL_EVENT_LIVE,
    FPL_PUBLIC_DIR,
    PREDICTIONS_DIR,
)
from pipeline.learning import decision_review as dr
from pipeline.learning.ledger import gameweek_dir
from pipeline.learning.outcomes import parse_event_live

logger = logging.getLogger(__name__)

ARTIFACT_NAME = "decision_review.json"

# FPL serves these unauthenticated but refuses a default urllib agent.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
    )
}


def _get(url: str, *, timeout: float = 30.0) -> Optional[Dict[str, Any]]:
    """
    One GET, or None.

    None rather than a raise: a gameweek whose picks cannot be read should drop out
    of the review, not abort the ones that can. The caller logs it, and the
    artifact's ``observations`` count then differs from the number of sealed
    gameweeks, which is the honest signal that something was skipped.
    """
    try:
        request = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as error:
        logger.warning("could not fetch %s: %s", url, error)
        return None


def sealed_gameweeks(predictions_dir: Path) -> List[int]:
    """
    Gameweeks with a real, non-dry-run seal on disk, in order.

    Dry runs live in their own quarantined directory, so simply not looking there
    is what excludes them — a dry-run seal proves nothing about precedence and must
    never reach a review.
    """
    root = Path(predictions_dir) / "fpl" / "ledger"
    if not root.is_dir():
        return []
    found: List[int] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or not child.name.startswith("gw"):
            continue
        try:
            gameweek = int(child.name[2:])
        except ValueError:
            continue
        if (child / "forecast.jsonl").is_file():
            found.append(gameweek)
    return found


def review_one(
    gameweek: int,
    entry_id: int,
    predictions_dir: Path,
) -> Optional[Dict[str, Any]]:
    """One gameweek, or None when any of its three inputs is unavailable."""
    forecast_path = gameweek_dir(predictions_dir, gameweek) / "forecast.jsonl"
    if not forecast_path.is_file():
        logger.warning("gw%02d has no sealed forecast; skipped", gameweek)
        return None

    lines = forecast_path.read_text().splitlines()
    header = dr.sealed_header(lines)
    if header is None:
        logger.warning("gw%02d seal has no header record; skipped", gameweek)
        return None
    if header.get("dry_run"):
        # Belt and braces: quarantine should have kept this out of reach, but a
        # dry run that reached a published review would be a false claim of
        # precedence, so it is refused here too.
        logger.warning("gw%02d seal is a dry run; refused", gameweek)
        return None

    sealed = dr.load_sealed(lines)
    if not sealed:
        logger.warning("gw%02d seal carries no usable forecast rows; skipped", gameweek)
        return None

    picks = _get(FPL_ENTRY_PICKS.format(entry_id=entry_id, gameweek=gameweek))
    if not picks or not picks.get("picks"):
        # Before a gameweek's deadline FPL withholds picks entirely, which is the
        # normal reason to land here and not an error.
        logger.info("gw%02d picks unavailable; not yet reviewable", gameweek)
        return None

    live = _get(FPL_EVENT_LIVE.format(gameweek=gameweek))
    if not live:
        return None
    try:
        outcomes = parse_event_live(live)
    except Exception as error:  # noqa: BLE001 - a malformed envelope is not fatal
        logger.warning("gw%02d live payload unusable: %s", gameweek, error)
        return None
    if not outcomes:
        logger.info("gw%02d has no settled outcomes yet", gameweek)
        return None

    points = {eid: row["total_points"] for eid, row in outcomes.items()}
    minutes = {eid: row["minutes"] for eid, row in outcomes.items()}
    return dr.review_gameweek(
        gameweek, picks, points, minutes, sealed, seal=header
    )


def _names(bootstrap: Optional[Mapping[str, Any]]) -> Dict[str, str]:
    """
    Element id -> display name, keyed as strings because JSON keys are strings.

    Resolved into the artifact rather than left to the reader for the same reason
    ``public_xp.build`` takes a ``names`` map: a consumer that had to join element
    ids against another file would render a blank row whenever the two artifacts
    disagreed about the universe, and a nameless row in a review of your own
    decisions is worse than useless.
    """
    if not bootstrap:
        return {}
    out: Dict[str, str] = {}
    for element in bootstrap.get("elements") or []:
        element_id = element.get("id")
        label = element.get("web_name")
        if element_id is not None and label:
            out[str(int(element_id))] = str(label)
    return out


def run(
    *,
    entry: str = "owner",
    predictions_dir: Path = PREDICTIONS_DIR,
    public_dir: Path = FPL_PUBLIC_DIR,
    season: str = CURRENT_SEASON,
    write: bool = True,
) -> Dict[str, Any]:
    """Review every sealed gameweek and, by default, publish the result."""
    config = FPL_ENTRIES.get(entry)
    if config is None:
        raise KeyError(f"no FPL entry configured under {entry!r}")
    entry_id = int(config["entry_id"])

    reviews: List[Dict[str, Any]] = []
    for gameweek in sealed_gameweeks(predictions_dir):
        review = review_one(gameweek, entry_id, predictions_dir)
        if review is not None:
            reviews.append(review)

    payload = dr.build(
        reviews,
        generated_at=datetime.now(timezone.utc).isoformat(),
        season=season,
    )
    payload["entry_id"] = entry_id
    payload["team_name"] = config.get("team_name")

    # Only the players actually named in a review, not the whole bootstrap: this
    # artifact is about fifteen players a week, and carrying 600 names would be
    # most of its bytes.
    if reviews:
        try:
            from pipeline.data.fpl_api import fetch_bootstrap_static

            wanted = {
                str(element)
                for review in reviews
                for element in (
                    list(review.get("submitted_eleven") or [])
                    + list(review.get("submitted_bench") or [])
                )
            }
            everyone = _names(fetch_bootstrap_static(allow_stale=True))
            payload["names"] = {k: v for k, v in everyone.items() if k in wanted}
        except Exception:
            # A review without names is degraded but still true. Inventing a
            # placeholder would put a wrong name beside a real decision.
            logger.warning("could not resolve player names; ids will stand alone")
            payload["names"] = {}
    else:
        payload["names"] = {}

    if write:
        target = Path(public_dir) / ARTIFACT_NAME
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=2) + "\n")
        logger.info(
            "wrote %s — %d gameweek(s) reviewed", target, payload["observations"]
        )
    return payload


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", default="owner")
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )
    payload = run(entry=args.entry, write=not args.no_write)
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
