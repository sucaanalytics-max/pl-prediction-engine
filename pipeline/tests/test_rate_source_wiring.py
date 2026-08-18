"""Prove the market-anchored rate path is wired in, without a pipeline run.

Task 4 built ``fixture_specs_from_fixture_xg`` and gave ``FixtureSpec`` a
``rate_source`` field, but nothing called it. This task wires it into
``run_pipeline.py`` and makes both artifact emitters in
``pipeline/fpl/artifacts.py`` publish ``rate_source`` per fixture. Regenerating
the real artifact requires a full pipeline run (pymc/xgboost/sklearn), which
this environment cannot do, so these tests verify the wiring directly:

1. Both places in ``artifacts.py`` that build a fixture row from a ``spec``
   (``build_xp_artifact``, which rounds rates to 4dp, and ``build_sim_params``,
   which does not) must carry ``spec.rate_source`` into the emitted row.
2. The legacy fallback, ``fixture_specs_from_predictions``, must stamp
   ``rate_source="ensemble_unanchored"`` so a fallback run can never look like
   an anchored one.
3. ``run_pipeline.py`` must actually call ``fixture_specs_from_fixture_xg`` at
   its FPL call site, and must still reference ``fixture_specs_from_predictions``
   as the fallback — using the same AST-parsing technique as
   ``test_sealing_freshness.py``, since neither call site is otherwise
   reachable without the heavy pipeline dependencies.
"""
import ast
import unittest
from pathlib import Path

from pipeline.fpl.artifacts import build_sim_params, build_xp_artifact
from pipeline.fpl.rules import load_rules
from pipeline.models.fpl_inputs import fixture_specs_from_predictions
from pipeline.simulation.gameweek_sim import FixtureSpec, GameweekDraws

REPO = Path(__file__).resolve().parents[2]
RULES = load_rules()

SPECS = [
    FixtureSpec(
        match_id="m1", gameweek=1, home_team="Alpha", away_team="Beta",
        lambda_home=1.6, mu_away=1.1, kickoff="2026-09-12T14:00:00Z",
        rate_source="market_blend",
    ),
    FixtureSpec(
        match_id="m2", gameweek=1, home_team="Gamma", away_team="Delta",
        lambda_home=1.3, mu_away=0.9, kickoff="2026-09-12T14:00:00Z",
        rate_source="dixon_coles_posterior+level",
    ),
]


def _empty_draws(gameweek=1):
    """A GameweekDraws with no players — enough to exercise fixture emission
    without the heavy simulate_gameweek setup (priors, minutes model, etc.)."""
    return GameweekDraws(gameweek=gameweek)


class BothArtifactEmittersCarryRateSource(unittest.TestCase):
    """artifacts.py builds fixture rows from `spec` in two places. Both must
    carry rate_source through, or a consumer reading one artifact type sees
    provenance while the other silently loses it."""

    def test_build_xp_artifact_carries_rate_source(self):
        artifact = build_xp_artifact(
            _empty_draws(), "2627", "2026-08-18T00:00:00Z", RULES, SPECS,
        )
        rows = artifact["fixtures"]
        self.assertEqual(len(rows), len(SPECS))
        sources = {row["home_team"]: row.get("rate_source") for row in rows}
        self.assertEqual(
            sources,
            {"Alpha": "market_blend", "Gamma": "dixon_coles_posterior+level"},
        )

    def test_build_sim_params_carries_rate_source(self):
        params = build_sim_params(
            "2627", 1, "2026-08-18T00:00:00Z", 7, 500, SPECS,
        )
        rows = params["fixtures"]
        self.assertEqual(len(rows), len(SPECS))
        sources = {row["home_team"]: row.get("rate_source") for row in rows}
        self.assertEqual(
            sources,
            {"Alpha": "market_blend", "Gamma": "dixon_coles_posterior+level"},
        )

    def test_missing_rate_source_is_still_explicit_not_omitted(self):
        """A FixtureSpec built without rate_source must still emit the key
        (as None), never drop it — an omitted key is indistinguishable from a
        producer that was never updated."""
        bare = FixtureSpec(
            match_id="m3", gameweek=1, home_team="Epsilon", away_team="Zeta",
            lambda_home=1.5, mu_away=1.0,
        )
        artifact = build_xp_artifact(
            _empty_draws(), "2627", "2026-08-18T00:00:00Z", RULES, [bare],
        )
        self.assertIn("rate_source", artifact["fixtures"][0])
        self.assertIsNone(artifact["fixtures"][0]["rate_source"])


class LegacyPathIsLabelled(unittest.TestCase):
    """fixture_specs_from_predictions is the pre-Task-4 ensemble path, kept
    only as a fallback. A fallback that looks identical to an anchored run
    would make silent regressions undetectable."""

    def test_fixture_specs_from_predictions_stamps_ensemble_unanchored(self):
        predictions = [
            {
                "match_id": "77",
                "fixture": {
                    "home_team": "Arsenal", "away_team": "Chelsea",
                    "gameweek": 3, "date": "2026-09-20T14:00:00Z",
                },
                "expected_goals": {"home": 1.8, "away": 1.2},
            }
        ]
        specs = fixture_specs_from_predictions(predictions, gameweek=3)
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].rate_source, "ensemble_unanchored")


class RunPipelineCallSiteSwitched(unittest.TestCase):
    """AST technique mirrors pipeline/tests/test_sealing_freshness.py, since
    the FPL block in run_pipeline.py sits inside a try/except that swallows
    ImportError for pymc/xgboost/sklearn — it cannot be exercised by import or
    execution in this environment, only inspected as source."""

    @classmethod
    def setUpClass(cls):
        source = (REPO / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        cls.called_names = {
            getattr(node.func, "id", None)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
        }

    def test_fixture_specs_from_fixture_xg_is_called(self):
        self.assertIn(
            "fixture_specs_from_fixture_xg", self.called_names,
            "run_pipeline.py no longer calls fixture_specs_from_fixture_xg — "
            "the market-anchored rate path is not wired in",
        )

    def test_fixture_specs_from_predictions_is_still_called_as_fallback(self):
        self.assertIn(
            "fixture_specs_from_predictions", self.called_names,
            "run_pipeline.py no longer calls fixture_specs_from_predictions — "
            "a wiring change that deleted the fallback would strand every run "
            "whose fixture_xg.json is absent or malformed",
        )


if __name__ == "__main__":
    unittest.main()
