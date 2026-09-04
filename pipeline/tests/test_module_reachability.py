"""
Is every module actually reached from something that runs?

This test exists because the same defect occurred FIVE times in one session:
a module written, fully unit-tested, and imported by nothing.

    fixture_rates.py    every fixture simulated at a flat 1.45/1.20, so a
                        promoted side and the champions had identical
                        clean-sheet probabilities
    horizon.py          the multi-gameweek MILP, built and unreachable
    notify.py           the agent sealed forecasts and told nobody
    entry_api.py        every gameweek treated as an opening build from GW2,
                        with purchase prices never replayed
    calibration_check   the tail calibration the weekly objective ranks on,
                        only ever measured by hand

Not one of those was catchable by a unit test, because each module's own tests
were green — they tested the code, and what was wrong was that nothing called
it. Only a whole-package view can see it.

The allowlist below is the point of the design, not a weakness of it. Adding a
module to it is a deliberate statement that it is meant to be standalone, made
in a place a reviewer will see, with a reason attached. Forgetting to wire
something up no longer looks the same as choosing not to.
"""
from __future__ import annotations

import ast
import os
import pathlib
import subprocess
import sys
import unittest
from collections import defaultdict
from typing import Dict, Set

PACKAGE = pathlib.Path(__file__).resolve().parent.parent
REPO = PACKAGE.parent

# Modules deliberately reached by something other than a Python import. Each
# needs a reason, and the reason has to say WHAT runs it.
STANDALONE: Dict[str, str] = {
    # Invoked as `python -m ...` by CI, not imported.
    "pipeline.learning.run_agent": "entry point: .github/workflows/fpl_agent.yml",
    "pipeline.validation.run_validation": "entry point: .github/workflows/validate.yml",
    "pipeline.run_pipeline": "entry point: .github/workflows/pipeline.yml",
    "pipeline.learning.run_news": "entry point: .github/workflows/news.yml",
    # Writes predictions/team_metrics.json for the /teams view. A CLI rather than
    # a pipeline import on purpose: it feeds no projection and no stake
    # (`model_input: false` in the artifact, asserted by a test), so nothing in
    # the pipeline may come to depend on it. Wiring it into run_pipeline would
    # make an optional scraped source into a step whose absence someone would
    # eventually treat as a failure.
    "pipeline.learning.team_view": (
        "team attack/defence view, run by hand: "
        "python -m pipeline.learning.team_view. Deliberately imported by "
        "nothing — it is a read-only surface, and a pipeline that imported it "
        "could grow a dependency on a view"
    ),
    # A CLI the human runs to file an availability claim by hand. Deliberately not
    # imported by the pipeline: a claim is a human judgement, and code that could
    # call this could manufacture evidence.
    "pipeline.learning.file_claim": (
        "availability-claim CLI, run by hand. Deliberately imported by nothing: a "
        "claim is a human judgement, and code that could call this could "
        "manufacture evidence about who is fit to play"
    ),
    # Verification and research harnesses, run by hand against the archive. They
    # measure the system; nothing in the system may depend on them, or a
    # measurement would become load-bearing.
    "pipeline.fpl.replay": "scoring oracle, run by hand over the archive",
    "pipeline.learning.backtest": "walk-forward minutes backtest, run by hand",
    "pipeline.learning.backtest_decisions": "season decision backtest, run by hand",
    "pipeline.learning.fit_market_blend": (
        "out-of-sample market blend-weight fit, run by hand against the closing-odds "
        "corpus. Nothing may import it: it fits market.blend_weight, and a pipeline "
        "that called it would be refitting a shipped parameter mid-run"
    ),
    "pipeline.learning.fit_team_view_k": (
        "out-of-sample fit of TEAM_VIEW shrinkage_k and min_matches_for_rank, run "
        "by hand against ten prior Understat seasons. Nothing may import it, for "
        "the same reason as fit_market_blend: it fits shipped constants, and a "
        "pipeline that called it would be refitting them mid-run — and it fetches "
        "ten seasons, which is a bounded hand-run cost and an unbounded daily one"
    ),
    "pipeline.validation.fplreview_benchmark": (
        "temporary premium parity benchmark, run by hand during the shadow period"
    ),
    # Superseded. Kept only because removing it is a separate decision from
    # noticing it is unused.
    "pipeline.models.calibration": "UNUSED — superseded by validation.metrics",
}


def _module_name(path: pathlib.Path) -> str:
    return ".".join(path.relative_to(REPO).with_suffix("").parts)


def _import_graph() -> Dict[str, Set[str]]:
    """Which non-test modules import each module."""
    importers: Dict[str, Set[str]] = defaultdict(set)
    for path in PACKAGE.rglob("*.py"):
        if path.name == "__init__.py" or "tests" in path.parts:
            continue
        importer = _module_name(path)
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                importers[node.module].add(importer)
                # `from pipeline.data import news_extract` imports the SUBMODULE,
                # not just the package, so the submodule has to be credited too.
                #
                # Recording only `node.module` was a blind spot with teeth: any
                # module reached exclusively through the `from package import
                # module` form read as an orphan, which is the false positive that
                # makes a guard get disabled rather than believed. Names that are
                # not modules (`from pipeline.config import NEWS_FEEDS`) are
                # harmless here — `_all_modules()` only ever asks about real ones.
                for alias in node.names:
                    importers[f"{node.module}.{alias.name}"].add(importer)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    importers[alias.name].add(importer)
    return importers


