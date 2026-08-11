"""
Contract tests for ``fixture_xg.json``.

This artifact is the only thing between the market anchor and the FPL projection
layer. Every clean-sheet and goal probability the horizon optimiser ranks on comes
from ``lambda_home``/``mu_away`` here, and the failures that matter do not change
the shape of the file at all: a wrong-sign blend weight, a swapped home and away,
a rate in the wrong units. Each of those produces a perfectly well-formed payload
that is confidently inverted, and the pipeline runs unattended, so nothing would
reveal it.

So every check below is paired with a deliberately corrupted payload that it must
reject. A validator whose failure path is untested is decoration: it would pass
the suite while accepting exactly the artifact it exists to refuse.
"""
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline.fpl.artifacts import (
    SCHEMA_DIR,
    ArtifactContractError,
    assert_valid_fixture_xg,
    validate_fixture_xg,
)
from pipeline.models.fixture_rates import export_fixture_xg

SAMPLE = SCHEMA_DIR / "fixture_xg.sample.json"
SCHEMA = SCHEMA_DIR / "fixture_xg.schema.json"


class _FakeDC:
    """
    Stands in for the fitted PyMC model.

    Copied from ``test_fixture_rates`` rather than imported: a contract test that
    depended on another test module would start failing for reasons that have
    nothing to do with the contract.
    """

    def __init__(self, known=("Arsenal", "Chelsea", "Everton")):
        self.trace = object()
        self.team_index = {name: i for i, name in enumerate(known)}

    def get_lambda_mu_samples(self, home, away, n_samples=10000):
        import numpy as np

        h = self.team_index.get(home, 0) + 1
        a = self.team_index.get(away, 0) + 1
        return np.full(8, 1.0 + 0.1 * h), np.full(8, 0.8 + 0.1 * a)


def _bootstrap():
    return {
        "events": [{"id": g, "finished": False} for g in range(1, 5)],
        "teams": [
            {"id": 1, "name": "Arsenal"},
            {"id": 2, "name": "Chelsea"},
            {"id": 3, "name": "Everton"},
        ],
    }


def _fixtures():
    """Weekly fixtures a week apart, so only the first is near the market."""
    return [
        {"id": 100 + week, "event": week + 1, "team_h": 1, "team_a": 2,
         "kickoff_time": f"2026-08-{21 + 7 * week:02d}T14:00:00Z",
         "finished": False}
        for week in range(4)
    ]


def _quote(lam, mu, commence, n_books=5, spread=0.02):
    """A market whose true rates are ``lam``/``mu``, re-margined per book."""
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
        totals[key] = {
            str(line): apply_margin(
                {"over": _p_over(matrix, line) + tilt,
                 "under": 1.0 - _p_over(matrix, line) - tilt},
                1.05,
            )
            for line in (2.5, 3.5)
        }
    return {
        "home_team": "Arsenal", "away_team": "Chelsea",
        "commence_time": commence, "h2h_all": h2h, "totals_all": totals,
    }


def _export(odds=None, weight=None, horizon=4):
    """Run the real export in a temporary directory and return its payload."""
    with tempfile.TemporaryDirectory() as tmp:
        path = export_fixture_xg(
            _FakeDC(), _bootstrap(), _fixtures(), Path(tmp), horizon=horizon,
            parsed_odds=odds, blend_weight=weight, devig_method="proportional",
        )
        return json.loads(path.read_text())


def _anchored(weight=None):
    """An export where gameweek 1 has a posted market 15% above the posterior."""
    dc = _export()["fixtures"][0]["lambda_home_dc"]
    return _export(
        odds={"Arsenal_vs_Chelsea": _quote(dc * 1.15, 0.9, "2026-08-21T14:00:00Z")},
        weight=weight,
    )


PLAIN = _export()
ANCHORED = _anchored()


def _broken(payload, mutate):
    """Deep-copy a payload through JSON, mutate it, and hand it back."""
    copy = json.loads(json.dumps(payload))
    mutate(copy)
    return copy


def _messages(payload, needle):
    problems = validate_fixture_xg(payload)
    return [problem for problem in problems if needle in problem]


class RealExportTests(unittest.TestCase):
    """Whatever else these checks reject, they must accept a real run."""

    def test_the_unanchored_export_passes(self):
        self.assertEqual(validate_fixture_xg(PLAIN), [])

    def test_the_market_anchored_export_passes(self):
        self.assertEqual(validate_fixture_xg(ANCHORED), [])

    def test_a_zero_weight_export_passes_with_markets_attached(self):
        """
        Weight zero is a deliberate true no-op, used to isolate the anchor's
        contribution. It leaves a converged market attached to a row the blend
        correctly did not touch, so the ``market_blend`` converse must not fire.
        """
        self.assertEqual(validate_fixture_xg(_anchored(weight=0.0)), [])

    def test_the_committed_sample_passes(self):
        self.assertEqual(validate_fixture_xg(json.loads(SAMPLE.read_text())), [])


