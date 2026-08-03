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
import pathlib
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
    # Verification and research harnesses, run by hand against the archive. They
    # measure the system; nothing in the system may depend on them, or a
    # measurement would become load-bearing.
    "pipeline.fpl.replay": "scoring oracle, run by hand over the archive",
    "pipeline.learning.backtest": "walk-forward minutes backtest, run by hand",
    "pipeline.learning.backtest_decisions": "season decision backtest, run by hand",
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
