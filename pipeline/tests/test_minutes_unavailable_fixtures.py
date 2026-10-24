"""
A match missed injured must not be charged to the player's role as well as to his flag.

`MinutesModel.predict` returns ``p_start * availability``, which is right only if
``p_start`` is P(start | available). Fitted on raw rows it is P(start), so a
fixture missed through injury entered twice. Measured on Joao Pedro, 2026-10-06:
four 90-minute starts then 0 minutes at 75% in GW5 gave a fitted p_start of
0.569 with that row and 0.862 without it.

The correction is `unavailability_posterior`, gated by
``minutes.unavailable_fixture_retention``. It is OFF by default (1.0): on this
season's real deadline flags, removing the double count made calibration worse,
because FPL's graded flags resolve far below face value. So these tests pin two
things: that the mechanism does what it claims when switched on, and that the
default is an exact no-op.
"""
from __future__ import annotations

import gzip
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

from pipeline.config import PARAM_REGISTRY
from pipeline.models.fpl_inputs import (
    current_season_rows,
    deadline_availability,
    sealed_snapshots,
    with_deadline_availability,
)
from pipeline.models.minutes import (
    AVAILABILITY_AT_DEADLINE,
    MinutesModel,
    availability_state,
    unavailability_posterior,
)

RETENTION = "minutes.unavailable_fixture_retention"


def _switched_on():
    """Retention 0.0: the full posterior share of a flagged zero is removed."""
    return mock.patch.dict(PARAM_REGISTRY[RETENTION], {"value": 0.0})


def _rows(name, sequence, position="FWD"):
    """One row per fixture from (minutes, started, availability_at_deadline)."""
    return [
        {
            "name_key": name, "position_norm": position, "GW": gameweek,
            "minutes": minutes, "starts": int(started),
            AVAILABILITY_AT_DEADLINE: available,
        }
        for gameweek, (minutes, started, available) in enumerate(sequence, start=1)
    ]


# A small position pool so the FWD prior is neither 0 nor 1.
POOL = (
    [row for i in range(3) for row in _rows(f"regular {i}", [(90, True, 1.0)] * 5)]
    + [row for i in range(3) for row in _rows(f"filler {i}", [(0, False, 1.0)] * 5)]
)

# Four 90-minute starts, then a 0 at a 75% deadline: the Joao Pedro shape.
KNOCKED_STARTER = _rows("jp", [(90, True, 1.0)] * 4 + [(0, False, 0.75)])
# The same player had GW5 never happened: the healthy reference.
HEALTHY_STARTER = _rows("jp", [(90, True, 1.0)] * 4)


def _lost_place_then(available):
    """Started twice, then unused while fit twice, then a 0 at ``available``."""
    return _rows(
        "lost", [(90, True, 1.0)] * 2 + [(0, False, 1.0)] * 2 + [(0, False, available)]
    )


def _fit(rows):
    return MinutesModel().fit(
        pd.DataFrame(POOL + rows), key="name_key", position_column="position_norm"
    )


FLAGGED_75 = availability_state("d", 75)


class UnavailabilityPosteriorTests(unittest.TestCase):
    def test_a_fully_available_zero_is_all_selection(self):
        self.assertEqual(float(unavailability_posterior(1.0, 0.95)), 0.0)

    def test_a_hard_zero_is_all_unavailability_whatever_the_role(self):
        for role in (0.0, 0.3, 0.95, 1.0):
            with self.subTest(role=role):
                self.assertEqual(float(unavailability_posterior(0.0, role)), 1.0)

    def test_the_knock_explains_a_nailed_starters_zero_but_not_a_fringe_players(self):
        nailed = float(unavailability_posterior(0.75, 0.95))
        fringe = float(unavailability_posterior(0.75, 0.30))
        self.assertAlmostEqual(nailed, 0.25 / (0.25 + 0.75 * 0.05), places=9)
        self.assertGreater(nailed, 0.85)
        self.assertLess(fringe, 0.35)

    def test_vectorised_and_always_a_probability(self):
        out = unavailability_posterior(
            np.linspace(0, 1, 11), np.linspace(1, 0, 11)
        )
        self.assertEqual(out.shape, (11,))
        self.assertTrue(((out >= 0) & (out <= 1)).all())