class BlendBracketTests(unittest.TestCase):
    """
    Invariant 1, the strongest single check: a blended rate lies between the
    posterior and the market.

    One comparison catches three unrelated defects, which is why it earns its
    place at the top: a wrong-sign weight moves the rate AWAY from the market, a
    swapped home and away moves ``lambda_home`` toward the away market rate, and a
    units error leaves the bracket entirely.
    """

    def test_the_blend_actually_sits_inside_the_bracket(self):
        """The positive case, asserted directly rather than only via the validator."""
        row = ANCHORED["fixtures"][0]
        self.assertEqual(row["rate_source"], "market_blend")
        self.assertLess(row["lambda_home_dc"], row["lambda_home"])
        self.assertLess(row["lambda_home"], row["market"]["lambda_home"])

    def test_a_rate_past_the_market_is_rejected(self):
        broken = _broken(ANCHORED, lambda p: p["fixtures"][0].update(
            lambda_home=p["fixtures"][0]["market"]["lambda_home"] * 1.5
        ))
        self.assertTrue(_messages(broken, "bracket"))
        self.assertTrue(_messages(broken, "fixture 100"))

    def test_a_wrong_sign_weight_is_rejected(self):
        """
        The rate moved away from the market by exactly what it should have moved
        toward it — the payload a sign slip in ``blend_log`` would produce.
        """
        row = ANCHORED["fixtures"][0]
        deviation = math.log(row["market"]["lambda_home"] / row["lambda_home_dc"])
        weight = ANCHORED["market"]["blend_weight"]
        broken = _broken(ANCHORED, lambda p: p["fixtures"][0].update(
            lambda_home=row["lambda_home_dc"] * math.exp(-weight * deviation)
        ))
        self.assertTrue(_messages(broken, "bracket"))

    def test_swapping_home_and_away_is_rejected(self):
        def swap(payload):
            row = payload["fixtures"][0]
            row["lambda_home"], row["mu_away"] = row["mu_away"], row["lambda_home"]

        problems = _messages(_broken(ANCHORED, swap), "bracket")
        # Both sides must fire: a swap that only tripped one of them would be
        # half-detected, and the half it missed is a whole club's clean sheets.
        self.assertTrue(any("lambda_home=" in p for p in problems), problems)
        self.assertTrue(any("mu_away=" in p for p in problems), problems)

    def test_a_units_error_inside_the_plausible_band_is_still_rejected(self):
        """
        2.5x is a units-style error that stays inside [0.1, 5.0] goals, so the band
        check cannot see it. The bracket can.
        """
        broken = _broken(ANCHORED, lambda p: p["fixtures"][0].update(
            lambda_home=p["fixtures"][0]["lambda_home"] * 2.5
        ))
        self.assertTrue(_messages(broken, "bracket"))

    def test_a_thin_market_overshooting_the_bracket_is_accepted(self):
        """
        The false positive a strict bracket would produce, pinned so nobody
        re-tightens it and fails the daily export.

        ``blend_log`` gives ``log lam = log dc + w*L + e*(D - L)`` with
        ``e = w * market.weight``. When a market earns less than full trust the
        league level term keeps weight ``w - e`` while the fixture-specific term is
        cut to ``e``, so the result can land past the market's own number. Measured
        here: at the registry weight 0.55, a two-book market (weight 1/3) and the
        0.0233 league correction the sample export actually produced, a fixture
        whose market agreed with the posterior to within 0.5% comes out ABOVE the
        market. That is a healthy run.
        """
        from pipeline.models.market_rates import (
            STATUS_CONVERGED, MarketRates, blend_log,
        )

        dc_home, dc_away, weight = 1.10, 1.00, 0.55
        level = (0.0233, 0.0233)
        market = MarketRates(
            lambda_home=dc_home * math.exp(0.005),
            mu_away=dc_away * math.exp(0.005),
            status=STATUS_CONVERGED, n_bookmakers=2, dispersion=0.20,
            residual=0.01, n_constraints=3, devig_method="proportional",
            weight=1.0 / 3.0,
        )
        lam, mu, source = blend_log(dc_home, dc_away, market, weight, level)

        # The overshoot is real, not hypothetical. Without this assertion the test
        # would still pass if the scenario stopped exercising the slack at all.
        self.assertGreater(lam, market.lambda_home)
        self.assertEqual(source, "market_blend")

        payload = _hand_built(
            lambda_home_dc=dc_home, mu_away_dc=dc_away,
            lambda_home=round(lam, 6), mu_away=round(mu, 6),
            rate_source=source, market=market.as_dict(),
            blend_weight=weight, level=level,
        )
        self.assertEqual(validate_fixture_xg(payload), [])


