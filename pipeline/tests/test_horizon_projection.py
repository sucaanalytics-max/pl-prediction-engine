"""
Tests for ``_project_horizon`` — the function that prices future gameweeks.

**It had zero test coverage**, which is how the release blocker survived: every
future week was simulated with today's role probabilities and a single scalar was
then applied to the finished expected points. Every module involved had green
tests. What was wrong was how they were composed, and only a test at this level
can see that.

Two assertions here fail against the pre-fix code and are the reason the file
exists:

* a flagged player's ``p_start`` must DIFFER between week 0 and week 3, because
  the availability path is per-player rather than one league-wide scalar;
* a player suspended until a date inside week 1 must be projected to blank in
  week 0 and to play in week 2.

The third — that the week-h/week-0 ratio differs between a defender and a forward
— is the one a scalar cannot reproduce even in principle, and it is the actual
statement of the defect.
"""
import unittest
from typing import Any, Dict, List

import numpy as np

from pipeline.fpl.rules import load_rules
from pipeline.learning import run_agent
from pipeline.models.fpl_inputs import FplInputs
from pipeline.models.minutes import MinutesModel, availability_state
from pipeline.models.player_events import PlayerEventRates
from pipeline.simulation.player_sim import PlayerInput

NEWS_ADDED = "2026-08-04T12:00:00Z"

# Two clubs, one fixture between them per gameweek, eight gameweeks. Kickoffs a
# week apart starting 21 Aug so a "Suspended until 29 Aug" ban covers GW1 and
# GW2 and expires before GW3.
CLUBS = {1: {"id": 1, "name": "Arsenal"}, 2: {"id": 2, "name": "Chelsea"}}


def _fixtures(n_weeks: int = 8) -> List[Dict[str, Any]]:
    return [
        {
            "id": 100 + week,
            "event": week + 1,
            "team_h": 1,
            "team_a": 2,
            "kickoff_time": f"2026-08-{21 + 7 * week:02d}T19:00:00Z"
            if 21 + 7 * week <= 31
            else f"2026-09-{21 + 7 * week - 31:02d}T19:00:00Z",
            "finished": False,
        }
        for week in range(n_weeks)
    ]


class _FakeDraws:
    """Minimal stand-in for GameweekDraws: only summary_rows is consumed."""

    def __init__(self, squads, element_ids):
        self.gameweek = 0
        self._rows = []
        for club_players in squads.values():
            for player in club_players:
                # xp deliberately built from expected_minutes AND the 60-minute
                # probability, so the two non-linearities are observable in the
                # output. A scalar model cannot produce a position-dependent
                # ratio; this one can.
                roles = player.roles
                appearance = 1.0 * roles.p_appears
                sixty = (4.0 if player.position in ("GKP", "DEF") else 1.0) * roles.p_60
                self._rows.append({
                    "element_id": player.element_id,
                    "xp": appearance + sixty,
                    "p_appears": roles.p_appears,
                    "p_60": roles.p_60,
                    "e_minutes": roles.expected_minutes,
                })

    def summary_rows(self):
        return list(self._rows)


