"""
The news poller. Entry point for ``.github/workflows/news.yml``.

## Why a separate workflow rather than a step in the agent

The agent runs three-hourly. Team news arrives in bursts around press conferences
and in the last hour before a deadline, and a three-hour latency on "Salah is out"
is the difference between acting and not. So this runs every fifteen minutes.

That cadence is only affordable because the job is cheap and **self-gating on
state, not on the clock** — the pattern ``fpl_agent.yml`` already uses and
documents. Outside a news window it does one fixture read and exits in seconds.

## The window, and why it is derived

**No published press-conference schedule exists anywhere.** So the window comes
from the fixture list: pressers land roughly a day or two before kickoff, and the
deadline is the other hot period. `NEWS_WINDOW` holds the offsets.

## What this job may and may not write

It owns exactly one path, ``predictions/news_feed_state.json``, plus appends to the
shared append-only evidence store. It computes no projection and makes no decision:
those belong to the agent, which reads the evidence at its own cadence. Keeping the
poller write-narrow is what lets a third writer join the two that already push to
`main` without breaking the path-ownership invariant that makes concurrent rebases
safe.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

# Imported at module level, not inside poll(). Both are cheap — `feedparser` is
# itself imported lazily inside `news_feeds.parse()`, so nothing heavy loads here —
# and a function-level `from pipeline.data import news_extract` reads to the
# reachability scanner as importing the *package*, which left news_extract.py
# looking like a module nothing calls. That check exists because the same defect
# occurred five times in one session, and hiding from it would be the wrong fix.
from pipeline.data import news_extract, news_feeds, youtube
from pipeline.learning import deltas as deltas_store
from pipeline.learning.availability_conflicts import resolve_claims
from pipeline.learning.availability_evidence import history, record

logger = logging.getLogger(__name__)


def _fetch_json(url: str, timeout: int = 60) -> Any:
    request = urllib.request.Request(
        url, headers={"User-Agent": "pl-prediction-engine/1.0"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _parse(stamp: Optional[str]) -> Optional[datetime]:
    if not stamp:
        return None
    try:
        moment = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def in_news_window(
    fixtures: Sequence[Mapping[str, Any]],
    events: Sequence[Mapping[str, Any]],
    now: datetime,
    window: Mapping[str, Any],
) -> Tuple[bool, str]:
    """
    Whether now is a time when team news is plausibly arriving.

    Two independent reasons to be open, because they catch different things:

    * **Before a kickoff.** Pressers are held a day or two out, and the fixture
      list is the only schedule we have for them.
    * **Before a deadline.** The last hours before a deadline are when late news
      lands and when it matters most, even if the first kickoff is further away.

    Returns the reason as well as the verdict so the run log says why it woke up,
    which is the difference between a quiet job and an inscrutable one.
    """
    open_before = float(window.get("hours_before_kickoff_open", 72))
    close_before = float(window.get("hours_before_kickoff_close", 2))
    deadline_open = float(window.get("hours_before_deadline_open", 30))

    for fixture in fixtures:
        kickoff = _parse(fixture.get("kickoff_time"))
        if kickoff is None:
            continue
        hours = (kickoff - now).total_seconds() / 3600.0
        if close_before <= hours <= open_before:
            return True, f"kickoff in {hours:.1f}h"

    for event in events:
        deadline = _parse(event.get("deadline_time"))
        if deadline is None:
            continue
        hours = (deadline - now).total_seconds() / 3600.0
        if 0 <= hours <= deadline_open:
            gameweek = event.get("id")
            return True, f"GW{gameweek} deadline in {hours:.1f}h"

    return False, "no kickoff or deadline within the window"


def current_gameweek(events: Sequence[Mapping[str, Any]], now: datetime) -> int:
    """
    The gameweek a claim observed now belongs to.

    The NEXT gameweek whose deadline has not passed, because that is the one the
    news is about. Falls back to the last event so a claim is never filed against
    gameweek 0, which would make it unfindable.
    """
    upcoming = [
        (deadline, int(event["id"]))
        for event in events
        if (deadline := _parse(event.get("deadline_time"))) is not None
        and deadline > now
    ]
    if upcoming:
        return min(upcoming)[1]
    ids = [int(event["id"]) for event in events if event.get("id") is not None]
    return max(ids) if ids else 1


def _resolution_snapshot(predictions_dir: Path, now: datetime) -> Dict[str, Any]:
    """
    What the model is currently using, reduced to a comparable form.

    `resolve_claims` is pure stdlib, which is the only reason the 15-minute poller
    can do this at all — `pipeline/decide/milp.py` needs numpy at import and
    scipy's `milp` at run time, so the root-move half of the delta has to wait for
    the agent.

    An unreadable store yields an empty snapshot rather than raising: on the very
    first run there is no store, and a poller that refused to run without one
    would never create it.
    """
    try:
        claims = history(predictions_dir)
    except Exception as exc:  # noqa: BLE001
        logger.warning("evidence unreadable for the delta snapshot: %s", exc)
        return {}
    if not claims:
        return {}
    resolutions, _ = resolve_claims(claims, now=now)
    return deltas_store.snapshot(resolutions)


def _player_names(bootstrap: Mapping[str, Any]) -> Dict[int, Tuple[str, str]]:
    """element id -> (display name, club). For a delta a human has to read."""
    teams = {t["id"]: str(t.get("name") or "") for t in bootstrap.get("teams") or []}
    return {
        int(e["id"]): (str(e.get("web_name") or ""), teams.get(e.get("team"), ""))
        for e in bootstrap.get("elements") or []
    }


def _trigger_for(
    change: "deltas_store.ResolutionChange", predictions_dir: Path,
) -> Optional["deltas_store.Trigger"]:
    """
    The claim that won, as evidence the reader can check.

    Looked up by the resolution's own ``winning_claim_id`` rather than by guessing
    at the newest claim for that player: the whole point of R0-R8 is that the
    newest claim is not always the winner, and attributing a change to the wrong
    source would make the evidence surface actively misleading.
    """
    if not change.winning_claim_id:
        return None
    try:
        claims = history(predictions_dir)
    except Exception:  # noqa: BLE001
        return None
    for claim in claims:
        if claim.claim_id != change.winning_claim_id:
            continue
        return deltas_store.Trigger(
            source=claim.source,
            source_tier=claim.source_tier,
            claimed_at=claim.claimed_at,
            quote=(str(claim.source_text)[:300] if claim.source_text else None),
            url=claim.provenance_url,
        )
    return None


def _club_aliases(bootstrap: Mapping[str, Any]) -> Dict[str, List[str]]:
    """
    Club names to match in a video title, from the bootstrap FPL itself serves.

    Built from live data rather than a hardcoded list so a promoted side is
    matchable the day it appears. Both the full name and the short name are
    offered: titles say "Spurs" and "Tottenham" about equally, and FPL supplies
    both spellings.
    """
    aliases: Dict[str, List[str]] = {}
    for team in bootstrap.get("teams") or []:
        name = str(team.get("name") or "").strip()
        short = str(team.get("short_name") or "").strip()
        if not name:
            continue
        # Short names are three letters and would match inside unrelated words,
        # so they are only offered when they are not a substring risk.
        candidates = [name] + ([short] if len(short) > 3 else [])
        aliases[name] = candidates
    return aliases


def poll(
    predictions_dir: Path,
    now: Optional[datetime] = None,
    force: bool = False,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """
    One tick. Returns a report suitable for the run log.

    Deliberately returns rather than raising on a quiet tick: "nothing to do" is
    the overwhelmingly common outcome at a 15-minute cadence and must not look
    like a failure in CI.
    """
    from pipeline.config import (
        DELTA, FPL_BOOTSTRAP, FPL_FIXTURES, NEWS_FEEDS, NEWS_FETCH, NEWS_WINDOW,
        YOUTUBE, YOUTUBE_CHANNELS,
    )
    moment = now or datetime.now(timezone.utc)
    observed_at = moment.isoformat().replace("+00:00", "Z")

    # The cheap read that decides whether to do anything at all.
    bootstrap = _fetch_json(FPL_BOOTSTRAP)
    events = bootstrap.get("events") or []
    fixtures = _fetch_json(FPL_FIXTURES)

    open_now, why = in_news_window(fixtures, events, moment, NEWS_WINDOW)
    gameweek = current_gameweek(events, moment)

    if not open_now and not force:
        logger.info("outside the news window (%s); nothing to do", why)
        return {"status": "closed", "reason": why, "gameweek": gameweek,
                "observed_at": observed_at}

    logger.info("news window open (%s); polling %d feed(s)", why, len(NEWS_FEEDS))
    state = news_feeds.load_state(predictions_dir)

    # Resolve BEFORE fetching, so the comparison is against what the model was
    # actually using a moment ago. Resolving after would race the append and
    # report no change.
    before = _resolution_snapshot(predictions_dir, moment)

    outcomes = news_feeds.fetch_all(NEWS_FEEDS, state, NEWS_FETCH, moment)

    # Upload metadata, folded into the same entry list. It emits `FeedEntry`, so
    # the extractor and everything downstream neither know nor care that some
    # entries came from a video title rather than an article — one entry shape
    # means one set of extraction rules rather than two that drift apart.
    #
    # Additive and never fatal: with no API key configured, which is the state
    # today, `poll` reports why it did nothing and every other source is
    # unaffected.
    youtube_result = youtube.poll(
        YOUTUBE_CHANNELS, state, YOUTUBE, moment, os.environ.get("YOUTUBE_API_KEY"),
    )
    if youtube_result.skipped:
        logger.info("youtube: %s", youtube_result.skipped)
    else:
        logger.info(
            "youtube: %d new upload(s), %d unit(s) spent, %d record(s) pruned",
            len(youtube_result.entries), youtube_result.units_spent,
            youtube_result.pruned,
        )
        burst = youtube.club_burst(
            youtube_result.entries, _club_aliases(bootstrap),
            threshold=int(YOUTUBE.get("burst_threshold", 3)),
        )
        for club, channels in burst.items():
            # A window-opener, not a claim. Several channels posting about one
            # club inside a single poll is evidence that something happened,
            # even when no title says what.
            logger.info(
                "youtube burst: %d channels posted about %s in this poll",
                channels, club,
            )

    entries = [
        entry
        for outcome in (*outcomes, *youtube_result.outcomes)
        for entry in outcome.entries
    ]
    claims, coverage = news_extract.extract_all(
        entries, bootstrap, gameweek=gameweek, observed_at=observed_at,
    )

    suspicious = news_extract.coverage_is_suspicious(coverage)
    if suspicious:
        # Not a crash: the pipeline runs unattended and a broken matcher must be
        # loud without stopping the next tick from trying again.
        logger.error("news extraction looks broken: %s", suspicious)

    escalations = news_feeds.feeds_needing_escalation(outcomes)
    for outcome in escalations:
        logger.error(
            "feed %s has failed %d consecutive polls: %s",
            outcome.feed, outcome.consecutive_failures, outcome.reason,
        )

    written = None
    if not dry_run:
        written = record(claims, predictions_dir)
        news_feeds.save_state(state, predictions_dir)

    # Stage 1 of the delta. Only meaningful once the new claims are on file, so it
    # runs after the append — and is skipped entirely on a dry run, where nothing
    # was written and "what changed" has no answer.
    changes: List[deltas_store.ResolutionChange] = []
    suppressed: Dict[str, str] = {}
    if not dry_run:
        after = _resolution_snapshot(predictions_dir, moment)
        changes, suppressed = deltas_store.diff(before, after, DELTA)
        if changes:
            names = _player_names(bootstrap)
            records = [
                deltas_store.Delta(
                    change=change,
                    observed_at=observed_at,
                    gameweek=gameweek,
                    player_name=names.get(change.element_id, (None, None))[0],
                    club=names.get(change.element_id, (None, None))[1],
                    trigger=_trigger_for(change, predictions_dir),
                )
                for change in changes
            ]
            deltas_store.record(records, predictions_dir)
        # Republished on every tick that changed anything, so the app's copy never
        # lags the log by a gameweek. Cheap: the pruned view is a few KB.
        if changes:
            from pipeline.config import FPL_PUBLIC_DIR
            deltas_store.publish(
                predictions_dir, Path(FPL_PUBLIC_DIR),
                current_gameweek=gameweek,
                keep_gameweeks=int(DELTA.get("prune_to_gameweeks", 4)),
            )
        for key, reason in suppressed.items():
            # Logged rather than dropped silently: a threshold that swallows a real
            # change is indistinguishable from a broken poller.
            logger.info("delta suppressed (%s): %s", key, reason)

    report = {
        "status": "polled",
        "reason": why,
        "gameweek": gameweek,
        "observed_at": observed_at,
        "feeds": {o.feed: o.status for o in outcomes},
        "n_entries": len(entries),
        "coverage": coverage,
        "suspicious": suspicious,
        "escalated_feeds": [o.feed for o in escalations],
        "evidence_path": str(written) if written else None,
        "dry_run": dry_run,
        "deltas": [
            {"element_id": c.element_id, "claim_type": c.claim_type,
             "before": c.before, "after": c.after, "why": c.reason}
            for c in changes
        ],
        "deltas_suppressed": suppressed,
    }
    logger.info(
        "polled %d feed(s): %d entries -> %d claim(s)%s",
        len(outcomes), len(entries), len(claims),
        " (dry run)" if dry_run else "",
    )
    return report


def annotations_for(report: Mapping[str, Any]) -> List[str]:
    """
    GitHub Actions annotations for one run report.

    Pure and tested, rather than shell in the workflow. The two warnings are the
    ones that distinguish "quiet news" from "the news layer has silently stopped
    working while the app still shows a healthy agent" — which is the failure mode
    a 15-minute job is most likely to hide.
    """
    lines: List[str] = []
    status = report.get("status", "unknown")
    if status == "failed":
        # Not `::error::`: the poller returns 0 on upstream failure by design, and
        # an error annotation on a red-free run is confusing. The words are clear.
        lines.append(
            f"::warning::news poll failed: {str(report.get('error', ''))[:200]}"
        )
        return lines

    lines.append(f"::notice::news poll {status}: {report.get('reason', '')}")
    for feed in report.get("escalated_feeds") or []:
        lines.append(
            f"::warning::feed {feed} has failed several consecutive polls; "
            f"the news layer may have stopped working"
        )
    if report.get("suspicious"):
        lines.append(f"::warning::news extraction looks broken: {report['suspicious']}")
    return lines


def main(argv: Optional[Sequence[str]] = None) -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.learning.run_news",
        description="Poll the availability news feeds and record what they said.",
    )
    parser.add_argument("--predictions-dir", default=None)
    parser.add_argument("--force", action="store_true",
                        help="poll even outside the derived news window")
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and extract, but write nothing")
    parser.add_argument("--report", help="write the run report here as JSON")
    parser.add_argument(
        "--annotate", metavar="REPORT",
        help="print GitHub Actions annotations for an existing report and exit; "
             "does not poll",
    )
    args = parser.parse_args(argv)

    if args.annotate:
        path = Path(args.annotate)
        if not path.exists():
            # The poll step may not have got far enough to write one. Silence beats
            # a spurious warning about a report that was never produced.
            return 0
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            print(f"::warning::news report unreadable: {exc}")
            return 0
        for line in annotations_for(report):
            print(line)
        return 0

    from pipeline.config import PREDICTIONS_DIR
    predictions_dir = Path(args.predictions_dir or PREDICTIONS_DIR)

    try:
        report = poll(predictions_dir, force=args.force, dry_run=args.dry_run)
    except Exception as exc:  # noqa: BLE001
        # The feeds are optional sources that degrade gracefully by design: a
        # missing tier-2 claim leaves FPL's own field standing, which is exactly
        # today's behaviour. Failing the job would turn an upstream outage into a
        # red CI run every fifteen minutes.
        logger.error("news poll failed: %s", exc)
        if args.report:
            Path(args.report).write_text(
                json.dumps({"status": "failed", "error": str(exc)[:500]}, indent=2)
            )
        return 0

    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps({k: v for k, v in report.items() if k != "coverage"},
                     indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