def _hand_built(
    lambda_home_dc, mu_away_dc, lambda_home, mu_away, rate_source, market,
    blend_weight, level, gameweek=1, match_id="200",
):
    """
    A one-fixture payload assembled by hand.

    Bypasses the export entirely, so a case the solver cannot be persuaded to
    produce — a thin two-book market, a specific league level — is still testable
    against the real ``blend_log`` output.
    """
    return {
        "schema_version": 1,
        "source": "dixon_coles_posterior+market_blend",
        "statistical_component": "dixon_coles_posterior",
        "horizon": 1,
        "first_gameweek": gameweek,
        "n_fixtures": 1,
        "prior_only_clubs": [],
        "market": {
            "devig_method": "proportional",
            "blend_weight": blend_weight,
            "blend_weight_status": "prior_confirmed_out_of_sample",
            "rho": 0.0,
            "level_correction": {"home": level[0], "away": level[1]},
            "n_anchored": 1,
            "n_priced": 1,
            "statuses": {"converged": 1},
            "median_bookmakers": 2,
        },
        "fixtures": [{
            "match_id": match_id,
            "gameweek": gameweek,
            "home_team": "Arsenal",
            "away_team": "Chelsea",
            "lambda_home_dc": lambda_home_dc,
            "mu_away_dc": mu_away_dc,
            "lambda_home_sd": 0.0,
            "mu_away_sd": 0.0,
            "kickoff": "2026-08-21T14:00:00Z",
            "prior_only": False,
            "lambda_home": lambda_home,
            "mu_away": mu_away,
            "rate_source": rate_source,
            "supremacy": round(lambda_home - mu_away, 6),
            "total_goals": round(lambda_home + mu_away, 6),
            "market": market,
        }],
    }


class ProvenanceTests(unittest.TestCase):
    """
    Invariant 2. ``rate_source`` is what the consumer reads to decide whether a
    rate is market-informed at all, so a label that does not match the row is
    worse than a missing one.
    """

    def test_an_unlisted_rate_source_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(
            rate_source="dixon_coles_posterior+vibes"
        ))
        self.assertTrue(_messages(broken, "rate_source"))

    def test_market_blend_without_a_market_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(
            rate_source="market_blend"
        ))
        self.assertTrue(_messages(broken, "absent"))

    def test_market_blend_on_an_unconverged_market_is_rejected(self):
        broken = _broken(ANCHORED, lambda p: p["fixtures"][0]["market"].update(
            status="not_converged"
        ))
        self.assertTrue(_messages(broken, "rate_source is market_blend"))

    def test_a_converged_market_that_was_dropped_is_rejected(self):
        """
        The silent failure: the anchor was computed, and then not used. The
        artifact would look market-anchored at the payload level and be pure
        posterior on the row that mattered.
        """
        broken = _broken(ANCHORED, lambda p: p["fixtures"][0].update(
            rate_source="dixon_coles_posterior+level"
        ))
        self.assertTrue(_messages(broken, "computed and dropped"))


class RateBandTests(unittest.TestCase):
    """Invariant 3. Rates outside [0.1, 5.0] goals are not football results."""

    def test_a_rate_below_the_band_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(lambda_home=0.05))
        self.assertTrue(_messages(broken, "outside [0.1, 5.0]"))

    def test_a_rate_above_the_band_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(mu_away=7.0))
        self.assertTrue(_messages(broken, "outside [0.1, 5.0]"))

    def test_an_unblended_posterior_rate_is_checked_too(self):
        """
        ``lambda_home_dc`` is what makes the blend reversible, so an implausible
        value there is not cosmetic: it is the audit trail.
        """
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(mu_away_dc=0.0))
        self.assertTrue(_messages(broken, "mu_away_dc"))

    def test_a_market_rate_outside_the_band_is_rejected(self):
        broken = _broken(ANCHORED, lambda p: p["fixtures"][0]["market"].update(
            lambda_home=6.5
        ))
        self.assertTrue(_messages(broken, "market.lambda_home"))

    def test_a_negative_standard_deviation_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(
            lambda_home_sd=-0.1
        ))
        self.assertTrue(_messages(broken, "negative lambda_home_sd"))

    def test_a_non_finite_rate_is_rejected(self):
        """
        json.dumps emits bare NaN, which Python re-reads and JSON.parse does not.
        The message must name the fixture and field; the serialiser's own guard
        can only say the payload contains one somewhere.
        """
        broken = json.loads(json.dumps(PLAIN))
        broken["fixtures"][0]["lambda_home"] = float("nan")
        self.assertTrue(_messages(broken, "not a finite number"))