class DefaultIsANoOpTests(unittest.TestCase):
    """Off by default, on measurement — and off must mean bit-identical."""

    def test_the_registry_default_keeps_every_row(self):
        self.assertEqual(PARAM_REGISTRY[RETENTION]["value"], 1.0)

    def test_with_the_default_a_flagged_fit_equals_an_unflagged_one(self):
        flagged = _fit(KNOCKED_STARTER + _lost_place_then(0.0))
        bare = MinutesModel().fit(
            pd.DataFrame(POOL + KNOCKED_STARTER + _lost_place_then(0.0)).drop(
                columns=[AVAILABILITY_AT_DEADLINE]
            ),
            key="name_key", position_column="position_norm",
        )
        # The PUBLISHED fit. A flagged player additionally carries a `fit_now`
        # fit (minutes.fit_now_absence_credit), used only when he is fit at the
        # prediction deadline; test_minutes_fit_now.py pins that path.
        published = {
            player: {k: v for k, v in stats.items() if k != "fit_now"}
            for player, stats in flagged.by_player.items()
        }
        self.assertEqual(published, bare.by_player)
        self.assertEqual(flagged.by_position, bare.by_position)
        self.assertEqual(flagged.availability_diagnostics["rows_discounted"], 0)

    def test_unknown_availability_is_never_discounted(self):
        rows = _rows("jp", [(90, True, 1.0)] * 4 + [(0, False, float("nan"))])
        with _switched_on():
            model = _fit(rows)
        self.assertEqual(model.availability_diagnostics["rows_discounted"], 0)
        self.assertEqual(model.by_player["jp"]["fixtures_discounted_as_unavailable"], 0.0)


class KnockedStarterTests(unittest.TestCase):
    """The JP shape: the knock must be carried by availability, once."""

    @classmethod
    def setUpClass(cls):
        cls.old = _fit(KNOCKED_STARTER)
        with _switched_on():
            cls.fixed = _fit(KNOCKED_STARTER)
        cls.healthy = _fit(HEALTHY_STARTER)

    def _p_start(self, model, horizon, state=FLAGGED_75):
        return model.predict(
            "FWD", "jp", availability_override=state, horizon=horizon
        ).p_start

    def test_this_week_is_near_a_healthy_starter_times_the_flag(self):
        reference = self._p_start(self.healthy, 0)  # healthy role x 0.75
        fixed = self._p_start(self.fixed, 0)
        self.assertGreater(fixed, 0.88 * reference)
        self.assertLessEqual(fixed, reference + 1e-9)
        # And the old fit charged it twice.
        self.assertLess(self._p_start(self.old, 0), 0.7 * reference)

    def test_the_horizon_returns_toward_the_healthy_path(self):
        fit_now = availability_state("a", None)
        healthy = [self._p_start(self.healthy, h, fit_now) for h in range(7)]
        fixed = [self._p_start(self.fixed, h) for h in range(7)]
        old = [self._p_start(self.old, h) for h in range(7)]
        for horizon in (3, 4, 5, 6):
            with self.subTest(horizon=horizon):
                self.assertGreater(fixed[horizon] / healthy[horizon], 0.88)
                # Without the correction the GW5 row never comes back.
                self.assertLess(old[horizon] / healthy[horizon], 0.8)

    def test_conditional_quantities_are_untouched(self):
        """Only the role split moves; minutes-if-started and P(60|start) cannot."""
        for field in ("sum_minutes_if_start", "n_started_rows", "n_60_starts"):
            with self.subTest(field=field):
                self.assertEqual(
                    self.old.by_player["jp"][field], self.fixed.by_player["jp"][field]
                )

    def test_the_discount_is_recorded(self):
        stats = self.fixed.by_player["jp"]
        self.assertGreater(stats["fixtures_discounted_as_unavailable"], 0.7)
        self.assertEqual(self.fixed.availability_diagnostics["rows_discounted"], 1)

    def test_a_flagged_player_who_played_keeps_his_row(self):
        played = _rows("jp", [(90, True, 1.0)] * 4 + [(25, False, 0.75)])
        old = _fit(played)
        with _switched_on():
            fixed = _fit(played)
        self.assertEqual(old.by_player["jp"], fixed.by_player["jp"])


