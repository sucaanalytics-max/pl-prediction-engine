"""
Team attack and defence, from a second xG model, with the sample size shown.

## What this is for

`/teams` and nothing else. It feeds no projection, no lambda and no stake — see
`docs/superpowers/specs/2026-09-04-verified-team-metrics-design.md`, decision 1.
`build_team_view` stamps `model_input: false` into the artifact and a test asserts
it, so the claim survives someone deleting this docstring.

That constraint is what makes the source choice acceptable: Understat is an
optional scraped source, and CLAUDE.md's rule is that optional sources may degrade
gracefully while a source the models depend on must fail loudly. Nothing here is
depended on, so an empty fetch yields an absent page section rather than a raised
pipeline.

## Why Understat rather than FBref

Not preference — measurement, 2026-09-04, on this machine:

* `fbrefdata` will not install. Every published version caps at Python
  `>=3.9,<3.13` and the venv is 3.14.4, so `goal_shot_creation` (SCA/GCA),
  `possession` (touches in box) and `defense` exist only under CI's Python 3.11.
* `soccerdata`'s FBref reader raises `AttributeError: 'FBref' object has no
  attribute '_driver'` at `_common.py:645`, before a request leaves the machine.

So both routes to FBref are unrunnable here and only fixtures could test them.
Understat's `read_team_match_stats` returns rows, carries **both clubs in one
row**, and is an independently-fitted xG model — which is the whole point of a
"where do we disagree" view. Building phase one on code that cannot execute
locally would repeat the mistake an X embed made the same afternoon: six green
tests over a component that rendered nothing, because the test environment could
not run the thing being tested.

## The shrinkage, and why it is not optional

A rank off two matches is a rank attached to noise. The figure that settled it:
across the six columns of a widely-read GW3 zonal-weakness thread, only **16% of
the 720 team pairs** were separable at 95% from two matches of data, and one
column separated 2%. Our own pipeline already concedes the same point by listing
newly promoted clubs in `fixture_xg.json`'s `prior_only_clubs`.

So every rate is pulled toward the league mean by `n / (n + k)`, and a club under
`min_matches` is published with `attack_rank: None` and
`below_match_threshold: true`. Both are needed: shrinkage still produces an
ordering, and an ordering is what a reader takes off a page no matter what
interval sits beside it.

`k` and the threshold live in `pipeline/config.py` under `TEAM_VIEW`, are marked
provisional there, and belong to `quant-modeller`.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional

logger = logging.getLogger(__name__)

SOURCE = "understat:read_team_match_stats"

#: Carried in both directions. `ppda` is deliberately absent: it measures the
#: pressing a club does, so an "against" figure would be the opponent's own
#: pressing mislabelled as something done to them.
DIRECTIONAL_METRICS = ("np_xg", "xg", "deep_completions", "goals")

#: One-directional, and lower is more pressing — which is why nothing here
#: ranks on it.
OWN_METRICS = ("ppda",)


def shrink(*, raw: float, n: float, league_mean: float, k: float) -> float:
    """
    A club's own rate pulled toward the league mean by its evidence.

    `n / (n + k)` on the club, the remainder on the league. `n = 0` returns the
    mean exactly rather than dividing by zero, which is the case that matters:
    a promoted club with no matches must read as "league average, unknown", not
    as a zero-xG attack.
    """
    if n <= 0:
        return league_mean
    if k <= 0:
        return raw
    weight = n / (n + k)
    return league_mean + (raw - league_mean) * weight


def _num(row: Mapping[str, Any], key: str) -> Optional[float]:
    """A numeric field, or None — never a substituted zero."""
    if key not in row:
        return None
    value = row[key]
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    # NaN survives float() and then poisons every sum it touches.
    return None if out != out else out


def _blank() -> Dict[str, Any]:
    slot: Dict[str, Any] = {"matches": 0}
    for metric in DIRECTIONAL_METRICS:
        slot[f"{metric}_for"] = 0.0
        slot[f"{metric}_against"] = 0.0
        slot[f"{metric}_observations"] = 0
    for metric in OWN_METRICS:
        slot[f"{metric}_total"] = 0.0
        slot[f"{metric}_observations"] = 0
    return slot


def aggregate_matches(rows: Iterable[Mapping[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    Per-club totals, with each row read from both clubs' points of view.

    The bug this shape exists to prevent: every row holds `home_np_xg` and
    `away_np_xg`, and taking the home field as "this club's attack" is correct
    for one side and exactly inverted for the other. League totals are identical
    either way, so a test that sums cannot see it. Hence the explicit
    (own prefix, opponent prefix) pair per club.
    """
    out: Dict[str, Dict[str, Any]] = {}

    for row in rows:
        home, away = row.get("home_team"), row.get("away_team")
        if not home or not away:
            logger.warning("team_view: row without both clubs; skipped")
            continue

        for team, own, other in ((home, "home", "away"), (away, "away", "home")):
            slot = out.setdefault(str(team), _blank())
            slot["matches"] += 1

            for metric in DIRECTIONAL_METRICS:
                mine = _num(row, f"{own}_{metric}")
                theirs = _num(row, f"{other}_{metric}")
                # Counted only when BOTH sides are present, so a for/against
                # pair is always drawn from the same set of matches and the
                # difference between them means something.
                if mine is None or theirs is None:
                    continue
                slot[f"{metric}_for"] += mine
                slot[f"{metric}_against"] += theirs
                slot[f"{metric}_observations"] += 1

            for metric in OWN_METRICS:
                mine = _num(row, f"{own}_{metric}")
                if mine is None:
                    continue
                slot[f"{metric}_total"] += mine
                slot[f"{metric}_observations"] += 1

    # Means last, so a metric observed in fewer matches than the club played is
    # divided by what was actually seen.
    for slot in out.values():
        for metric in OWN_METRICS:
            seen = slot[f"{metric}_observations"]
            slot[metric] = slot[f"{metric}_total"] / seen if seen else None

    return out


