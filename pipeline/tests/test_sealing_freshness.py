"""The daily lane seals the forecast ledger, so it may not run on stale cache.

fpl_api documents this as a contract: a caller that timestamps a forecast must
refuse stale data. run_agent obeys it; the daily pipeline did not.
"""
import ast
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


class SealingRunRefusesStaleBootstrap(unittest.TestCase):
    # Task 6 swaps these call sites to the provenance-returning variants. The
    # rule under test is about allow_stale, not about which wrapper is used, so
    # accept either name and keep the test valid across that change.
    FETCHERS = {
        "fetch_bootstrap_static", "fetch_bootstrap_static_with_provenance",
        "fetch_fixtures", "fetch_fixtures_with_provenance",
    }

    def test_daily_pipeline_passes_allow_stale_false(self):
        source = (REPO / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and getattr(node.func, "id", None) in self.FETCHERS
        ]
        self.assertTrue(calls, "expected run_pipeline to fetch FPL bootstrap/fixtures")
        for call in calls:
            name = call.func.id
            keywords = {kw.arg for kw in call.keywords}
            self.assertIn(
                "allow_stale", keywords,
                f"{name} at line {call.lineno} must pass allow_stale explicitly — "
                "this run seals the forecast ledger",
            )
            allow_stale = next(
                kw.value for kw in call.keywords if kw.arg == "allow_stale")
            self.assertIs(
                allow_stale.value, False,
                f"{name} at line {call.lineno} must pass allow_stale=False",
            )