class LostPlaceThenKnockTests(unittest.TestCase):
    """The opposite failure: a dropped player who then gets a knock stays dropped."""

    def _p_start(self, model):
        return model.predict("FWD", "lost", availability_override=FLAGGED_75).p_start

    def test_a_graded_knock_does_not_resurrect_him(self):
        rows = _lost_place_then(0.75)
        with _switched_on():
            fixed = self._p_start(_fit(rows))
        old = self._p_start(_fit(rows))
        self.assertLess(fixed, 0.3)
        self.assertLess(fixed - old, 0.05)
        # The posterior kept most of the zero as a benching.
        with _switched_on():
            removed = _fit(rows).by_player["lost"]["fixtures_discounted_as_unavailable"]
        self.assertLess(removed, 0.5)

    def test_a_hard_injury_removes_the_row_but_not_the_benchings_before_it(self):
        rows = _lost_place_then(0.0)
        with _switched_on():
            fixed = self._p_start(_fit(rows))
        # The same player had he kept his place: four starts, no knock.
        starter = self._p_start(_fit(_rows("lost", [(90, True, 1.0)] * 4)))
        self.assertLess(fixed, 0.35)
        self.assertLess(fixed, 0.5 * starter)


def _bootstrap(elements):
    return {"elements": elements, "events": [], "teams": [], "element_types": []}


def _element(element_id, status="a", chance=None, news_added=None):
    return {
        "id": element_id, "status": status,
        "chance_of_playing_next_round": chance, "news": "",
        "news_added": news_added,
    }


UTC = timezone.utc
DEADLINES = {
    4: datetime(2026, 9, 12, 12, 30, tzinfo=UTC),
    5: datetime(2026, 9, 18, 17, 30, tzinfo=UTC),
    6: datetime(2026, 10, 10, 10, 0, tzinfo=UTC),
}


class DeadlineAvailabilityTests(unittest.TestCase):
    def test_the_snapshot_inside_the_window_is_used(self):
        seal = (DEADLINES[5] - timedelta(hours=2), _bootstrap([_element(165, "d", 75)]))
        table = deadline_availability([seal], DEADLINES)
        row = table[(table.element == 165) & (table.GW == 5)]
        self.assertEqual(row["availability_at_deadline"].tolist(), [0.75])

    def test_the_latest_snapshot_in_the_window_wins(self):
        early = (DEADLINES[5] - timedelta(days=3), _bootstrap([_element(165, "d", 75)]))
        late = (DEADLINES[5] - timedelta(hours=1), _bootstrap([_element(165, "a")]))
        table = deadline_availability([late, early], DEADLINES)
        row = table[(table.element == 165) & (table.GW == 5)]
        self.assertEqual(row["availability_at_deadline"].tolist(), [1.0])

    def test_a_later_snapshot_never_stands_in_for_an_unsealed_week(self):
        """
        FPL does not restamp news_added when it changes a flag (Henderson went
        0% -> 50% -> available under one timestamp), so a later payload cannot say
        what held at an earlier deadline. An unsealed week is absent, not guessed.
        """
        after = (
            DEADLINES[5] + timedelta(days=2),
            _bootstrap([_element(165, "d", 75, news_added="2026-09-01T10:00:00Z")]),
        )
        table = deadline_availability([after], {5: DEADLINES[5]})
        self.assertTrue(table.empty)

    def test_a_previous_weeks_snapshot_never_stands_in(self):
        stale = (DEADLINES[4] - timedelta(hours=1), _bootstrap([_element(165, "d", 75)]))
        table = deadline_availability([stale], DEADLINES)
        self.assertEqual(sorted(table.GW.unique()), [4])


def _write_seal(root: Path, gameweek: int, sealed_at: datetime, bootstrap, dry_run=False):
    from pipeline.learning.ledger import RECORD_HEADER, freeze_inputs

    directory = root / "fpl" / "ledger" / f"gw{gameweek:02d}"
    directory.mkdir(parents=True)
    header = {
        "record": RECORD_HEADER, "gameweek": gameweek, "rows_written": 0,
        "sealed_at": sealed_at.isoformat(), "dry_run": dry_run,
        "frozen_inputs": freeze_inputs(bootstrap, directory / "inputs"),
    }
    (directory / "forecast.jsonl").write_text(json.dumps(header) + "\n")
    return directory