def _all_modules() -> Set[str]:
    return {
        _module_name(path)
        for path in PACKAGE.rglob("*.py")
        if path.name != "__init__.py" and "tests" not in path.parts
    }


class TestEveryModuleIsReachable(unittest.TestCase):
    def test_no_module_is_imported_only_by_tests(self):
        """
        The five-times bug. A module nothing imports is either dead or was meant
        to be wired and was not, and a green unit-test suite cannot tell you
        which.
        """
        importers = _import_graph()
        orphans = sorted(
            name for name in _all_modules()
            if not importers.get(name) and name not in STANDALONE
        )
        self.assertEqual(
            orphans, [],
            "these modules are imported by no non-test module. Either wire them "
            "into a real code path, or add them to STANDALONE with a reason "
            "saying what runs them:\n  " + "\n  ".join(orphans),
        )

    def test_the_allowlist_has_no_stale_entries(self):
        """
        A module that has since been wired up must leave the allowlist, or the
        list stops meaning anything and the next real orphan hides behind it.

        Entry points are exempt, and that is a real distinction rather than a
        convenience: their justification is "CI invokes this", which stays true
        whether or not something also imports them. run_pipeline is exactly that
        — a workflow entry point that also exports stable_seed_entropy to the
        agent. A module marked UNUSED is likewise exempt, since being unimported
        is the claim.
        """
        importers = _import_graph()
        wired = sorted(
            name for name, reason in STANDALONE.items()
            if importers.get(name)
            and not reason.startswith("UNUSED")
            and not reason.startswith("entry point")
        )
        self.assertEqual(
            wired, [],
            "these are now imported by real code and should be removed from "
            "STANDALONE:\n  " + "\n  ".join(wired),
        )

    def test_every_allowlist_entry_names_what_runs_it(self):
        """
        "standalone" with no reason is indistinguishable from "forgotten". The
        reason is what makes the allowlist a decision rather than a suppression.
        """
        for name, reason in STANDALONE.items():
            self.assertTrue(reason.strip(), f"{name} has an empty reason")
            self.assertRegex(
                reason,
                r"entry point:|run by hand|UNUSED",
                f"{name}: the reason must say what runs it, or mark it UNUSED",
            )

    def test_allowlisted_entry_points_exist_in_a_workflow(self):
        """
        An entry point nothing invokes is exactly the bug this file is about,
        one level up: the module is 'reached' only by a workflow line that was
        deleted.
        """
        workflows = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (REPO / ".github" / "workflows").glob("*.yml")
        )
        for name, reason in STANDALONE.items():
            if not reason.startswith("entry point"):
                continue
            self.assertIn(
                name, workflows,
                f"{name} is allowlisted as an entry point but appears in no "
                f"workflow file",
            )

    def test_the_harnesses_are_not_depended_on_by_the_system(self):
        """
        Research harnesses measure the system. If the system imported one, a
        measurement would become load-bearing and could not be changed freely.
        """
        importers = _import_graph()
        for name, reason in STANDALONE.items():
            if "run by hand" not in reason:
                continue
            self.assertEqual(
                importers.get(name, set()), set(),
                f"{name} is a measurement harness but is imported by "
                f"{sorted(importers.get(name, set()))}",
            )


class TestTheAgentNeverFetchesOdds(unittest.TestCase):
    """
    The Odds API free tier is 500 requests a month and the daily pipeline spends
    it. The FPL agent runs every three hours — eight times a day, ~240 requests a
    month — so it must consume the committed export and never fetch.

    Asserted structurally rather than by comment, because the comment is what a
    future refactor deletes. The transitive import closure is the right level: an
    indirect import through a new helper would spend the quota just as surely as a
    direct one.
    """

    def test_importing_the_agent_does_not_load_the_odds_client(self):
        """
        Checked at RUNTIME, in a fresh interpreter, not as a static import closure.

        A static closure test was tried first and is the wrong instrument: this
        repo imports heavy modules lazily inside functions, so the graph shows
        ``run_agent -> run_pipeline -> odds_api`` even though the agent never
        executes either import. The test failed on a codebase that was correct,
        which is worse than no test — it would have been silenced rather than
        fixed.

        What matters is whether the module is ever LOADED, so that is what this
        asserts. A subprocess is required because the rest of the suite has
        already imported half the package.
        """
        script = (
            "import sys\n"
            "import pipeline.learning.run_agent\n"
            "loaded = 'pipeline.data.odds_api' in sys.modules\n"
            "print('LOADED' if loaded else 'CLEAN')\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(REPO), capture_output=True, text=True,
            env={"PYTHONPATH": str(REPO), "PATH": os.environ.get("PATH", "")},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "CLEAN", result.stdout,
            "importing the FPL agent now loads the Odds API client. The agent runs "
            "8x/day, so a fetch there would spend roughly 240 of the 500 monthly "
            "requests. The daily pipeline owns the quota; the agent reads "
            "predictions/fixture_xg.json.",
        )

    def test_the_market_modules_never_import_the_odds_client(self):
        """
        Belt and braces at the module level: these consume prices handed to them.
        """
        for module in (
            "pipeline.models.market_rates",
            "pipeline.models.devig",
            "pipeline.models.fixture_rates",
            "pipeline.data.market_snapshots",
        ):
            path = REPO / (module.replace(".", "/") + ".py")
            with self.subTest(module=module):
                self.assertNotIn("OddsAPIClient", path.read_text(encoding="utf-8"))