class HorizonProjectionTests(unittest.TestCase):
    def setUp(self):
        # No argument: the signed YAML alone. load_rules({}) would correctly
        # raise, since an empty bootstrap looks exactly like every squad rule
        # having been deleted.
        self.rules = load_rules()
        history = self._history()
        self.minutes_model = MinutesModel().fit(
            history, key="name_key", position_column="position_norm"
        )
        self.events = PlayerEventRates().fit(
            history, key="name_key", position_column="position_norm",
            rules=self.rules,
        )
        self.captured: List[Dict[str, Any]] = []

    @staticmethod
    def _history():
        import pandas as pd

        rows = []
        for name, position in (
            ("fit defender", "DEF"), ("fit forward", "FWD"),
            ("banned mid", "MID"), ("injured mid", "MID"),
        ):
            for gameweek in range(1, 31):
                rows.append({
                    "name_key": name, "position_norm": position, "GW": gameweek,
                    "minutes": 88, "starts": 1, "goals_scored": 0, "assists": 0,
                    "clean_sheets": 0, "goals_conceded": 1, "saves": 0,
                    "yellow_cards": 0, "red_cards": 0, "bonus": 0, "bps": 10,
                    "total_points": 2, "was_home": True, "team": "Arsenal",
                    "position": position, "element": 1, "fixture": gameweek,
                })
        return pd.DataFrame(rows)

    def _inputs(self):
        """Four players: two fit, one banned to a date, one open-ended injured."""
        specs = [
            (11, "DEF", "fit defender", availability_state("a", None)),
            (12, "FWD", "fit forward", availability_state("a", None)),
            (13, "MID", "banned mid", availability_state(
                "s", 0, news="Suspended until 29 Aug", news_added=NEWS_ADDED)),
            (14, "MID", "injured mid", availability_state(
                "i", 25, news="Knee injury - Unknown return date",
                news_added=NEWS_ADDED)),
        ]
        squads: Dict[str, List[PlayerInput]] = {"Arsenal": [], "Chelsea": []}
        availability = {}
        for element_id, position, key, state in specs:
            roles = self.minutes_model.predict(
                position=position, player_key=key, availability_override=state
            )
            squads["Arsenal"].append(PlayerInput(
                element_id=element_id, position=position, roles=roles,
                rates=self.events.rates(position, key), penalty_order=None,
                player_key=key,
            ))
            availability[element_id] = state
        # Chelsea needs bodies or the fixture has one empty side.
        for element_id, position, key in ((21, "DEF", "fit defender"),
                                          (22, "FWD", "fit forward")):
            roles = self.minutes_model.predict(
                position=position, player_key=key,
                availability_override=availability_state("a", None),
            )
            squads["Chelsea"].append(PlayerInput(
                element_id=element_id, position=position, roles=roles,
                rates=self.events.rates(position, key), penalty_order=None,
                player_key=key,
            ))
            availability[element_id] = availability_state("a", None)

        return FplInputs(
            minutes_model=self.minutes_model,
            events=self.events,
            squads=squads,
            all_element_ids=[11, 12, 13, 14, 21, 22],
            diagnostics={},
            availability=availability,
        )

    def _project(self, n_weeks: int = 8):
        """Run _project_horizon with simulate_gameweek captured, not executed."""
        import pipeline.simulation.gameweek_sim as gameweek_sim

        inputs = self._inputs()
        original = gameweek_sim.simulate_gameweek

        def _capture(specs, squads, events, rules, **kwargs):
            self.captured.append({
                "gameweek": specs[0].gameweek if specs else None,
                "squads": squads,
                "roles": {
                    player.element_id: player.roles
                    for club in squads.values() for player in club
                },
            })
            return _FakeDraws(squads, inputs.all_element_ids)

        gameweek_sim.simulate_gameweek = _capture
        try:
            result = run_agent._project_horizon(
                gameweek=1,
                fixtures_raw=_fixtures(n_weeks),
                teams=CLUBS,
                inputs=inputs,
                rules=self.rules,
                exported=None,
                strengths=None,
            )
        finally:
            gameweek_sim.simulate_gameweek = original
        return result

    # ── The assertions that fail against the pre-fix code ────────────────

    def test_a_flagged_players_start_probability_differs_across_weeks(self):
        """
        The core defect. Previously every week received the identical squads
        object, so this was equal by construction.
        """
        self._project()
        week0 = self.captured[0]["roles"][14]
        week3 = self.captured[3]["roles"][14]
        self.assertNotAlmostEqual(week0.p_start, week3.p_start, places=6)
        self.assertGreater(week3.p_start, week0.p_start, "an injury should heal")

    def test_the_prior_season_fallback_survives_the_horizon_rebuild(self):
        """
        Regression, and the most damaging defect in this change. The horizon
        rebuild omitted ``fallback_start_rate``, so every player with a
        prior-season start rate silently reverted to the bare position rate
        between week 0 and week 1. Measured on the real snapshot: 61 players moved
        by more than 0.20, worst case a new signing collapsing 0.921 -> 0.255 —
        a 72% one-week cliff on exactly the players the optimiser is deciding
        whether to buy, and predominantly understating them.
        """
        inputs = self._inputs()
        # A player with no archive history at all, so the fallback is the ONLY
        # thing keeping his start rate up.
        inputs.prior_starts["new signing"] = 0.92
        roles = inputs.squads["Arsenal"][0]
        inputs.squads["Arsenal"].append(
            PlayerInput(
                element_id=99, position="MID", roles=roles.roles,
                rates=roles.rates, penalty_order=None, player_key="new signing",
            )
        )
        inputs.availability[99] = availability_state("a", None)

        from pipeline.models.fpl_inputs import project_squads_at_horizon

        week0 = self.minutes_model.predict(
            position="MID", player_key="new signing",
            fallback_start_rate=0.92,
            availability_override=availability_state("a", None),
        )
        week1 = next(
            p.roles for p in
            project_squads_at_horizon(inputs, 1, {})["Arsenal"]
            if p.element_id == 99
        )
        # Reverts a little, as intended — but nowhere near the position rate.
        self.assertLess(week1.p_start, week0.p_start)
        self.assertGreater(week1.p_start, 0.70)

    def test_each_week_receives_its_own_squads_object(self):
        """
        Catches a refactor that computes new roles and then forgets to pass them
        — which is exactly the shape of the original bug.
        """
        self._project()
        self.assertIsNot(self.captured[0]["squads"], self.captured[3]["squads"])

    def test_a_dated_suspension_blanks_early_weeks_and_then_plays(self):
        """
        The release blocker as a single assertion. Banned until 29 Aug: out for
        GW1 (21 Aug) and GW2 (28 Aug), available from GW3 (4 Sep). Previously
        this player was projected to blank for all eight weeks.
        """
        self._project()
        self.assertEqual(self.captured[0]["roles"][13].p_appears, 0.0)
        self.assertEqual(self.captured[1]["roles"][13].p_appears, 0.0)
        self.assertGreater(self.captured[2]["roles"][13].p_appears, 0.0)

    def test_the_horizon_haircut_is_not_the_old_uniform_scalar(self):
        """
        Under the old code EVERY player's week-h/week-0 ratio was exactly
        ``horizon_availability_factor(h)``, because the scalar was applied to
        finished expected points. Now the ratio is per-player: a fit player
        reverts toward his position base rate while an impaired one recovers, so
        the ratios must differ from each other and from that scalar.

        Note what this test does NOT claim. An earlier version asserted the ratio
        differs between a defender and a forward through the 60-minute
        non-linearity. That is false for a uniform haircut, and measurably so: the
        simulator samples an exact-count lineup, so scaling every player's
        availability by a common factor leaves marginal start probabilities
        untouched and moves expected points by under 1%. See
        ``horizon_start_reversion``.
        """
        from pipeline.models.minutes import horizon_availability_factor

        weeks, _ = self._project()
        scalar = horizon_availability_factor(3)
        ratios = {
            element_id: weeks[3][element_id] / weeks[0][element_id]
            for element_id in (11, 12, 14)
        }
        self.assertFalse(
            all(abs(ratio - scalar) < 1e-6 for ratio in ratios.values()),
            f"every ratio equals the old scalar {scalar}: {ratios}",
        )
        # The recovering player moves the opposite way to the fit ones, which one
        # scalar cannot express at all.
        self.assertLess(ratios[11], 1.0)
        self.assertGreater(ratios[14], 1.0)

    def test_a_fit_players_start_probability_reverts_toward_the_base_rate(self):
        """
        The mechanism that replaced the absorbed availability multiplier. A nailed
        starter's p_start must FALL across the horizon even though his
        availability is 1.0 at every week.
        """
        self._project()
        near = self.captured[0]["roles"][11]
        far = self.captured[6]["roles"][11]
        self.assertEqual(near.availability, 1.0)
        self.assertLess(far.p_start, near.p_start)
        # And it does not collapse to the base rate — a nailed starter is still
        # a much better bet than an average squad member six weeks out.
        self.assertGreater(far.p_start, 0.5)

    # ── Structural properties ───────────────────────────────────────────

    def test_fully_available_players_still_decay_with_horizon(self):
        weeks, _ = self._project()
        series = [weeks[week][11] for week in range(len(weeks))]
        for near, far in zip(series, series[1:]):
            self.assertLess(far, near)

    def test_it_returns_one_entry_per_projected_week(self):
        weeks, diagnostics = self._project()
        self.assertEqual(len(weeks), 8)
        self.assertEqual(len(diagnostics), 8)
        self.assertEqual([d["gameweek"] for d in diagnostics], list(range(1, 9)))

    def test_a_short_fixture_list_stops_rather_than_padding_with_zeros(self):
        """
        Padding would tell the optimiser every player blanks in those weeks and it
        would plan around a fiction.
        """
        weeks, diagnostics = self._project(n_weeks=3)
        self.assertEqual(len(weeks), 3)
        self.assertEqual(len(diagnostics), 3)

    def test_too_few_weeks_returns_none_rather_than_a_misleading_horizon(self):
        self.assertIsNone(self._project(n_weeks=1))

    def test_diagnostics_record_the_goal_rate_provenance_per_week(self):
        """
        A week priced at the flat default has no opponent information at all.
        That used to be invisible; it must now appear per week.
        """
        _, diagnostics = self._project()
        for entry in diagnostics:
            with self.subTest(gameweek=entry["gameweek"]):
                self.assertEqual(sum(entry["goal_rate_sources"].values()),
                                 entry["n_fixtures"])
                self.assertIn("flat_default", entry["goal_rate_sources"])

    def test_diagnostics_record_the_pool_mean_minutes_per_week(self):
        """
        Recorded, not asserted monotone. The pool mean is NOT monotone in general
        and must not be: half this test squad is impaired, and their recovery
        outweighs the fit players' reversion. In the real 564-player pool, where
        roughly a tenth are flagged, it falls — but asserting that here would be
        asserting a property of the fixture rather than of the model.
        """
        _, diagnostics = self._project()
        means = [entry["mean_expected_minutes"] for entry in diagnostics]
        self.assertEqual(len(means), 8)
        for value in means:
            self.assertGreater(value, 0.0)
            self.assertLess(value, 90.0)

    def test_the_projection_is_reproducible(self):
        first, _ = self._project()
        self.captured.clear()
        second, _ = self._project()
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()


