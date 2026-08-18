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
    execution in this environment, only inspected as source.

    Checks STRUCTURE, not just that both names appear as calls somewhere in
    the file. A presence-only check would still pass if a future edit
    reordered the logic so the fallback ran unconditionally first, leaving
    the anchored call present but unreachable. So this walks the enclosing
    statements: the anchored call must sit inside the `try` guarded by
    `fixture_xg_path.exists()`, and the fallback call must sit inside the
    `if not fpl_specs:` branch that follows it.
    """

    @classmethod
    def setUpClass(cls):
        cls.source = (REPO / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)

    @staticmethod
    def _calls_named(container, name):
        """Every ast.Call node calling `name`, found under `container`.

        `container` may be a real AST node or a synthetic ast.Module wrapping
        just one node's statement list — the latter is how the helpers below
        scope a search to one branch's body only (e.g. a try's success body,
        excluding its except handlers; or one if-branch, excluding the rest
        of the file).
        """
        return [
            node for node in ast.walk(container)
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == name
        ]

    def _anchored_call(self):
        """fixture_specs_from_fixture_xg, found only inside a try block's
        success body that is itself inside an `if <x>.exists():` guard —
        never bare, never inside the except handler."""
        for if_node in ast.walk(self.tree):
            if not (
                isinstance(if_node, ast.If)
                and isinstance(if_node.test, ast.Call)
                and isinstance(if_node.test.func, ast.Attribute)
                and if_node.test.func.attr == "exists"
            ):
                continue
            for stmt in if_node.body:
                if not isinstance(stmt, ast.Try):
                    continue
                wrapper = ast.Module(body=stmt.body, type_ignores=[])
                calls = self._calls_named(wrapper, "fixture_specs_from_fixture_xg")
                if calls:
                    return calls[0]
        return None

    def _fallback_call(self):
        """fixture_specs_from_predictions, found only inside an
        `if not fpl_specs:` branch's body."""
        for if_node in ast.walk(self.tree):
            if not (
                isinstance(if_node, ast.If)
                and isinstance(if_node.test, ast.UnaryOp)
                and isinstance(if_node.test.op, ast.Not)
                and isinstance(if_node.test.operand, ast.Name)
                and if_node.test.operand.id == "fpl_specs"
            ):
                continue
            wrapper = ast.Module(body=if_node.body, type_ignores=[])
            calls = self._calls_named(wrapper, "fixture_specs_from_predictions")
            if calls:
                return calls[0]
        return None

    def test_anchored_call_is_inside_the_guarded_read(self):
        call = self._anchored_call()
        self.assertIsNotNone(
            call,
            "fixture_specs_from_fixture_xg is not called inside a try "
            "block's success body nested under `if fixture_xg_path.exists():` "
            "— the market-anchored read must stay guarded, not bare or moved "
            "outside the exists()/try scaffolding",
        )

    def test_anchored_call_passes_gameweeks_scoped_to_the_current_week(self):
        """Regression guard for the ~8x inflation bug: fixture_xg.json spans
        GW1-8 (80 rows). Without gameweeks=[gameweek], every club's fixtures
        across the whole horizon are handed to one simulate_gameweek call,
        which accumulates them with += (built for a genuine intra-week
        double, not a season). A future edit dropping this keyword would
        silently reintroduce that inflation."""
        call = self._anchored_call()
        self.assertIsNotNone(call, "fixture_specs_from_fixture_xg is not called")
        keywords = {kw.arg: kw.value for kw in call.keywords}
        self.assertIn(
            "gameweeks", keywords,
            f"fixture_specs_from_fixture_xg at line {call.lineno} does not "
            "pass gameweeks= — without it every row across the full GW1-8 "
            "horizon is handed to the simulation",
        )
        value = keywords["gameweeks"]
        self.assertIsInstance(
            value, ast.List,
            f"gameweeks= at line {call.lineno} must be a literal list, got "
            f"{ast.dump(value)}",
        )
        self.assertEqual(
            len(value.elts), 1,
            f"gameweeks= at line {call.lineno} must scope to exactly one "
            f"gameweek, got {ast.dump(value)}",
        )
        element = value.elts[0]
        self.assertIsInstance(element, ast.Name)
        self.assertEqual(
            element.id, "gameweek",
            f"gameweeks= at line {call.lineno} must scope to the current "
            f"`gameweek` variable, got {ast.dump(element)}",
        )

    def test_fallback_call_is_inside_the_if_not_fpl_specs_branch(self):
        call = self._fallback_call()
        self.assertIsNotNone(
            call,
            "fixture_specs_from_predictions is not called inside an "
            "`if not fpl_specs:` branch — a wiring change that deleted the "
            "fallback, or made it unconditional, would strand or silently "
            "override every anchored run",
        )

    def test_anchored_attempt_precedes_the_fallback_guard(self):
        """Catches a reorder that moved the `if not fpl_specs:` check ahead
        of the anchored try — which would make the guard always true
        (fpl_specs is still its initial []) and the fallback effectively
        unconditional, even though it remains syntactically 'inside the
        guard'."""
        anchored = self._anchored_call()
        fallback = self._fallback_call()
        self.assertIsNotNone(anchored)
        self.assertIsNotNone(fallback)
        self.assertLess(
            anchored.lineno, fallback.lineno,
            "the anchored fixture_specs_from_fixture_xg call must appear "
            "before the `if not fpl_specs:` fallback guard in source order",
        )


if __name__ == "__main__":
    unittest.main()
