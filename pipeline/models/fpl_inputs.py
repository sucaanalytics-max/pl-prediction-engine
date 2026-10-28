"""
Assemble simulator inputs from the live bootstrap and the committed archive.

The bridge between "data the pipeline already has" and "what the player
simulator needs". Three sources, each authoritative for something different:

* **live bootstrap** — identity, position, price, availability and set-piece
  duty. Always current, and the only source for a player's status today.
* **committed archive** — per-fixture history, which is what the minutes and
  rate models are fitted on. Never a source of position or availability.
* **committed pre-season priors** — a fallback start rate for players with no
  per-fixture history, and the GW1 purchase-price baseline.

Positions always come from the bootstrap. FPL reclassifies players between
seasons, and a stale position changes both the scoring rules applied and the
defensive-contribution counted set.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import pandas as pd

from pipeline.config import CURRENT_SEASON
from pipeline.data.team_mapping import normalize_team_name
from pipeline.fpl.rules import POSITIONS, Rules, load_rules, normalise_position
from pipeline.models.minutes import AvailabilityState, MinutesModel, availability_state
from pipeline.models.player_events import PlayerEventRates
from pipeline.simulation.player_sim import PlayerInput

logger = logging.getLogger(__name__)

# A prior-season aggregate is spread over a full campaign.
PRIOR_SEASON_FIXTURES = 38


@dataclass
class FplInputs:
    """Fitted models plus per-club squads, ready to simulate."""

    minutes_model: MinutesModel
    events: PlayerEventRates
    squads: Dict[str, List[PlayerInput]]
    all_element_ids: List[int]
    diagnostics: Dict[str, Any]
    # Availability classified once per player, reused for every horizon week.
    # Held here rather than recomputed per week because the classification is a
    # property of today's news, not of the week being projected — and because
    # re-parsing news 564 times per week for eight weeks would be wasteful for a
    # result that cannot change.
    availability: Dict[int, AvailabilityState] = field(default_factory=dict)
    # Prior-season start rate per player key. Carried because a horizon rebuild
    # must use the SAME shrinkage target as week 0 — omitting it silently reverted
    # every player with a prior-season fallback to the bare position rate, which
    # measured as a one-week collapse from 0.921 to 0.255 for a new signing.
    prior_starts: Dict[str, float] = field(default_factory=dict)


def _news_age_days(news_added: Optional[str], now: pd.Timestamp) -> Optional[float]:
    if not news_added:
        return None
    try:
        stamp = pd.Timestamp(news_added)
        if stamp.tzinfo is None:
            stamp = stamp.tz_localize("UTC")
        return float((now - stamp).total_seconds() / 86400.0)
    except (ValueError, TypeError):
        return None


CURRENT_SEASON_COLUMNS = (
    "name_key", "position_norm", "minutes", "starts", "GW", "fixture", "season",
    # This season's FPL id. Never a cross-season key (the archive reuses ids);
    # carried only so a row can be joined to the flags FPL showed at that
    # gameweek's deadline, which are keyed by it.
    "element",
    # Sent off in THIS fixture (0/1). Read only to keep a red card out of the
    # injury-exit class (minutes.injury_exit_p60_strength): a ban produces the
    # same "flagged at the next deadline" signature as an injury.
    "red_cards",
)


def current_season_rows(
    bootstrap: Mapping[str, Any],
    live_by_gameweek: Mapping[int, Mapping[str, Any]],
    season: str = CURRENT_SEASON,
) -> pd.DataFrame:
    """
    This season's settled appearances, in the grain the minutes model fits on.

    One row per player per fixture, from FPL's own ``event/{gw}/live/`` payload —
    official data, not the community archive, which `backfill` rules out of any
    live decision path. ``explain`` lists one entry per fixture the player's club
    played, INCLUDING an unused substitute's (0 minutes). So:

    * an unused substitute is a row: he was available and not picked, which is
      exactly the evidence a start rate is made of;
    * a blank gameweek is NOT a row: no fixture is not a benching, and recording
      one would drag every blank-gameweek player's start rate down;
    * a double gameweek is two rows, matching the archive's per-fixture grain.
      FPL reports ``starts`` for the week, so the starts go to the fixtures he
      played longest in.

    Keyed exactly as `build_fpl_inputs` keys players, or the rows would be
    appended under names nothing ever looks up.
    """
    from pipeline.learning.backfill import _normalise_name

    element_types = {
        et["id"]: et["singular_name_short"]
        for et in bootstrap.get("element_types", [])
    }
    people: Dict[int, Tuple[str, str]] = {}
    for element in bootstrap.get("elements", []):
        position = normalise_position(element_types.get(element.get("element_type")))
        if position is None:
            continue
        people[int(element["id"])] = (
            _normalise_name(
                f"{element.get('first_name', '')} {element.get('second_name', '')}"
            ),
            position,
        )

    rows: List[Dict[str, Any]] = []
    for gameweek, payload in sorted(live_by_gameweek.items()):
        for element in (payload or {}).get("elements", []) or []:
            who = people.get(int(element.get("id", -1)))
            if who is None:
                continue
            fixtures = element.get("explain") or []
            if not fixtures:
                continue
            played = [
                (
                    fixture.get("fixture"),
                    _explain_stat(fixture, "minutes"),
                    # `explain` lists only stats that scored, so a red card is
                    # present exactly when he was sent off in this fixture.
                    _explain_stat(fixture, "red_cards"),
                )
                for fixture in fixtures
            ]
            starts = int((element.get("stats") or {}).get("starts") or 0)
            longest_first = sorted(range(len(played)), key=lambda i: -played[i][1])
            started = set(longest_first[:starts])
            for index, (fixture_id, minutes, red_cards) in enumerate(played):
                rows.append({
                    "name_key": who[0],
                    "position_norm": who[1],
                    "minutes": minutes,
                    "starts": 1 if index in started else 0,
                    "GW": int(gameweek),
                    "fixture": fixture_id,
                    "season": season,
                    "element": int(element["id"]),
                    "red_cards": red_cards,
                })
    return pd.DataFrame(rows, columns=list(CURRENT_SEASON_COLUMNS))


def _explain_stat(fixture: Mapping[str, Any], identifier: str) -> int:
    """One stat's value from an ``explain`` entry; 0 when it is not listed."""
    return int(next(
        (
            stat.get("value") or 0
            for stat in fixture.get("stats") or []
            if stat.get("identifier") == identifier
        ),
        0,
    ))