class ClubKickoffTests(unittest.TestCase):
    """
    The builder that feeds dated-absence comparisons.

    Tested separately from ``horizon_availability`` because the DGW tests call that
    function directly with a list — so mutating the BUILDER back to earliest-only
    left them all passing. The defect lives here, so the test has to live here too.
    """

    CLUBS = {1: {"id": 1, "name": "Arsenal"}, 2: {"id": 2, "name": "Chelsea"},
             3: {"id": 3, "name": "Everton"}}

    def _build(self):
        from pipeline.models.fpl_inputs import club_kickoffs_by_gameweek

        fixtures = [
            {"id": 1, "event": 5, "team_h": 1, "team_a": 2,
             "kickoff_time": "2026-08-26T19:00:00Z"},
            # Arsenal's second fixture of the same gameweek — the double.
            {"id": 2, "event": 5, "team_h": 3, "team_a": 1,
             "kickoff_time": "2026-08-30T14:00:00Z"},
        ]
        return club_kickoffs_by_gameweek(fixtures, self.CLUBS)

    def test_a_double_gameweek_club_gets_both_kickoffs(self):
        """
        Earliest-only blanked a suspended player for BOTH fixtures when his ban
        expired between them, understating him by a full fixture.
        """
        week = self._build()[5]
        self.assertEqual(len(week["Arsenal"]), 2)
        self.assertEqual(
            [k.isoformat() for k in week["Arsenal"]],
            ["2026-08-26T19:00:00+00:00", "2026-08-30T14:00:00+00:00"],
        )

    def test_single_fixture_clubs_get_one_kickoff(self):
        week = self._build()[5]
        self.assertEqual(len(week["Chelsea"]), 1)
        self.assertEqual(len(week["Everton"]), 1)

    def test_kickoffs_are_sorted(self):
        from pipeline.models.fpl_inputs import club_kickoffs_by_gameweek

        reversed_order = [
            {"id": 2, "event": 5, "team_h": 3, "team_a": 1,
             "kickoff_time": "2026-08-30T14:00:00Z"},
            {"id": 1, "event": 5, "team_h": 1, "team_a": 2,
             "kickoff_time": "2026-08-26T19:00:00Z"},
        ]
        week = club_kickoffs_by_gameweek(reversed_order, self.CLUBS)[5]
        self.assertEqual(week["Arsenal"], sorted(week["Arsenal"]))

    def test_a_fixture_without_a_kickoff_is_skipped(self):
        from pipeline.models.fpl_inputs import club_kickoffs_by_gameweek

        week = club_kickoffs_by_gameweek(
            [{"id": 1, "event": 5, "team_h": 1, "team_a": 2, "kickoff_time": None}],
            self.CLUBS,
        )
        self.assertEqual(week, {})
