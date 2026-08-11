"""
Tests for per-fixture goal rates.

These exist because a flat rate makes every opponent identical, which is
obviously wrong for the horizon even though — see the commit that added this —
it was NOT the cause of the clean-sheet discrepancy it was first blamed for.
"""
import json
import math
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from pipeline.learning.backfill import load_archive_season
from pipeline.models.fixture_rates import (
    FixtureRates,
    TeamStrengths,
    export_fixture_xg,
    load_exported_rates,
    resolve_rates,
)


class TeamStrengthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.strengths = TeamStrengths().fit(load_archive_season("2526"))

    def test_strengths_are_centred_on_one(self):
        values = list(self.strengths.attack.values())
        self.assertAlmostEqual(sum(values) / len(values), 1.0, delta=0.15)

    def test_home_advantage_is_derived_not_assumed(self):
        self.assertGreater(self.strengths.home_share, 0.5)
        self.assertLess(self.strengths.home_share, 0.65)

    def test_a_strong_attack_outrates_a_weak_one_against_the_same_opponent(self):
        teams = sorted(self.strengths.attack, key=self.strengths.attack.get)
        weakest, strongest = teams[0], teams[-1]
        opponent = teams[len(teams) // 2]
        self.assertGreater(
            self.strengths.rates(strongest, opponent).lambda_home,
            self.strengths.rates(weakest, opponent).lambda_home,
        )

    def test_rates_stay_inside_a_plausible_band(self):
        for home in list(self.strengths.attack)[:6]:
            for away in list(self.strengths.attack)[:6]:
                if home == away:
                    continue
                rates = self.strengths.rates(home, away)
                self.assertGreater(rates.lambda_home, 0.2)
                self.assertLess(rates.lambda_home, 4.0)

    def test_an_unknown_club_falls_back_to_average_rather_than_zero(self):
        rates = self.strengths.rates("Nowhere United", "Also Nowhere")
        self.assertGreater(rates.lambda_home, 0.5)

    def test_fitting_without_the_required_columns_raises(self):
        with self.assertRaises(ValueError):
            TeamStrengths().fit(pd.DataFrame({"fixture": [1]}))


class ResolutionTests(unittest.TestCase):
    def test_exported_posterior_beats_the_fallback(self):
        exported = {
            "m1": FixtureRates("A", "B", 2.5, 0.8, "dixon_coles_posterior")
        }
        resolved = resolve_rates("m1", "A", "B", exported, TeamStrengths())
        self.assertEqual(resolved.source, "dixon_coles_posterior")
        self.assertEqual(resolved.lambda_home, 2.5)

    def test_provenance_is_carried_so_sources_cannot_be_mixed_silently(self):
        """A horizon mixing posterior and fallback rates could not be calibrated."""
        resolved = resolve_rates("missing", "A", "B", {}, None)
        self.assertEqual(resolved.source, "flat_default")

    def test_a_missing_export_is_not_an_error(self):
        from pathlib import Path

        self.assertEqual(load_exported_rates(Path("/nonexistent/x.json")), {})


if __name__ == "__main__":
    unittest.main()


class _FakeDC:
    """
    Stands in for the fitted PyMC model.

    Rates depend on the pair, so a test can tell "queried the posterior per
    fixture" apart from "returned a constant" — which is the entire point of
    the export and exactly the bug it replaces.
    """

    def __init__(self, known=("Arsenal", "Chelsea", "Everton")):
        self.trace = object()
        self.team_index = {name: i for i, name in enumerate(known)}

    def get_lambda_mu_samples(self, home, away, n_samples=10000):
        import numpy as np

        h = self.team_index.get(home, 0) + 1
        a = self.team_index.get(away, 0) + 1
        return np.full(8, 1.0 + 0.1 * h), np.full(8, 0.8 + 0.1 * a)


def _bootstrap_for_export():
    return {
        "events": [
            {"id": 1, "finished": True},
            {"id": 2, "finished": False},
            {"id": 3, "finished": False},
            {"id": 4, "finished": False},
        ],
        "teams": [
            {"id": 1, "name": "Arsenal"},
            {"id": 2, "name": "Chelsea"},
            {"id": 3, "name": "Everton"},
        ],
    }


def _fixtures_for_export():
    return [
        {"id": 10, "event": 1, "team_h": 1, "team_a": 2, "finished": True},
        {"id": 11, "event": 2, "team_h": 1, "team_a": 2, "finished": False},
        {"id": 12, "event": 3, "team_h": 2, "team_a": 3, "finished": False},
        {"id": 13, "event": 9, "team_h": 3, "team_a": 1, "finished": False},
    ]


class TestExportFixtureXg(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    # Sentinel, so a test can pass dc=None explicitly and still reach the code
    # path for "no model at all" rather than silently getting the default.
    _DEFAULT = object()

    def _export(self, horizon=2, dc=_DEFAULT, bootstrap=None):
        return export_fixture_xg(
            _FakeDC() if dc is self._DEFAULT else dc,
            bootstrap if bootstrap is not None else _bootstrap_for_export(),
            _fixtures_for_export(),
            self.dir,
            horizon=horizon,
        )

    def test_exports_only_unfinished_fixtures_inside_the_horizon(self):
        path = self._export(horizon=2)
        payload = json.loads(path.read_text())
        self.assertEqual({f["match_id"] for f in payload["fixtures"]}, {"11", "12"})
        self.assertEqual(payload["first_gameweek"], 2)

    def test_finished_fixtures_are_excluded(self):
        payload = json.loads(self._export(horizon=6).read_text())
        self.assertNotIn("10", {f["match_id"] for f in payload["fixtures"]})

    def test_rates_differ_per_fixture(self):
        """
        The bug being replaced was one constant for every fixture, so a constant
        export would be a silent no-op that still looked like a fix.
        """
        payload = json.loads(self._export(horizon=6).read_text())
        pairs = {(f["lambda_home"], f["mu_away"]) for f in payload["fixtures"]}
        self.assertGreater(len(pairs), 1, "every fixture got identical rates")

    def test_round_trips_through_the_loader(self):
        """Producer and consumer must agree on the format; they live together."""
        path = self._export(horizon=6)
        loaded = load_exported_rates(path)
        payload = json.loads(path.read_text())
        self.assertEqual(set(loaded), {f["match_id"] for f in payload["fixtures"]})
        for match_id, rates in loaded.items():
            self.assertEqual(rates.source, "dixon_coles_posterior")
            self.assertGreater(rates.lambda_home, 0)

    def test_resolve_prefers_the_export_over_the_fallback(self):
        loaded = load_exported_rates(self._export(horizon=6))
        resolved = resolve_rates("11", "Arsenal", "Chelsea", loaded, TeamStrengths())
        self.assertEqual(resolved.source, "dixon_coles_posterior")

    def test_prior_only_clubs_are_flagged(self):
        """
        A promoted club has no posterior strength. Its fixtures must be
        identifiable downstream rather than passing as evidence-backed.
        """
        dc = _FakeDC(known=("Arsenal",))
        payload = json.loads(self._export(horizon=6, dc=dc).read_text())
        self.assertTrue(any(f["prior_only"] for f in payload["fixtures"]))
        self.assertIn("Chelsea", payload["prior_only_clubs"])

    def test_unfitted_model_returns_none_rather_than_raising(self):
        """
        A missing export must degrade the FPL layer, not fail the daily run that
        produces the match predictions and the staking artifacts.
        """
        class Unfitted:
            trace = None

        self.assertIsNone(self._export(dc=Unfitted()))
        self.assertIsNone(self._export(dc=None))
        self.assertFalse((self.dir / "fixture_xg.json").exists())

    def test_no_unfinished_gameweeks_returns_none(self):
        bootstrap = _bootstrap_for_export()
        for event in bootstrap["events"]:
            event["finished"] = True
        self.assertIsNone(self._export(bootstrap=bootstrap))

    def test_export_writes_only_its_own_file(self):
        """
        The plan requires latest.json to be bit-identical across this change.
        The export is additive; this asserts it writes nothing else.
        """
        (self.dir / "latest.json").write_text('{"untouched": true}')
        before = (self.dir / "latest.json").read_bytes()
        self._export(horizon=6)
        self.assertEqual((self.dir / "latest.json").read_bytes(), before)
        self.assertEqual(
            sorted(p.name for p in self.dir.iterdir()),
            ["fixture_xg.json", "latest.json"],
        )


class MarketAnchorTests(unittest.TestCase):
    """
    The market anchor applied inside the export.

    Two properties matter beyond "the numbers moved".

    **No level discontinuity.** Bookmakers price one or two gameweeks ahead. If
    only the priced week were anchored, its rates would sit above the unpriced
    weeks for reasons unrelated to fixture difficulty, and the optimiser would
    read that as "this week is better" and churn transfers. So the league-wide
    LEVEL correction is applied to every week and only the fixture-specific
    residual is confined to weeks with a market.

    **The join is verified, not assumed.** Quotes are keyed by team pairing, which
    does not identify a fixture — the same two clubs meet again later. Kickoff
    proximity is required, because applying this week's prices to a fixture two
    months out would be completely silent.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    @staticmethod
    def _bootstrap():
        return {
            "events": [{"id": g, "finished": False} for g in range(1, 5)],
            "teams": [
                {"id": 1, "name": "Arsenal"},
                {"id": 2, "name": "Chelsea"},
                {"id": 3, "name": "Everton"},
            ],
        }

    @staticmethod
    def _fixtures():
        """Weekly fixtures, seven days apart, so only week 1 is near the market."""
        return [
            {"id": 100 + week, "event": week + 1, "team_h": 1, "team_a": 2,
             "kickoff_time": f"2026-08-{21 + 7 * week:02d}T14:00:00Z",
             "finished": False}
            for week in range(4)
        ]

    @staticmethod
    def _quote(lam, mu, commence, n_books=5, spread=0.02):
        from pipeline.models.devig import apply_margin
        from pipeline.models.dixon_coles import BayesianDixonColes
        from pipeline.models.market_rates import _outcome_probabilities, _p_over

        matrix = BayesianDixonColes.scoreline_matrix(lam, mu, 0.0)
        home, draw, away = _outcome_probabilities(matrix)
        h2h, totals = {}, {}
        for index in range(n_books):
            key = f"book{index}"
            tilt = spread * (index - (n_books - 1) / 2.0)
            h2h[key] = apply_margin(
                {"home": home + tilt, "draw": draw - tilt / 2, "away": away - tilt / 2},
                1.05,
            )
            totals[key] = {}
            for line in (2.5, 3.5):
                over = _p_over(matrix, line)
                totals[key][str(line)] = apply_margin(
                    {"over": over + tilt, "under": 1.0 - over - tilt}, 1.05
                )
        return {
            "home_team": "Arsenal", "away_team": "Chelsea",
            "commence_time": commence, "h2h_all": h2h, "totals_all": totals,
        }

    def _export(self, odds=None, weight=None):
        path = export_fixture_xg(
            _FakeDC(), self._bootstrap(), self._fixtures(), self.dir,
            horizon=4, parsed_odds=odds, blend_weight=weight,
            devig_method="proportional",
        )
        return json.loads(path.read_text())

    def _dc_rate(self):
        """What the fake posterior returns for Arsenal v Chelsea."""
        return self._export()["fixtures"][0]["lambda_home_dc"]

    def test_no_odds_leaves_the_posterior_untouched(self):
        payload = self._export()
        self.assertEqual(payload["source"], "dixon_coles_posterior")
        self.assertEqual(payload["market"]["n_anchored"], 0)
        for row in payload["fixtures"]:
            self.assertAlmostEqual(row["lambda_home"], row["lambda_home_dc"], places=9)
            self.assertEqual(row["rate_source"], "dixon_coles_posterior")

    def test_a_quoted_fixture_is_anchored_and_records_its_provenance(self):
        dc = self._dc_rate()
        odds = {"Arsenal_vs_Chelsea": self._quote(
            dc * 1.15, 0.9, "2026-08-21T14:00:00Z"
        )}
        payload = self._export(odds=odds)
        self.assertEqual(payload["source"], "dixon_coles_posterior+market_blend")
        self.assertEqual(payload["market"]["n_anchored"], 1)
        first = payload["fixtures"][0]
        self.assertEqual(first["rate_source"], "market_blend")
        self.assertGreater(first["lambda_home"], first["lambda_home_dc"])
        self.assertIsNotNone(first["market"])

    def test_the_unblended_posterior_is_retained_so_the_blend_is_reversible(self):
        dc = self._dc_rate()
        odds = {"Arsenal_vs_Chelsea": self._quote(dc * 1.15, 0.9, "2026-08-21T14:00:00Z")}
        for row in self._export(odds=odds)["fixtures"]:
            self.assertIn("lambda_home_dc", row)
            self.assertIn("mu_away_dc", row)
            self.assertIn("lambda_home_sd", row)

    def test_a_far_off_fixture_with_the_same_pairing_is_not_anchored(self):
        """
        The join guard. Every week here is Arsenal v Chelsea, so the pairing key
        matches all four — only the kickoff distinguishes them.
        """
        dc = self._dc_rate()
        odds = {"Arsenal_vs_Chelsea": self._quote(dc * 1.15, 0.9, "2026-08-21T14:00:00Z")}
        payload = self._export(odds=odds)
        self.assertEqual(payload["market"]["n_anchored"], 1)
        self.assertGreaterEqual(
            payload["market"]["statuses"].get("rejected_kickoff_mismatch", 0), 3
        )
        self.assertEqual(payload["fixtures"][-1]["rate_source"],
                         "dixon_coles_posterior+level")

    def test_a_quote_without_a_kickoff_is_refused_rather_than_assumed(self):
        dc = self._dc_rate()
        odds = {"Arsenal_vs_Chelsea": self._quote(dc * 1.15, 0.9, None)}
        self.assertEqual(self._export(odds=odds)["market"]["n_anchored"], 0)

    def test_every_week_receives_the_league_level_correction(self):
        """
        What makes the anchor reach a gameweek the bookmakers have not priced, and
        the reason no discontinuity appears.
        """
        dc = self._dc_rate()
        odds = {"Arsenal_vs_Chelsea": self._quote(dc * 1.20, 0.9, "2026-08-21T14:00:00Z")}
        payload = self._export(odds=odds)
        # The metadata records the RAW league correction; blend_log applies it at
        # `weight`. Pre-scaling it before the call was the double-count defect.
        raw_level = payload["market"]["level_correction"]["home"]
        weight = payload["market"]["blend_weight"]
        self.assertGreater(raw_level, 0.0)
        for row in payload["fixtures"][1:]:
            ratio = row["lambda_home"] / row["lambda_home_dc"]
            # places=5, not 9: exported rates are rounded to 6 decimals so the
            # artifact diffs readably.
            self.assertAlmostEqual(math.log(ratio), weight * raw_level, places=5)

    def test_an_anchored_fixture_at_the_league_level_matches_an_unanchored_one(self):
        """
        The double-count regression, as a direct assertion.

        A fixture whose market says EXACTLY the league level carries no
        fixture-specific information, so it must come out identical to a fixture
        with no market at all. It did not: `blend_log` subtracted a level that had
        already been scaled by the weight from a residual carrying the full league
        mean, leaving a spurious `w(1-w)*L`. At w=0.55 that was +2.5%, and it
        roughly doubled the very discontinuity the decomposition removes.

        It vanished at w=1 — which is the value the original discontinuity test
        used, so the suite passed for the wrong reason.
        """
        import math as _math

        from pipeline.models.market_rates import (
            STATUS_CONVERGED, MarketRates, blend_log,
        )

        dc_home, dc_away, raw_level = 1.5, 1.2, 0.10
        for weight in (0.0, 0.25, 0.5, 0.55, 0.9, 1.0):
            with self.subTest(weight=weight):
                market = MarketRates(
                    lambda_home=dc_home * _math.exp(raw_level),
                    mu_away=dc_away * _math.exp(raw_level),
                    status=STATUS_CONVERGED, weight=1.0,
                )
                level = (raw_level, raw_level)
                anchored, _, _ = blend_log(dc_home, dc_away, market, weight, level)
                plain, _, _ = blend_log(dc_home, dc_away, None, weight, level)
                self.assertAlmostEqual(anchored, plain, places=12)
                # And both equal the documented closed form, log dc + w*D.
                self.assertAlmostEqual(
                    anchored, dc_home * _math.exp(weight * raw_level), places=12
                )

    def test_zero_weight_reproduces_the_posterior_even_with_a_market(self):
        """
        Weight zero must be a TRUE no-op, including the league level correction.
        That correction is derived from the market, so a run that does not trust
        the market cannot inherit its view of the league scoring level either —
        otherwise the parameter does not mean what its name says and cannot be
        switched off to isolate the anchor's contribution.
        """
        dc = self._dc_rate()
        odds = {"Arsenal_vs_Chelsea": self._quote(dc * 1.20, 0.9, "2026-08-21T14:00:00Z")}
        payload = self._export(odds=odds, weight=0.0)
        # The metadata still reports the raw correction the market implied — that
        # is a measurement and worth keeping — but it is applied at weight zero.
        for row in payload["fixtures"]:
            self.assertAlmostEqual(row["lambda_home"], row["lambda_home_dc"], places=5)
            self.assertAlmostEqual(row["mu_away"], row["mu_away_dc"], places=5)

    def test_h2h_posted_without_a_totals_market_does_not_raise(self):
        """
        A regression I introduced with the aggregate guard. Bookmakers routinely
        post 1X2 before goal lines, which yields STATUS_ABSENT on every fixture —
        the guard counted that as an inversion failure and would have failed the
        export every day until totals appeared.
        """
        from pipeline.models.devig import apply_margin

        odds = {"Arsenal_vs_Chelsea": {
            "home_team": "Arsenal", "away_team": "Chelsea",
            "commence_time": "2026-08-21T14:00:00Z",
            "h2h_all": {
                f"book{i}": apply_margin(
                    {"home": 0.50, "draw": 0.27, "away": 0.23}, 1.05
                )
                for i in range(5)
            },
            "totals_all": {},
        }}
        # Every fixture must share the quote's kickoff, or only one reaches the
        # inverter and `inverted` never crosses the guard's threshold of 3 — which
        # is exactly why the first version of this test could not detect the bug.
        fixtures = [
            dict(f, kickoff_time="2026-08-21T14:00:00Z") for f in self._fixtures()
        ]
        payload = json.loads(export_fixture_xg(
            _FakeDC(), self._bootstrap(), fixtures, self.dir,
            horizon=4, parsed_odds=odds, devig_method="proportional",
        ).read_text())   # must not raise

        self.assertGreaterEqual(payload["market"]["statuses"].get("absent", 0), 3)
        self.assertEqual(payload["market"]["n_anchored"], 0)
        self.assertEqual(payload["source"], "dixon_coles_posterior")

    def test_a_kickoff_mismatch_alone_never_triggers_the_aggregate_guard(self):
        """
        A regression I introduced and this caught. "No market for this fixture" is
        the NORMAL state for a week the bookmakers have not reached, so counting
        kickoff mismatches as inversion failures fired the aggregate guard on a
        perfectly healthy run where only week 1 was priced.
        """
        dc = self._dc_rate()
        # A quote whose kickoff matches nothing at all.
        odds = {"Arsenal_vs_Chelsea": self._quote(
            dc * 1.15, 0.9, "2026-12-01T14:00:00Z"
        )}
        payload = self._export(odds=odds)   # must not raise
        self.assertEqual(payload["market"]["n_anchored"], 0)
        self.assertEqual(payload["source"], "dixon_coles_posterior")

    def test_priced_fixtures_that_all_fail_to_invert_raise(self):
        """
        Per-fixture tolerance, aggregate intolerance. There is no legitimate state
        in which every PRICED fixture fails to invert — that is a join, parse or
        solver failure, and degrading it to "no market" would hide a real bug.
        """
        # Internally contradictory: a near-certain home win alongside a market
        # saying almost no goals will be scored.
        def broken(commence):
            from pipeline.models.devig import apply_margin

            return {
                "home_team": "Arsenal", "away_team": "Chelsea",
                "commence_time": commence,
                "h2h_all": {
                    f"book{i}": apply_margin(
                        {"home": 0.94, "draw": 0.04, "away": 0.02}, 1.05
                    )
                    for i in range(5)
                },
                "totals_all": {
                    f"book{i}": {
                        "0.5": apply_margin({"over": 0.05, "under": 0.95}, 1.05),
                        "4.5": apply_margin({"over": 0.92, "under": 0.08}, 1.05),
                    }
                    for i in range(5)
                },
            }

        # Every week's kickoff matches its own quote, so all four are priced.
        odds = {"Arsenal_vs_Chelsea": broken("2026-08-21T14:00:00Z")}
        fixtures = [
            dict(f, kickoff_time="2026-08-21T14:00:00Z") for f in self._fixtures()
        ]
        with self.assertRaises(RuntimeError) as caught:
            export_fixture_xg(
                _FakeDC(), self._bootstrap(), fixtures, self.dir,
                horizon=4, parsed_odds=odds, devig_method="proportional",
            )
        self.assertIn("usable market anchor", str(caught.exception))

    def test_the_artifact_declares_the_weight_is_not_yet_fitted(self):
        """
        The out-of-sample fit CONFIRMED the prior rather than replacing it — it
        excluded w=0 but could not distinguish 0.55 from the argmin. A boolean
        cannot express that: `False` reads as "never measured" and `True` claims a
        fitted value we do not have. So the artifact carries a status string.
        """
        payload = self._export()
        self.assertEqual(
            payload["market"]["blend_weight_status"],
            "prior_confirmed_out_of_sample",
        )
        self.assertEqual(payload["statistical_component"], "dixon_coles_posterior")


class StaleExportTests(unittest.TestCase):
    """
    A failed export leaves the PREVIOUS day's file on disk, and FPL fixture ids are
    stable within a season, so its rows still match and would be served silently.
    Without a freshness check, "the export broke three weeks ago" and "the export
    ran this morning" are indistinguishable to the agent.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.path = self.dir / "fixture_xg.json"
        self.path.write_text(json.dumps({
            "source": "dixon_coles_posterior",
            "first_gameweek": 3,
            "fixtures": [
                {"match_id": "11", "gameweek": 3, "home_team": "Arsenal",
                 "away_team": "Chelsea", "lambda_home": 1.7, "mu_away": 1.1,
                 "rate_source": "market_blend"},
                {"match_id": "12", "gameweek": 4, "home_team": "Everton",
                 "away_team": "Leeds", "lambda_home": 1.3, "mu_away": 1.4,
                 "rate_source": "dixon_coles_posterior+level"},
            ],
        }))

    def test_a_covered_gameweek_loads(self):
        rates = load_exported_rates(self.path, current_gameweek=3)
        self.assertEqual(sorted(rates), ["11", "12"])

    def test_a_gameweek_the_export_does_not_cover_is_refused(self):
        """Falls back to archive strengths rather than serving three-week-old rates."""
        self.assertEqual(load_exported_rates(self.path, current_gameweek=9), {})

    def test_omitting_the_gameweek_keeps_the_old_permissive_behaviour(self):
        """Callers that cannot know the gameweek are not forced to guess one."""
        self.assertEqual(sorted(load_exported_rates(self.path)), ["11", "12"])

    def test_per_row_provenance_is_not_collapsed_to_the_payload_source(self):
        """
        Reading only the payload-level `source` would report every fixture as
        market-blended the moment ONE was — correct on disk, wrong in memory.
        """
        rates = load_exported_rates(self.path, current_gameweek=3)
        self.assertEqual(rates["11"].source, "market_blend")
        self.assertEqual(rates["12"].source, "dixon_coles_posterior+level")