def _dense_ranks(pairs: List[tuple], reverse: bool) -> Dict[str, int]:
    """1-based ranks over (team, value), skipping clubs whose value is None."""
    ranked = [p for p in pairs if p[1] is not None]
    ranked.sort(key=lambda p: p[1], reverse=reverse)
    return {team: i + 1 for i, (team, _) in enumerate(ranked)}


def build_team_view(
    rows: Iterable[Mapping[str, Any]],
    *,
    k: float,
    min_matches: int,
) -> Dict[str, Any]:
    """
    The published artifact: per-club rates, shrunk, with ranks withheld below
    `min_matches`.

    Takes rows rather than fetching, so the aggregation is testable without a
    network call — which matters here more than usual, because the two FBref
    routes this replaced could not be executed locally at all.
    """
    rows = list(rows)
    agg = aggregate_matches(rows)

    league: Dict[str, Any] = {}
    for metric in DIRECTIONAL_METRICS:
        for side in ("for", "against"):
            observed = sum(s[f"{metric}_observations"] for s in agg.values())
            total = sum(s[f"{metric}_{side}"] for s in agg.values())
            league[f"{metric}_{side}_per_match"] = (
                total / observed if observed else None
            )

    teams: List[Dict[str, Any]] = []
    for name, slot in sorted(agg.items()):
        entry: Dict[str, Any] = {
            "team": name,
            "matches": slot["matches"],
            "below_match_threshold": slot["matches"] < min_matches,
        }
        for metric in DIRECTIONAL_METRICS:
            seen = slot[f"{metric}_observations"]
            for side in ("for", "against"):
                raw = slot[f"{metric}_{side}"] / seen if seen else None
                entry[f"{metric}_{side}_per_match"] = raw
                mean = league[f"{metric}_{side}_per_match"]
                entry[f"{metric}_{side}_shrunk"] = (
                    shrink(raw=raw, n=seen, league_mean=mean, k=k)
                    if raw is not None and mean is not None
                    else None
                )
            entry[f"{metric}_observations"] = seen
        for metric in OWN_METRICS:
            entry[metric] = slot.get(metric)
        teams.append(entry)

    eligible = [t for t in teams if not t["below_match_threshold"]]
    attack = _dense_ranks(
        [(t["team"], t["np_xg_for_shrunk"]) for t in eligible], reverse=True,
    )
    defence = _dense_ranks(
        [(t["team"], t["np_xg_against_shrunk"]) for t in eligible], reverse=False,
    )
    for t in teams:
        t["attack_rank"] = attack.get(t["team"])
        t["defence_rank"] = defence.get(t["team"])

    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": SOURCE,
        # Asserted by a test. This artifact must never become a model input
        # without the value-bet firewall in models/market_rates.py being
        # revisited first.
        "model_input": False,
        "shrinkage_k": k,
        "min_matches_for_rank": min_matches,
        "n_matches": len(rows),
        "n_teams": len(teams),
        "league": league,
        "teams": teams,
    }


def write(path: Optional[str] = None, *, force: bool = False) -> Optional[Dict[str, Any]]:
    """
    Fetch, build and write `predictions/team_metrics.json`.

    Returns None — and writes nothing — when the source gives nothing, rather
        than publishing an artifact of twenty nulls. A page that renders "not yet
        measurable" for every club is honest; one that renders zeros is not, and
        an absent artifact is what the frontend narrower is written to expect.
    """
    from pipeline.config import PREDICTIONS_DIR, TEAM_VIEW
    from pipeline.data.fbref import fetch_fbref_match_stats

    frame = fetch_fbref_match_stats(force=force)
    if frame is None or not len(frame):
        logger.warning(
            "team_view: Understat returned nothing; not writing team_metrics.json. "
            "This is an optional source, so the pipeline continues."
        )
        return None

    view = build_team_view(
        frame.to_dict("records"),
        k=TEAM_VIEW["shrinkage_k"],
        min_matches=TEAM_VIEW["min_matches_for_rank"],
    )

    import json
    from pathlib import Path

    target = Path(path) if path else Path(PREDICTIONS_DIR) / "team_metrics.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(view, indent=2, sort_keys=True) + "\n")

    ranked = sum(1 for t in view["teams"] if t["attack_rank"] is not None)
    logger.info(
        "team_view: wrote %s — %d teams, %d matches, %d ranked (%d below the "
        "%d-match threshold)",
        target, view["n_teams"], view["n_matches"], ranked,
        view["n_teams"] - ranked, view["min_matches_for_rank"],
    )
    return view


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=None, help="Target path for the artifact")
    ap.add_argument("--force", action="store_true", help="Bypass the fetch cache")
    args = ap.parse_args()
    raise SystemExit(0 if write(args.out, force=args.force) is not None else 1)