class DerivedFieldTests(unittest.TestCase):
    """
    Invariant 4. ``supremacy`` and ``total_goals`` are conveniences, which is
    exactly why they drift: a rescale that forgets them leaves a stale number the
    consumer trusts.
    """

    def test_a_stale_supremacy_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(supremacy=0.9))
        self.assertTrue(_messages(broken, "supremacy=0.9"))

    def test_a_stale_total_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(total_goals=3.4))
        self.assertTrue(_messages(broken, "total_goals=3.4"))

    def test_the_exported_rounding_is_not_treated_as_drift(self):
        """
        Rates ship at six decimals and ``supremacy`` is rounded after subtracting
        unrounded values, so the recomputed difference can disagree by 1e-6 with
        nothing wrong. A tolerance below that would fail every real export.
        """
        for row in PLAIN["fixtures"] + ANCHORED["fixtures"]:
            with self.subTest(match_id=row["match_id"]):
                self.assertAlmostEqual(
                    row["supremacy"], row["lambda_home"] - row["mu_away"], places=5
                )


class BlendParameterTests(unittest.TestCase):
    """
    Invariant 5. The blend weight and the league level correction are applied to
    EVERY gameweek, including ones the bookmakers never priced, so an
    out-of-range value here is not confined to the fixture that produced it.
    """

    def test_a_weight_above_one_is_rejected(self):
        broken = _broken(ANCHORED, lambda p: p["market"].update(blend_weight=1.5))
        self.assertTrue(_messages(broken, "not a blend"))

    def test_a_negative_weight_is_rejected(self):
        broken = _broken(ANCHORED, lambda p: p["market"].update(blend_weight=-0.1))
        self.assertTrue(_messages(broken, "not a blend"))

    def test_a_level_correction_beyond_the_clamp_is_rejected(self):
        broken = _broken(ANCHORED, lambda p: p["market"]["level_correction"].update(
            home=0.35
        ))
        self.assertTrue(_messages(broken, "exceeds the 0.2 clamp"))

    def test_a_level_correction_at_the_clamp_is_accepted(self):
        """0.20 is the clamp's own output, so it must not be treated as beyond it."""
        broken = _broken(ANCHORED, lambda p: p["market"]["level_correction"].update(
            away=-0.20
        ))
        self.assertEqual(_messages(broken, "clamp"), [])


class IdentityTests(unittest.TestCase):
    """
    Invariant 6. ``load_exported_rates`` keys rates BY ``match_id``, so a
    duplicate discards one fixture's rates and serves the other's for both.
    """

    def test_a_duplicate_match_id_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][1].update(
            match_id=p["fixtures"][0]["match_id"]
        ))
        self.assertTrue(_messages(broken, "duplicate match_id"))

    def test_a_truncated_payload_is_rejected(self):
        """``n_fixtures`` disagreeing with the rows means the file is not complete."""
        broken = _broken(PLAIN, lambda p: p["fixtures"].pop())
        self.assertTrue(_messages(broken, "n_fixtures says"))


class GameweekCoverageTests(unittest.TestCase):
    """
    Invariant 7. Every row states its gameweek, and the exported weeks are one
    unbroken run inside the horizon.

    The staleness check in ``load_exported_rates`` compares the current gameweek
    against this set, so a missing or wrong gameweek is what makes a three-week-old
    export indistinguishable from this morning's.
    """

    def test_a_row_without_a_gameweek_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].pop("gameweek"))
        self.assertTrue(_messages(broken, "gameweek missing"))

    def test_a_hole_in_the_middle_is_rejected(self):
        """A dropped week the horizon optimiser would plan straight through."""
        def drop_second(payload):
            payload["fixtures"] = [
                row for row in payload["fixtures"] if row["gameweek"] != 2
            ]
            payload["n_fixtures"] = len(payload["fixtures"])

        broken = _broken(PLAIN, drop_second)
        self.assertTrue(_messages(broken, "not contiguous"))

    def test_a_missing_leading_week_is_accepted(self):
        """
        Deliberately asymmetric, and the reason the check anchors on the lowest
        exported gameweek rather than on ``first_gameweek``: ``first_gameweek`` is
        the lowest UNFINISHED event while rows are filtered on per-fixture
        ``finished``, and FPL flips those independently. A week whose matches have
        all been played exports nothing, and demanding a row there would fail the
        export every Sunday night.
        """
        def drop_first(payload):
            payload["fixtures"] = payload["fixtures"][1:]
            payload["n_fixtures"] = len(payload["fixtures"])

        broken = _broken(PLAIN, drop_first)
        self.assertEqual(broken["first_gameweek"], 1)
        self.assertEqual(validate_fixture_xg(broken), [])

    def test_a_gameweek_below_first_gameweek_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p.update(first_gameweek=2))
        self.assertTrue(_messages(broken, "below first_gameweek"))

    def test_a_gameweek_past_the_horizon_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][-1].update(gameweek=9))
        self.assertTrue(_messages(broken, "beyond the horizon"))