def _parse_utc(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def deadline_availability(
    snapshots: Sequence[Tuple[datetime, Mapping[str, Any]]],
    deadlines: Mapping[int, datetime],
) -> pd.DataFrame:
    """
    Each player's availability at each gameweek's deadline, from bootstrap snapshots.

    ``snapshots`` are ``(captured_at, bootstrap)`` pairs, normally the sealed
    bootstraps. ``deadlines`` maps gameweek to deadline. For each gameweek the
    snapshot used is the LATEST one captured inside that gameweek's own window —
    after the previous deadline and before this one — which for a sealed week is
    the seal, frozen one to four hours before the deadline (GW1/3/4/5 of 2026-27:
    3.9, 2.1, 1.1 and 1.8 hours). Returns one row per (``element``, ``GW``) with
    the availability production computes from that snapshot's flags and news —
    ``availability_state(...).now``, so an exit note zeroes it exactly as it would
    have in the projection made that week.

    A gameweek with no snapshot in its window is ABSENT from the result, and an
    absent row means "not known", which the minutes model treats exactly as it did
    before this existed. That is deliberate rather than a gap to fill:

    * **A later snapshot cannot stand in.** FPL does NOT restamp ``news_added``
      when it changes a flag — measured in our own evidence log, Henderson went
      0% -> 50% -> available under one unchanged timestamp — so nothing in a later
      payload says whether its flag held at an earlier deadline. A rule that
      assumed otherwise put Doku's GW5-seal 75% onto the GW4 deadline.
    * **An earlier one cannot either.** A flag a week old is a different week's.

    The residual error is the hours between seal and deadline. A flag cleared in
    that gap and followed by a benching would be read as unavailability, but the
    seal is what the forecast was made on, so it is also the honest record of what
    was known.
    """
    gameweeks = sorted(deadlines)
    records: List[Dict[str, Any]] = []
    for position, gameweek in enumerate(gameweeks):
        deadline = deadlines[gameweek]
        window_opened = deadlines[gameweeks[position - 1]] if position else None
        inside = [
            (stamp, snapshot) for stamp, snapshot in snapshots
            if stamp is not None and stamp < deadline
            and (window_opened is None or stamp >= window_opened)
        ]
        if not inside:
            continue
        _, snapshot = max(inside, key=lambda pair: pair[0])
        for element in snapshot.get("elements") or []:
            if not element.get("id"):
                continue
            news_added = _parse_utc(element.get("news_added"))
            age = (
                (deadline - news_added).total_seconds() / 86400.0
                if news_added is not None else None
            )
            state = availability_state(
                status=element.get("status"),
                chance_of_playing=element.get("chance_of_playing_next_round"),
                news_age_days=age,
                news=element.get("news"),
                news_added=element.get("news_added"),
            )
            records.append({
                "element": int(element["id"]),
                "GW": int(gameweek),
                "availability_at_deadline": float(state.now),
                "availability_source": "seal",
            })
    return pd.DataFrame(
        records,
        columns=["element", "GW", "availability_at_deadline", "availability_source"],
    )


def sealed_snapshots(predictions_dir: Path) -> List[Tuple[datetime, Dict[str, Any]]]:
    """
    Every real (not dry-run) sealed bootstrap, with the time it was sealed.

    Read through the ledger's own verifying reader, so a frozen input whose digest
    disagrees with its header is refused rather than trusted. A gameweek that
    cannot be read is skipped with a warning: it costs that week's flags, which
    then read as "not known" — the pre-existing behaviour.
    """
    from pipeline.learning.ledger import load_frozen_bootstrap, read_forecast

    root = Path(predictions_dir) / "fpl" / "ledger"
    snapshots: List[Tuple[datetime, Dict[str, Any]]] = []
    if not root.exists():
        return snapshots
    for directory in sorted(root.glob("gw[0-9][0-9]")):
        forecast = directory / "forecast.jsonl"
        if not forecast.exists():
            continue
        try:
            header = read_forecast(forecast)["header"]
            if header.get("dry_run"):
                continue
            sealed_at = _parse_utc(header.get("sealed_at"))
            if sealed_at is None:
                continue
            snapshots.append((sealed_at, load_frozen_bootstrap(directory, header)))
        except Exception as exc:  # noqa: BLE001 - one unreadable week costs one week
            logger.warning("deadline flags unavailable for %s: %s", directory.name, exc)
    return snapshots


def with_deadline_availability(
    rows: pd.DataFrame,
    bootstrap: Mapping[str, Any],
    predictions_dir: Path,
) -> pd.DataFrame:
    """
    This season's rows with ``availability_at_deadline`` attached, where known.

    The join that lets the minutes model tell a knock from a benching, and the
    substrate for measuring how FPL's flags actually resolve. Both live callers
    (`run_agent.refresh_expected_points`, `run_pipeline` step 10b) reach it through
    :func:`with_deadline_availability_if_used`, so they cannot disagree on a player
    who missed a match injured. The agent's refresh is also the seal's, so this is
    a seal input: it must stay non-fatal, and changes to it need seal-warden's
    review.

    Non-fatal by design, and the reason is asymmetric cost. Without the column
    the model counts every zero as a benching, which is what it has always done.
    Raising would cost the refresh, and on the seal path the forecast, which
    cannot be recovered.
    """
    if rows is None or rows.empty or "element" not in rows.columns:
        return rows
    try:
        deadlines = {
            int(event["id"]): _parse_utc(event.get("deadline_time"))
            for event in bootstrap.get("events", []) or []
            if event.get("id") is not None
        }
        settled = {int(g) for g in rows["GW"].unique()}
        deadlines = {
            gw: stamp for gw, stamp in deadlines.items()
            if stamp is not None and gw in settled
        }
        table = deadline_availability(sealed_snapshots(predictions_dir), deadlines)
        merged = rows.merge(
            table[["element", "GW", "availability_at_deadline"]],
            on=["element", "GW"], how="left",
        )
        if len(merged) != len(rows):
            raise ValueError(
                f"join changed the row count ({len(rows)} -> {len(merged)}); "
                "a duplicated (element, GW) would double-count a fixture"
            )
        merged.index = rows.index
    except Exception as exc:  # noqa: BLE001 - see the asymmetric-cost note above
        logger.warning(
            "deadline availability not attached (%s); every non-appearance this "
            "season will count as a benching", exc,
        )
        return rows

    logger.info(
        "deadline availability: %d of %d rows known, %d at a flagged deadline, "
        "sources %s",
        int(merged["availability_at_deadline"].notna().sum()), len(merged),
        int((merged["availability_at_deadline"] < 1.0).sum()),
        table["availability_source"].value_counts().to_dict() if len(table) else {},
    )
    return merged


def deadline_availability_in_use() -> bool:
    """
    Whether any registry parameter makes the minutes model read deadline flags.

    False means attaching ``availability_at_deadline`` could not change a single
    projection, so the live callers skip the ledger read entirely and their
    inputs stay exactly what they were before the join existed.
    """
    from pipeline.config import PARAM_REGISTRY

    return (
        float(PARAM_REGISTRY["minutes.fit_now_absence_credit"]["value"]) > 0.0
        or float(PARAM_REGISTRY["minutes.unavailable_fixture_retention"]["value"]) < 1.0
        or float(PARAM_REGISTRY["minutes.injury_exit_p60_strength"]["value"]) > 0.0
    )


def with_deadline_availability_if_used(
    rows: pd.DataFrame,
    bootstrap: Mapping[str, Any],
    predictions_dir: Path,
) -> pd.DataFrame:
    """
    :func:`with_deadline_availability` when a parameter consumes it, else ``rows``.

    The one entry point both live callers use — `run_agent.refresh_expected_points`
    (which is also the SEAL's input path) and `run_pipeline` step 10b — so the two
    producers of the same xp artifact cannot disagree on a returning player.
    Never raises: a broken ledger read degrades to "flags unknown", which is the
    pre-existing behaviour, because on the seal path a raise would cost a forecast
    that cannot be recovered.
    """
    try:
        if not deadline_availability_in_use():
            return rows
        return with_deadline_availability(rows, bootstrap, predictions_dir)
    except Exception as exc:  # noqa: BLE001 - see the docstring
        logger.warning("deadline availability skipped (%s)", exc)
        return rows


def load_current_season_rows(
    bootstrap: Mapping[str, Any], fetch: Optional[Any] = None
) -> pd.DataFrame:
    """
    Fetch and shape every settled gameweek of the current season.

    Settled means ``finished`` AND ``data_checked``: before that, minutes can still
    be corrected, and an unsettled week is not evidence yet.

    Costs no new requests in the agent job — `manager_history` already reads these
    endpoints every hourly tick, and `fetch_event_live` caches each per gameweek
    for a week because a settled gameweek cannot change. A failure with no cached
    copy raises: this is a model input, and a run that silently fell back to last
    season alone would reproduce precisely the defect this exists to fix.
    """
    if fetch is None:
        from pipeline.data.fpl_api import fetch_event_live as fetch
    settled = sorted(
        int(event["id"]) for event in bootstrap.get("events", []) or []
        if event.get("finished") and event.get("data_checked")
    )
    return current_season_rows(bootstrap, {gw: fetch(gw) for gw in settled})


def build_fpl_inputs(
    bootstrap: Dict[str, Any],
    archive: pd.DataFrame,
    priors: Optional[Dict[str, Any]] = None,
    rules: Optional[Rules] = None,
    key: str = "name_key",
    now: Optional[pd.Timestamp] = None,
    evidence: Optional[Mapping[int, Mapping[str, Any]]] = None,
    current_season: Optional[pd.DataFrame] = None,
) -> FplInputs:
    """
    Fit the player models and assemble one squad per club.

    ``archive`` must carry ``name_key`` and ``position_norm`` — see
    :func:`pipeline.learning.backfill.load_archive_season`.

    ``current_season`` is this season's settled rows from
    :func:`load_current_season_rows`. Every live caller must pass it. The minutes
    model's 1.5-fixture recency half-life was selected in harnesses that always
    had the season's own rows (`backtest`, `walk_forward`); fitted on last season
    alone it projects each player from his last three matches of LAST season.
    They feed the minutes model only: the scoring model is the calibrated one,
    and these rows carry no event columns to fit it on.

    Rows passed through :func:`with_deadline_availability` carry the flags in
    force at each settled deadline, which lets the minutes model stop charging a
    match missed injured to the role of a player who is fit again
    (``minutes.fit_now_absence_credit``). Both live callers pass them through
    :func:`with_deadline_availability_if_used`.
    """
    rules = rules or load_rules(bootstrap)
    now = now or pd.Timestamp.now(tz="UTC")

    frame = archive.copy()
    if "position_norm" not in frame.columns:
        frame["position_norm"] = frame["position"].map(normalise_position)
    frame = frame[frame["position_norm"].notna()]

    minutes_frame = frame
    season_seen: Dict[str, Any] = {"season": None, "gameweeks": [], "n_rows": 0}
    if current_season is not None and len(current_season):
        # Without a season label on the archive, `_fixture_index` cannot order the
        # two seasons: last season's GW38 would sort after this season's GW5 and
        # the recency weights would point backwards.
        if "season" not in frame.columns or frame["season"].isna().any():
            raise ValueError(
                "the archive must carry a season label to be combined with the "
                "current season's rows"
            )
        minutes_frame = pd.concat([frame, current_season], ignore_index=True, sort=False)
        season_seen = {
            "season": str(current_season["season"].iloc[0]),
            "gameweeks": sorted(int(g) for g in current_season["GW"].unique()),
            "n_rows": int(len(current_season)),
        }

    minutes_model = MinutesModel().fit(
        minutes_frame, key=key, position_column="position_norm"
    )
    events = PlayerEventRates().fit(
        frame, key=key, position_column="position_norm", rules=rules
    )

    from pipeline.learning.availability_conflicts import live_overrides
    from pipeline.learning.backfill import _normalise_name

    prior_starts: Dict[str, float] = {}
    if priors:
        for player in priors.get("players", []):
            name = _normalise_name(
                f"{player.get('first_name', '')} {player.get('second_name', '')}"
            )
            starts = player.get("starts") or 0
            if name and starts:
                prior_starts[name] = min(1.0, starts / PRIOR_SEASON_FIXTURES)

    teams = {team["id"]: team for team in bootstrap.get("teams", [])}
    element_types = {
        et["id"]: et["singular_name_short"]
        for et in bootstrap.get("element_types", [])
    }

    squads: Dict[str, List[PlayerInput]] = {}
    all_element_ids: List[int] = []
    availability: Dict[int, AvailabilityState] = {}
    persistence_counts: Dict[str, int] = {}
    no_history = 0
    gated = 0
    conflicted = 0

    for element in bootstrap.get("elements", []):
        position = normalise_position(element_types.get(element.get("element_type")))
        if position is None:
            continue

        raw_team = teams.get(element.get("team"), {}).get("name", "")
        team = normalize_team_name(raw_team) if raw_team else ""
        if not team:
            continue

        player_key = _normalise_name(
            f"{element.get('first_name', '')} {element.get('second_name', '')}"
        )
        has_history = player_key in minutes_model.by_player
        if not has_history:
            no_history += 1

        element_id_raw = int(element["id"])
        # Resolved evidence may LOWER the live bootstrap's values, never replace
        # them wholesale. Tier-1 claims are copies of an EARLIER bootstrap — the
        # store is resolved before this run's bootstrap is recorded — so letting
        # them win put a stale flag over a fresh one (Joao Pedro, live i/0,
        # projected from a stored d/75). Only a tier-2/3 claim applies, and only
        # where it is no more optimistic than the live field: see
        # `live_overrides`. So the worst case of a resolution bug is an
        # over-cautious projection, and a stored copy can never out-vote FPL.
        resolved = (evidence or {}).get(element_id_raw, {})
        status_value = element.get("status", "a")
        chance_value = element.get("chance_of_playing_next_round")
        applied = live_overrides(resolved, status_value, chance_value)
        if "status" in applied:
            status_value = applied["status"].value
        if "chance_of_playing" in applied:
            chance_value = applied["chance_of_playing"].value

        # Classified once. `news` is used only to decide HOW an absence ends;
        # the availability number itself comes from the fields above.
        state = availability_state(
            status=status_value,
            chance_of_playing=chance_value,
            news_age_days=_news_age_days(element.get("news_added"), now),
            news=element.get("news"),
            news_added=element.get("news_added"),
        )
        # Only the resolutions that actually set a field: an id here says "this
        # claim moved the number", which a tier-1 copy no longer does.
        if applied:
            state = replace(
                state,
                evidence_claim_ids=tuple(
                    r.winning_claim_id for r in applied.values()
                    if r.winning_claim_id
                ),
                # Recorded on the state so the artifact shows the projection was
                # made under an unresolved conflict, rather than that fact living
                # only in a log line nobody reads.
                conflict=any(r.unresolved for r in applied.values()),
            )
            if state.conflict:
                conflicted += 1
        roles = minutes_model.predict(
            position=position,
            player_key=player_key,
            fallback_start_rate=prior_starts.get(player_key),
            availability_override=state,
        )
        if roles.gate_reason:
            gated += 1

        element_id = element_id_raw
        all_element_ids.append(element_id)
        availability[element_id] = state
        squads.setdefault(team, []).append(
            PlayerInput(
                element_id=element_id,
                position=position,
                roles=roles,
                rates=events.rates(position, player_key),
                penalty_order=element.get("penalties_order"),
                player_key=player_key,
            )
        )
        persistence_counts[state.persistence] = (
            persistence_counts.get(state.persistence, 0) + 1
        )

    diagnostics = {
        "n_clubs": len(squads),
        "n_players": len(all_element_ids),
        "n_without_history": no_history,
        "n_availability_gated": gated,
        "n_with_prior_start_fallback": len(prior_starts),
        "archive_rows_fitted": int(len(frame)),
        # How the flagged players break down. A jump in `open_ended` at the
        # expense of the dated classes means the news parser has stopped
        # recognising FPL's wording, which is otherwise invisible.
        "availability_persistence": persistence_counts,
        "n_evidence_conflicts": conflicted,
        # Logged by both callers. An empty list mid-season means the minutes model
        # is back to projecting from last season's run-in.
        "current_season": season_seen,
        # How many of this season's non-appearances were read as unavailability
        # rather than selection. Zero rows WITH deadline availability mid-season
        # means the join to the sealed bootstraps has broken, and every knock is
        # being charged to the player's role a second time.
        "deadline_availability": dict(minutes_model.availability_diagnostics),
    }
    logger.info("FPL inputs assembled: %s", diagnostics)

    return FplInputs(
        minutes_model=minutes_model,
        events=events,
        squads=squads,
        all_element_ids=all_element_ids,
        diagnostics=diagnostics,
        availability=availability,
        prior_starts=prior_starts,
    )


def project_squads_at_horizon(
    inputs: FplInputs,
    horizon: int,
    club_kickoffs: Optional[Mapping[str, Sequence[datetime]]] = None,
) -> Dict[str, List[PlayerInput]]:
    """
    Squads with role probabilities re-derived for a gameweek ``horizon`` weeks out.

    This is the fix for the horizon defect. Previously every future week was
    simulated with TODAY's role probabilities and a scalar was applied to the
    finished expected points — so the availability haircut never crossed the
    60-minute clean-sheet gate or the 1-minute appearance gate inside the
    simulator. Re-deriving roles here puts the haircut on the input side, where
    those two non-linearities can act on it.

    ``club_kickoffs`` maps canonical club name to ALL of that club's kickoffs in
    the target gameweek, used only to decide whether a dated absence has expired.
    All of them rather than the earliest, so a double gameweek whose ban expires
    between the two fixtures is scaled by the fraction he is eligible for instead
    of blanking both. A club that is missing (blank gameweek, unpublished fixture)
    gets no kickoff and falls back to the conservative reverting path.

    ``horizon=0`` returns the existing squads unchanged, so the immediate
    gameweek is bit-identical to before this function existed.
    """
    if horizon <= 0:
        return inputs.squads

    kickoffs = club_kickoffs or {}
    projected: Dict[str, List[PlayerInput]] = {}
    for club, players in inputs.squads.items():
        kickoff = kickoffs.get(club)
        rebuilt: List[PlayerInput] = []
        for player in players:
            state = inputs.availability.get(player.element_id)
            if state is None:
                # No classification (a player absent from the bootstrap pass).
                # Carrying today's roles forward unchanged is the old behaviour,
                # which is the right fallback: it cannot be worse than it was.
                rebuilt.append(player)
                continue
            roles = inputs.minutes_model.predict(
                position=player.position,
                player_key=player.player_key,
                # Same shrinkage target as week 0. Dropping this was a 61-player
                # defect: a new signing with a prior-season start rate of 0.921
                # fell to 0.255 between week 0 and week 1 for no modelled reason,
                # on exactly the players the optimiser is deciding whether to buy.
                fallback_start_rate=inputs.prior_starts.get(player.player_key),
                availability_override=state,
                horizon=horizon,
                target_kickoff=kickoff,
            )
            rebuilt.append(replace(player, roles=roles))
        projected[club] = rebuilt
    return projected


def club_kickoffs_by_gameweek(
    fixtures: Sequence[Mapping[str, Any]], teams: Mapping[int, Mapping[str, Any]]
) -> Dict[int, Dict[str, List[datetime]]]:
    """
    EVERY kickoff per club per gameweek, for dated-absence comparisons.

    All of them, not the earliest. A double gameweek whose suspension expires
    between the two fixtures is the case that matters: with only the earliest
    kickoff the player blanked both, understating him by a full fixture, and with
    only the latest he would have played both. ``horizon_availability`` needs the
    whole set so it can scale by the fraction he is actually eligible for, which is
    exact in expectation for a mean projection.
    """
    result: Dict[int, Dict[str, List[datetime]]] = {}
    for fixture in fixtures:
        event = fixture.get("event")
        kickoff_raw = fixture.get("kickoff_time")
        if event is None or not kickoff_raw:
            continue
        try:
            kickoff = datetime.fromisoformat(str(kickoff_raw).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        week = result.setdefault(int(event), {})
        for side in ("team_h", "team_a"):
            raw = teams.get(fixture.get(side), {}).get("name", "")
            club = normalize_team_name(raw) if raw else ""
            if not club:
                continue
            week.setdefault(club, []).append(kickoff)
    for week in result.values():
        for kickoffs in week.values():
            kickoffs.sort()
    return result


def fixture_specs_from_predictions(
    predictions: Sequence[Dict[str, Any]], gameweek: int
) -> List[Any]:
    """
    Build fixture specs from the pipeline's own match predictions.

    ``expected_goals`` is the already-blended ensemble expectation, so this reuses
    the existing model rather than re-deriving goal rates — and it means the FPL
    layer hooks in without touching the Monte Carlo loop.
    """
    from pipeline.simulation.gameweek_sim import FixtureSpec

    specs = []
    for prediction in predictions:
        fixture = prediction.get("fixture", {})
        expected = prediction.get("expected_goals", {})
        home = normalize_team_name(fixture.get("home_team", ""))
        away = normalize_team_name(fixture.get("away_team", ""))
        if not home or not away:
            continue
        specs.append(
            FixtureSpec(
                match_id=str(prediction.get("match_id", f"{home}_{away}")),
                gameweek=int(fixture.get("gameweek") or gameweek),
                home_team=home,
                away_team=away,
                lambda_home=float(expected.get("home", 0.0) or 0.0),
                mu_away=float(expected.get("away", 0.0) or 0.0),
                kickoff=fixture.get("date"),
                rate_source="ensemble_unanchored",
            )
        )
    return specs


def fixture_specs_from_fixture_xg(fixture_xg, gameweeks=None):
    """
    Build fixture specs from the market-anchored rate artifact.

    Prefer this over :func:`fixture_specs_from_predictions`. That function reads
    ``latest.json``'s ensemble expectation, which is never anchored to the
    market and is one gameweek wide. ``fixture_xg.json`` carries the blended
    rate that seven blocking checks in ``pipeline/fpl/artifacts.py`` already
    validate, spans the full horizon, and states its own ``rate_source`` per
    fixture — so a projection built from it can say where its numbers came from.

    Rows whose rate is missing are DROPPED, not defaulted. A 0.0 goal rate
    makes every clean sheet a certainty and every goal impossible, and that
    error propagates silently into every player projection for the fixture.
    """
    from pipeline.simulation.gameweek_sim import FixtureSpec

    wanted = set(gameweeks) if gameweeks is not None else None
    specs = []
    for row in fixture_xg.get("fixtures") or []:
        gameweek = row.get("gameweek")
        if gameweek is None:
            continue
        try:
            gameweek = int(gameweek)
        except (TypeError, ValueError):
            logger.warning(
                "fixture_xg row has a non-numeric gameweek %r; dropping it",
                row.get("gameweek"),
            )
            continue
        if wanted is not None and gameweek not in wanted:
            continue

        home = normalize_team_name(row.get("home_team", ""))
        away = normalize_team_name(row.get("away_team", ""))
        if not home or not away:
            continue

        lambda_home = row.get("lambda_home")
        mu_away = row.get("mu_away")
        if lambda_home is None or mu_away is None:
            logger.warning(
                "fixture_xg row GW%s %s v %s has no usable rate; dropping it",
                gameweek, home, away,
            )
            continue

        try:
            lambda_home = float(lambda_home)
            mu_away = float(mu_away)
        except (TypeError, ValueError):
            logger.warning(
                "fixture_xg row GW%s %s v %s has a non-numeric rate "
                "(lambda_home=%r, mu_away=%r); dropping it",
                gameweek, home, away, lambda_home, mu_away,
            )
            continue

        specs.append(
            FixtureSpec(
                # `or`, not a dict default: a fixture_xg row whose
                # match_id key EXISTS with a null value satisfies the
                # default and yields the literal string "None", which
                # then looks like a real id to every downstream join.
                match_id=str(row.get("match_id") or f"{home}_{away}"),
                gameweek=gameweek,
                home_team=home,
                away_team=away,
                lambda_home=lambda_home,
                mu_away=mu_away,
                kickoff=row.get("kickoff"),
                # Never leave this null. A null source is indistinguishable from
                # "nobody wired provenance", which is the bug this replaces.
                rate_source=row.get("rate_source") or "unknown",
            )
        )
    return specs
