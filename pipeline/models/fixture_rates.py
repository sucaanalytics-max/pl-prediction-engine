"""
Per-fixture goal rates: how many goals each side is expected to score.

Why this exists, concretely. The first end-to-end scoring run measured clean
sheets at 0.066 predicted against 0.120 actual — under-predicted by nearly half —
and goals slightly over-predicted. Both errors point the same way and both trace
to the same cause: the agent was using a flat 1.55/1.20 for every fixture, so a
match against a promoted side and a match against the champions produced
identical clean-sheet probabilities.

Two sources, in order of preference:

1. **The Dixon-Coles posterior**, exported by the daily pipeline as
   ``predictions/fixture_xg.json``. The pipeline already fits it; it was simply
   never queried beyond the current matchweek. This is the right answer and is
   what the horizon will use.

2. **Archive-derived team strengths**, computed here. A fallback, not a rival:
   attack and defence multipliers from settled results, shrunk toward the league
   mean. Strictly better than a constant because it distinguishes opponents, and
   it works today without waiting for a pipeline run.

The fallback is deliberately simple and its provenance travels with the output,
so nothing downstream can mistake it for the posterior.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# Pseudo-matches of shrinkage toward the league mean. A club with three results
# should not be credited with an extreme attack rating.
STRENGTH_SHRINKAGE = 6.0

# Home advantage as a multiplicative split of the league's mean goals. Derived
# from the archive at fit time; this is only the fallback if that fails.
DEFAULT_HOME_SHARE = 0.55


@dataclass(frozen=True)
class FixtureRates:
    """Expected goals for one fixture, with its provenance attached."""

    home_team: str
    away_team: str
    lambda_home: float
    mu_away: float
    source: str

    def as_tuple(self) -> Tuple[float, float]:
        return self.lambda_home, self.mu_away


class TeamStrengths:
    """
    Attack and defence multipliers per club, from settled results.

    A deliberately transparent model: each club has an attack multiplier and a
    defence multiplier relative to the league mean, and a fixture's rate is
    ``league_mean x home_attack x away_defence``, split by home advantage. It is
    a fallback for when the Dixon-Coles posterior is unavailable, so being
    interpretable and hard to get wrong matters more than being the last word.
    """

    def __init__(self) -> None:
        self.attack: Dict[str, float] = {}
        self.defence: Dict[str, float] = {}
        self.league_mean_goals: float = 1.4
        self.home_share: float = DEFAULT_HOME_SHARE
        self.fitted = False

    def fit(self, archive: pd.DataFrame) -> "TeamStrengths":
        """
        Fit from per-player archive rows by aggregating to team-fixture level.

        The archive is player-level, so team goals are recovered from
        ``team_h_score`` / ``team_a_score`` on the fixture rows rather than by
        summing player goals — summing would miss own goals and double-count
        nothing, but the scoreline is the direct observation and is exact.
        """
        required = {"fixture", "team_canonical", "was_home", "team_h_score", "team_a_score"}
        missing = required - set(archive.columns)
        if missing:
            raise ValueError(f"archive lacks columns needed for strengths: {sorted(missing)}")

        rows = archive[list(required)].drop_duplicates(subset=["fixture", "team_canonical"])
        rows = rows.dropna(subset=["team_h_score", "team_a_score"])
        if rows.empty:
            raise ValueError("no settled fixtures in the archive")

        scored, conceded = [], []
        for row in rows.itertuples():
            home = bool(row.was_home)
            scored.append(
                {
                    "team": row.team_canonical,
                    "goals_for": float(row.team_h_score if home else row.team_a_score),
                    "goals_against": float(row.team_a_score if home else row.team_h_score),
                    "home": home,
                }
            )
        frame = pd.DataFrame(scored)

        self.league_mean_goals = float(frame["goals_for"].mean())
        home_goals = frame.loc[frame["home"], "goals_for"].mean()
        away_goals = frame.loc[~frame["home"], "goals_for"].mean()
        total = home_goals + away_goals
        self.home_share = (
            float(home_goals / total) if total > 0 else DEFAULT_HOME_SHARE
        )

        mean = max(self.league_mean_goals, 1e-6)
        for team, group in frame.groupby("team"):
            n = float(len(group))
            # Shrunk toward 1.0, which is "exactly average".
            self.attack[team] = float(
                (group["goals_for"].sum() + STRENGTH_SHRINKAGE * mean)
                / ((n + STRENGTH_SHRINKAGE) * mean)
            )
            self.defence[team] = float(
                (group["goals_against"].sum() + STRENGTH_SHRINKAGE * mean)
                / ((n + STRENGTH_SHRINKAGE) * mean)
            )

        self.fitted = True
        logger.info(
            "team strengths fitted on %d team-fixtures: league mean %.3f goals, "
            "home share %.3f, attack range %.2f-%.2f",
            len(frame),
            self.league_mean_goals,
            self.home_share,
            min(self.attack.values()),
            max(self.attack.values()),
        )
        return self

    def rates(self, home_team: str, away_team: str) -> FixtureRates:
        """Expected goals for a fixture. Unknown clubs fall back to average."""
        total = self.league_mean_goals * 2.0
        home_base = total * self.home_share
        away_base = total * (1.0 - self.home_share)

        lambda_home = home_base * self.attack.get(home_team, 1.0) * self.defence.get(
            away_team, 1.0
        )
        mu_away = away_base * self.attack.get(away_team, 1.0) * self.defence.get(
            home_team, 1.0
        )
        return FixtureRates(
            home_team=home_team,
            away_team=away_team,
            # Clipped to a plausible band. An unshrunk product of two extreme
            # multipliers can otherwise produce a rate no PL fixture has ever had.
            lambda_home=float(np.clip(lambda_home, 0.2, 4.0)),
            mu_away=float(np.clip(mu_away, 0.2, 4.0)),
            source="archive_team_strengths",
        )


def export_fixture_xg(
    dc_model: Any,
    bootstrap: Dict[str, Any],
    fixtures_raw: List[Dict[str, Any]],
    predictions_dir: Path,
    horizon: int = 6,
    n_samples: int = 2000,
    parsed_odds: Optional[Dict[str, Dict[str, Any]]] = None,
    blend_weight: Optional[float] = None,
    devig_method: Optional[str] = None,
) -> Optional[Path]:
    """
    Export per-fixture goal rates across the horizon, from the Dixon-Coles posterior.

    The posterior yields lambda/mu for ANY pair of clubs at any future date — it
    was simply never queried beyond the current matchweek, which is why the FPL
    layer had to fall back to a flat rate for every fixture. Querying it for the
    next ``horizon`` gameweeks is the whole change; nothing about how the model is
    fitted moves.

    Purely additive by design. This writes a NEW file and touches no existing
    artifact, so ``latest.json`` is unchanged — a property worth preserving,
    because it is what lets the horizon land without any risk to the staking path.

    Returns ``None`` rather than raising when the model is unavailable: the
    consumer already falls back to archive-derived strengths and records that
    provenance per fixture, so a missing export degrades the FPL layer visibly
    instead of failing the daily prediction run that funds everything else.

    **Market anchor.** When ``parsed_odds`` is supplied, fixtures with a posted
    market get their rates blended toward the no-vig market-implied rates, and a
    league-wide level correction derived from those fixtures is applied to EVERY
    week — including weeks the bookmakers have not priced. That is what keeps
    week 1 and week 2 on the same scale; anchoring only the priced week would make
    the optimiser read it as "this week is better" and churn transfers for a
    reason unrelated to fixture difficulty.

    Odds are consumed here, never fetched: the caller already paid for them on the
    value-bet path, and the FPL agent must never spend the 500-request monthly
    quota itself.
    """
    from pipeline.data.team_mapping import normalize_team_name
    from pipeline.fpl.artifacts import assert_valid_fixture_xg, write_json_atomically

    if dc_model is None or getattr(dc_model, "trace", None) is None:
        logger.warning("no fitted Dixon-Coles model; skipping fixture_xg export")
        return None

    events = [e for e in bootstrap.get("events", []) if not e.get("finished")]
    if not events:
        logger.info("no unfinished gameweeks; skipping fixture_xg export")
        return None
    first = min(int(e["id"]) for e in events)
    wanted = set(range(first, first + horizon))

    teams = {
        int(t["id"]): normalize_team_name(t.get("name", ""))
        for t in bootstrap.get("teams", [])
    }

    rows: List[Dict[str, Any]] = []
    unknown: set = set()
    for fixture in fixtures_raw:
        event = fixture.get("event")
        if event is None or int(event) not in wanted or fixture.get("finished"):
            continue
        home = teams.get(fixture.get("team_h"), "")
        away = teams.get(fixture.get("team_a"), "")
        if not home or not away:
            continue

        # Clubs the posterior has never seen fall back to its league-average
        # prior rather than being dropped. Recorded so a promoted side's fixtures
        # are identifiable downstream as prior-only rather than evidence-backed.
        for club in (home, away):
            if club not in getattr(dc_model, "team_index", {}):
                unknown.add(club)

        try:
            lam, mu = dc_model.get_lambda_mu_samples(home, away, n_samples)
        except Exception as exc:
            logger.warning("posterior query failed for %s v %s: %s", home, away, exc)
            continue

        rows.append(
            {
                "match_id": str(fixture.get("id", f"{home}_{away}")),
                "gameweek": int(event),
                "home_team": home,
                "away_team": away,
                # The posterior mean, before any market anchor. Kept under its own
                # keys so the blend is auditable and reversible from the artifact
                # alone.
                "lambda_home_dc": float(np.mean(lam)),
                "mu_away_dc": float(np.mean(mu)),
                "lambda_home_sd": float(np.std(lam)),
                "mu_away_sd": float(np.std(mu)),
                "kickoff": fixture.get("kickoff_time"),
                "prior_only": home in unknown or away in unknown,
            }
        )

    if not rows:
        logger.info("no horizon fixtures to export")
        return None

    market = _apply_market_anchor(
        rows, dc_model, parsed_odds, blend_weight, devig_method
    )

    payload = {
        "schema_version": 1,
        # When this was produced.
        #
        # Absent until now, which meant the frontend read `optString(file.generated_at)`
        # and got null on every load — so `producedAtOf` returned nothing, freshness
        # could not be computed, and **this artifact could never be reported as
        # stale**. It feeds every clean-sheet and goal probability the horizon
        # optimiser ranks on, so silently serving last week's rates is exactly the
        # failure worth detecting.
        #
        # `additionalProperties` is true in the schema and this field is not in
        # `required`, so adding it is backwards compatible with artifacts already on
        # disk.
        "generated_at": datetime.now(timezone.utc)
        .isoformat().replace("+00:00", "Z"),
        "source": (
            "dixon_coles_posterior+market_blend"
            if market["n_anchored"]
            else "dixon_coles_posterior"
        ),
        # Named so the artifact states which statistical component was blended.
        # The betting path uses the 60/30/10 ensemble instead; that divergence is
        # deliberate and this field is what makes it a claim rather than an
        # accident.
        "statistical_component": "dixon_coles_posterior",
        "horizon": int(horizon),
        "first_gameweek": first,
        "n_fixtures": len(rows),
        "prior_only_clubs": sorted(unknown),
        "market": market,
        "fixtures": rows,
    }
    assert_valid_fixture_xg(payload)
    path = write_json_atomically(payload, Path(predictions_dir) / "fixture_xg.json")
    logger.info(
        "exported %d fixture rates across GW%d-%d%s; market anchored %d/%d",
        len(rows), first, first + horizon - 1,
        f" ({len(unknown)} prior-only clubs)" if unknown else "",
        market["n_anchored"], len(rows),
    )
    return path


def _same_fixture(
    fixture_kickoff: Optional[str],
    quote_kickoff: Optional[str],
    tolerance_hours: float = 36.0,
) -> bool:
    """
    Whether a quote and a fixture are the same match, by kickoff proximity.

    Tolerant rather than exact because the two timestamps come from different
    providers and FPL moves kickoffs for television. 36 hours comfortably covers a
    Saturday-to-Sunday reschedule while excluding a rematch weeks away.

    Returns False when either timestamp is missing: an unverifiable join is
    refused rather than assumed, because the failure it prevents — this week's
    prices applied to a fixture two months out — is silent.
    """
    if not fixture_kickoff or not quote_kickoff:
        return False
    try:
        left = datetime.fromisoformat(str(fixture_kickoff).replace("Z", "+00:00"))
        right = datetime.fromisoformat(str(quote_kickoff).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    if left.tzinfo is None:
        left = left.replace(tzinfo=timezone.utc)
    if right.tzinfo is None:
        right = right.replace(tzinfo=timezone.utc)
    return abs((left - right).total_seconds()) <= tolerance_hours * 3600.0


def _apply_market_anchor(
    rows: List[Dict[str, Any]],
    dc_model: Any,
    parsed_odds: Optional[Dict[str, Dict[str, Any]]],
    blend_weight: Optional[float],
    devig_method: Optional[str],
) -> Dict[str, Any]:
    """
    Blend the market into ``rows`` in place, and return the metadata block.

    Every row ends up with ``lambda_home``/``mu_away`` and a ``rate_source``,
    whether or not it had a market. Rows keep their unblended ``*_dc`` values, so
    the blend can always be undone from the artifact.
    """
    from pipeline.config import PARAM_REGISTRY
    from pipeline.models.market_rates import (
        STATUS_ABSENT, MarketRates, blend_log, invert_fixture, level_correction,
    )

    weight = (
        float(blend_weight) if blend_weight is not None
        else float(PARAM_REGISTRY["market.blend_weight"]["value"])
    )
    prior_only_weight = float(PARAM_REGISTRY["market.prior_only_weight"]["value"])
    # Proportional, the simplest, because the out-of-sample fit gives no evidence
    # for anything else. Evaluated at w=1 — the only place the choice has power,
    # since at production w it is buried under the statistical component —
    # proportional scored BEST on the point estimate and neither alternative's
    # interval excluded zero (power -0.00251 [-0.00653, +0.00150], shin -0.00159
    # [-0.00445, +0.00127]). The default was shin on a literature prior; the
    # measurement does not support it, and a better point estimate is not evidence.
    method = devig_method or "proportional"
    rho = 0.0
    try:
        rho = float(dc_model.get_rho_mean())
    except Exception:  # noqa: BLE001 - rho 0 is independent Poisson, a safe default
        logger.warning("could not read posterior rho; inverting at rho=0")

    anchors: Dict[str, MarketRates] = {}
    statuses: Dict[str, int] = {}
    if parsed_odds:
        for row in rows:
            key = f"{row['home_team']}_vs_{row['away_team']}"
            quote = parsed_odds.get(key)
            if not quote:
                continue
            # The key is a team PAIRING, so it does not identify a fixture: the
            # same two clubs meet again later in the season. Bookmakers only quote
            # near-term fixtures, so within an eight-week horizon a collision is
            # implausible — but "implausible" is how silent wrong-data joins get
            # written, and applying this week's prices to a fixture two months out
            # would be invisible in the output. Require the kickoffs to agree.
            if not _same_fixture(row.get("kickoff"), quote.get("commence_time")):
                statuses["rejected_kickoff_mismatch"] = (
                    statuses.get("rejected_kickoff_mismatch", 0) + 1
                )
                continue
            try:
                result = invert_fixture(
                    quote.get("h2h_all") or {},
                    quote.get("totals_all") or {},
                    rho,
                    devig_method=method,
                    dc_supremacy=row["lambda_home_dc"] - row["mu_away_dc"],
                )
            except Exception as exc:  # noqa: BLE001 - one bad fixture is not fatal
                logger.warning("market inversion failed for %s: %s", key, exc)
                continue
            statuses[result.status] = statuses.get(result.status, 0) + 1
            if result.usable:
                anchors[row["match_id"]] = result

    # Odds present but nothing anchored is a bug, not a degradation: there is no
    # legitimate state in which every INVERTED fixture fails. Per-fixture
    # tolerance, aggregate intolerance.
    #
    # Two statuses mean "there was no market here", not "the inversion failed",
    # and both must be excluded or the guard fires on a healthy run:
    #
    #   rejected_kickoff_mismatch — the normal state for a week the bookmakers
    #       have not reached.
    #   absent — h2h posted but no two-sided goal-totals line. Measured: books
    #       quoting 1X2 without totals raised on every fixture, which would have
    #       failed the export daily.
    NOT_A_FAILURE = ("rejected_kickoff_mismatch", STATUS_ABSENT)
    inverted = sum(
        count for status, count in statuses.items() if status not in NOT_A_FAILURE
    )
    if inverted >= 3 and not anchors:
        raise RuntimeError(
            f"{inverted} fixtures were priced and NONE produced a usable market "
            f"anchor (statuses: {statuses}). That is a join, parse or solver "
            f"failure rather than an absent market."
        )

    # RAW, unscaled. `blend_log` applies the weight itself, which is what makes
    # the league mean enter exactly once — pre-scaling it here left a spurious
    # w(1-w)*level term on every anchored fixture. Weight 0 remains a true no-op
    # because blend_log scales the level by weight too.
    level = level_correction([
        (anchors[row["match_id"]], row["lambda_home_dc"], row["mu_away_dc"])
        for row in rows if row["match_id"] in anchors
    ])

    for row in rows:
        anchor = anchors.get(row["match_id"])
        row_weight = (
            max(weight, prior_only_weight) if row.get("prior_only") else weight
        )
        lam, mu, source = blend_log(
            row["lambda_home_dc"], row["mu_away_dc"], anchor, row_weight, level
        )
        row["lambda_home"] = round(lam, 6)
        row["mu_away"] = round(mu, 6)
        row["rate_source"] = source
        row["supremacy"] = round(lam - mu, 6)
        row["total_goals"] = round(lam + mu, 6)
        row["market"] = anchor.as_dict() if anchor is not None else None

    return {
        "devig_method": method,
        "blend_weight": weight,
        # Not a boolean, because the truth is not binary: the weight was tested
        # out of sample and the test CONFIRMED the prior rather than replacing it.
        # A `False` here would read as "never measured", and a `True` would claim a
        # fitted value we do not have. See market.blend_weight's provenance.
        "blend_weight_status": "prior_confirmed_out_of_sample",
        "rho": rho,
        "level_correction": {"home": level[0], "away": level[1]},
        "n_anchored": len(anchors),
        # Fixtures that actually reached the inverter, excluding those with no
        # market for this kickoff — which is the ordinary state for a week the
        # bookmakers have not priced, not a failure.
        "n_priced": inverted,
        "statuses": statuses,
        "median_bookmakers": (
            sorted(a.n_bookmakers for a in anchors.values())[len(anchors) // 2]
            if anchors else 0
        ),
    }


def load_exported_rates(
    path: Path, current_gameweek: Optional[int] = None
) -> Dict[str, FixtureRates]:
    """
    Load ``fixture_xg.json`` as written by the daily pipeline.

    Keyed by match id. Returns empty rather than raising when absent: the export
    is an optimisation, and the fallback is a correct if coarser answer.

    ``current_gameweek`` makes a STALE file fall back rather than be served. Any
    failure in the daily export — a solver raise, a timeout, a crash — leaves the
    previous day's file untouched on disk, and FPL fixture ids are stable within a
    season, so its rows still match and would be used silently. Without this
    check, "the export broke three weeks ago" and "the export ran this morning"
    are indistinguishable to the agent.
    """
    path = Path(path)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("could not read %s: %s", path, exc)
        return {}

    if current_gameweek is not None:
        covered = {
            int(row["gameweek"]) for row in payload.get("fixtures", [])
            if row.get("gameweek") is not None
        }
        if covered and int(current_gameweek) not in covered:
            logger.error(
                "%s covers gameweeks %s but the current gameweek is %s. The export "
                "is stale — the daily pipeline has not written it since. Falling "
                "back to archive-derived strengths rather than serving old rates.",
                path.name, sorted(covered), current_gameweek,
            )
            return {}

    rates: Dict[str, FixtureRates] = {}
    for row in payload.get("fixtures", []):
        match_id = str(row.get("match_id", ""))
        if not match_id:
            continue
        rates[match_id] = FixtureRates(
            home_team=row.get("home_team", ""),
            away_team=row.get("away_team", ""),
            lambda_home=float(row.get("lambda_home", 0.0)),
            mu_away=float(row.get("mu_away", 0.0)),
            # Per-row provenance first. Reading only the payload-level `source`
            # would report every fixture as market-blended the moment ONE was,
            # making the artifact correct on disk and wrong in memory. The
            # payload-level value remains the fallback for a pre-anchor file.
            source=str(
                row.get("rate_source")
                or payload.get("source", "dixon_coles_posterior")
            ),
        )
    by_source: Dict[str, int] = {}
    for value in rates.values():
        by_source[value.source] = by_source.get(value.source, 0) + 1
    logger.info(
        "loaded %d exported fixture rates from %s: %s",
        len(rates), path.name, by_source,
    )
    return rates


def resolve_rates(
    match_id: str,
    home_team: str,
    away_team: str,
    exported: Optional[Dict[str, FixtureRates]] = None,
    strengths: Optional[TeamStrengths] = None,
) -> FixtureRates:
    """
    Best available rates for a fixture, preferring the exported posterior.

    Provenance is carried on the result so the artifact records which source was
    used per fixture — a horizon that silently mixes posterior and fallback rates
    would be impossible to calibrate.
    """
    if exported:
        found = exported.get(match_id)
        if found and found.lambda_home > 0 and found.mu_away > 0:
            return found

    if strengths is not None and strengths.fitted:
        return strengths.rates(home_team, away_team)

    # Last resort. Recorded as such so it is never mistaken for a model output.
    return FixtureRates(
        home_team=home_team,
        away_team=away_team,
        lambda_home=1.45,
        mu_away=1.20,
        source="flat_default",
    )