def _live_bootstrap():
    return {
        "teams": [{"id": 1, "name": "Chelsea", "short_name": "CHE"}],
        "element_types": [{"id": 4, "singular_name_short": "FWD"}],
        "elements": [{
            "id": 165, "first_name": "Joao", "second_name": "Pedro",
            "element_type": 4, "team": 1, "status": "d",
            "chance_of_playing_next_round": 75, "news": "", "news_added": None,
        }],
        "events": [
            {"id": gw, "deadline_time": stamp.isoformat()} for gw, stamp in DEADLINES.items()
        ],
    }


def _season_rows(bootstrap):
    def live(minutes, starts):
        return {"elements": [{
            "id": 165, "stats": {"minutes": minutes, "starts": starts},
            "explain": [{"fixture": 1, "stats": [{"identifier": "minutes", "value": minutes}]}],
        }]}
    return current_season_rows(bootstrap, {4: live(90, 1), 5: live(0, 0)}, season="2627")


class SealedJoinTests(unittest.TestCase):
    def test_current_season_rows_carry_the_element_id(self):
        rows = _season_rows(_live_bootstrap())
        self.assertEqual(rows["element"].tolist(), [165, 165])

    def test_rows_are_joined_to_the_flags_their_own_seal_held(self):
        bootstrap = _live_bootstrap()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_seal(root, 4, DEADLINES[4] - timedelta(hours=1),
                        _bootstrap([_element(165)]))
            _write_seal(root, 5, DEADLINES[5] - timedelta(hours=2),
                        _bootstrap([_element(165, "d", 75)]))
            rows = with_deadline_availability(_season_rows(bootstrap), bootstrap, root)
        by_gw = dict(zip(rows["GW"], rows["availability_at_deadline"]))
        self.assertEqual(by_gw, {4: 1.0, 5: 0.75})

    def test_a_dry_run_seal_is_not_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_seal(root, 5, DEADLINES[5] - timedelta(hours=2),
                        _bootstrap([_element(165, "d", 75)]), dry_run=True)
            self.assertEqual(sealed_snapshots(root), [])

    def test_a_tampered_frozen_input_is_refused_not_trusted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = _write_seal(root, 5, DEADLINES[5] - timedelta(hours=2),
                                    _bootstrap([_element(165, "d", 75)]))
            (directory / "inputs" / "bootstrap.json.gz").write_bytes(
                gzip.compress(json.dumps(_bootstrap([_element(165)])).encode())
            )
            with self.assertLogs("pipeline.models.fpl_inputs", level="WARNING"):
                self.assertEqual(sealed_snapshots(root), [])

    def test_a_broken_ledger_degrades_to_the_old_behaviour_rather_than_raising(self):
        """The refresh is also the seal's; a lost seal cannot be recovered."""
        bootstrap = _live_bootstrap()
        rows = _season_rows(bootstrap)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "fpl" / "ledger" / "gw05"
            directory.mkdir(parents=True)
            (directory / "forecast.jsonl").write_text("{not json\n")
            # Loud, not silent: the week's flags are lost and the log says so.
            with self.assertLogs("pipeline.models.fpl_inputs", level="WARNING"):
                out = with_deadline_availability(rows, bootstrap, root)
        self.assertEqual(len(out), len(rows))
        self.assertTrue(out["availability_at_deadline"].isna().all())

    def test_a_failure_inside_the_join_returns_the_rows_untouched(self):
        bootstrap = _live_bootstrap()
        rows = _season_rows(bootstrap)
        with mock.patch(
            "pipeline.models.fpl_inputs.deadline_availability",
            side_effect=RuntimeError("boom"),
        ), self.assertLogs("pipeline.models.fpl_inputs", level="WARNING"):
            out = with_deadline_availability(rows, bootstrap, Path("/nonexistent"))
        self.assertIs(out, rows)


if __name__ == "__main__":
    unittest.main()