class StructureTests(unittest.TestCase):
    def test_a_missing_top_level_key_is_rejected(self):
        broken = _broken(PLAIN, lambda p: p.pop("market"))
        self.assertTrue(_messages(broken, "market metadata missing"))

    def test_a_payload_without_fixtures_is_rejected(self):
        self.assertTrue(validate_fixture_xg({"schema_version": 1}))

    def test_a_non_object_payload_is_rejected(self):
        self.assertTrue(validate_fixture_xg([]))


class AssertionTests(unittest.TestCase):
    def test_assert_raises_and_names_the_fixture(self):
        broken = _broken(PLAIN, lambda p: p["fixtures"][0].update(lambda_home=9.9))
        with self.assertRaises(ArtifactContractError) as caught:
            assert_valid_fixture_xg(broken)
        self.assertIn("fixture 100", str(caught.exception))

    def test_assert_accepts_a_real_export(self):
        assert_valid_fixture_xg(ANCHORED)   # must not raise

    def test_the_export_validates_before_it_writes(self):
        """
        A stale or partial ``fixture_xg.json`` is worse than a missing one: FPL
        fixture ids are stable within a season, so yesterday's rows still match and
        would be served silently. The contract must therefore stop the write, not
        annotate it.
        """
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch(
                "pipeline.fpl.artifacts.assert_valid_fixture_xg",
                side_effect=ArtifactContractError("planted"),
            ):
                with self.assertRaises(ArtifactContractError):
                    export_fixture_xg(
                        _FakeDC(), _bootstrap(), _fixtures(), Path(tmp), horizon=4,
                    )
            self.assertFalse((Path(tmp) / "fixture_xg.json").exists())

    def test_the_export_validates_the_payload_it_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch(
                "pipeline.fpl.artifacts.assert_valid_fixture_xg"
            ) as validator:
                path = export_fixture_xg(
                    _FakeDC(), _bootstrap(), _fixtures(), Path(tmp), horizon=4,
                )
            validator.assert_called_once()
            self.assertEqual(
                validator.call_args.args[0], json.loads(path.read_text())
            )


class SchemaTests(unittest.TestCase):
    """The schema file is the contract a TypeScript consumer can validate against."""

    def test_the_schema_file_exists_and_parses(self):
        self.assertTrue(SCHEMA.exists())
        schema = json.loads(SCHEMA.read_text())
        self.assertIn("fixtures", schema["properties"])

    def test_the_sample_file_exists_and_parses(self):
        self.assertTrue(SAMPLE.exists())
        sample = json.loads(SAMPLE.read_text())
        # It must cover both row states a consumer handles differently.
        sources = {row["rate_source"] for row in sample["fixtures"]}
        self.assertEqual(sources, {"market_blend", "dixon_coles_posterior+level"})

    def test_every_required_fixture_field_is_produced(self):
        """Catches schema drift without needing jsonschema installed."""
        schema = json.loads(SCHEMA.read_text())
        required = schema["properties"]["fixtures"]["items"]["required"]
        for field in required:
            with self.subTest(field=field):
                self.assertIn(field, ANCHORED["fixtures"][0])

    def test_every_required_top_level_field_is_produced(self):
        schema = json.loads(SCHEMA.read_text())
        for field in schema["required"]:
            with self.subTest(field=field):
                self.assertIn(field, ANCHORED)

    def test_the_export_satisfies_the_schema_where_jsonschema_is_available(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed")
        schema = json.loads(SCHEMA.read_text())
        jsonschema.validate(ANCHORED, schema)
        jsonschema.validate(PLAIN, schema)
        jsonschema.validate(json.loads(SAMPLE.read_text()), schema)


if __name__ == "__main__":
    unittest.main()
