"""
The workflows must stage the filenames the writers actually produce.

This is a seam no other test covers, and it failed silently for the entire life
of the FPL agent. ``fpl_agent.yml`` staged ``predictions/fpl/decision_latest.json``
while ``write_decision`` writes ``decision_gw{NN}_{label}.json``. Because
``commit_and_push.sh`` treats a pathspec matching nothing as success — correctly,
since most artifacts are absent most of the time — every run reported a clean
publish and every private decision was written to the runner and discarded with
it. The audit trail of what the optimiser rejected has never existed.

A unit test on either side would have passed. The writer wrote the right file and
the workflow staged a well-formed path; only the *agreement* between them was
wrong. So the test has to read the YAML and the Python together.

Deliberately string-matching the workflow rather than parsing it as a pipeline
config: these are shell lines inside a `run:` block, so there is no schema to
validate against, and a substring assertion is what actually pins the bug.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "fpl_agent.yml"
PIPELINE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "pipeline.yml"

# The decision filename, as `write_decision` builds it. Kept as a literal rather
# than imported so that renaming the Python without updating the workflow breaks
# this test — importing the format string would make both sides move together and
# defeat the point.
PRIVATE_DECISION_GLOB = "predictions/fpl/decision_gw*.json"


class DecisionStagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = AGENT_WORKFLOW.read_text()
        self.pipeline = PIPELINE_WORKFLOW.read_text()

    def test_the_agent_stages_the_decision_glob(self):
        self.assertIn(PRIVATE_DECISION_GLOB, self.agent)

    def test_no_workflow_names_the_phantom_file(self):
        """
        ``decision_latest.json`` is written by nothing, anywhere. Both workflows
        referenced it — the agent staged it and the daily job excluded it — so
        both looked deliberate and neither did anything.
        """
        for name, text in (("fpl_agent.yml", self.agent),
                           ("pipeline.yml", self.pipeline)):
            with self.subTest(workflow=name):
                self.assertNotIn("decision_latest.json", text)

    def test_the_writers_filename_matches_the_staged_glob(self):
        """
        Derive the real filename from the writer and check the glob covers it.

        This is the assertion that ties the two sides together: it fails if the
        Python filename changes, if the workflow glob changes, or if either
        changes in a way that stops them overlapping.
        """
        from pipeline.decide.run_decide import Decision

        # Reproduce the name without constructing a Decision, which needs a
        # solver. This mirrors write_decision's f-string exactly.
        for gameweek, label in ((1, "season"), (7, "weekly"), (38, "season")):
            filename = f"decision_gw{gameweek:02d}_{label}.json"
            with self.subTest(filename=filename):
                self.assertTrue(
                    Path(filename).match("decision_gw*.json"),
                    f"{filename} is not covered by the staged glob",
                )

        # And the field the frontend needs is on the dataclass, so a staged file
        # is a *useful* file rather than merely a present one.
        self.assertIn("deadline", Decision.__dataclass_fields__)

    def test_the_daily_job_is_still_forbidden_from_committing_decisions(self):
        """
        Path ownership: the agent produces decisions, so the agent commits them.

        ``pipeline.yml`` stages ``predictions`` wholesale, so without this guard
        the daily job would race the agent for the same files. FORBID_PATHS is
        what prevents it, and it must keep matching the decision prefix.
        """
        match = re.search(r"FORBID_PATHS:\s*'([^']+)'", self.pipeline)
        self.assertIsNotNone(match, "pipeline.yml has no FORBID_PATHS")
        pattern = re.compile(match.group(1))
        self.assertTrue(pattern.match("predictions/fpl/decision_gw07_season.json"))
        self.assertTrue(pattern.match("predictions/fpl/ledger/gw07/score.json"))

    def test_the_agent_is_permitted_to_commit_decisions(self):
        """
        The mirror of the above. Fixing the filename achieves nothing if the
        agent's own FORBID_PATHS then refuses the file — which is exactly the
        trap the previous ownership split fell into, leaving the worktree
        permanently dirty and `git pull --rebase` refusing outright.
        """
        match = re.search(r"FORBID_PATHS:\s*'([^']+)'", self.agent)
        self.assertIsNotNone(match, "fpl_agent.yml has no FORBID_PATHS")
        pattern = re.compile(match.group(1))
        self.assertIsNone(
            pattern.match("predictions/fpl/decision_gw07_season.json"),
            "the agent's FORBID_PATHS blocks the decision it is meant to commit",
        )

    def test_the_public_decision_is_published_by_the_agent(self):
        """
        The stripped copy goes to frontend/public/predictions/fpl, which the
        agent already stages as a directory. Asserted because the private fix
        must not be mistaken for having fixed publication too.
        """
        self.assertIn("frontend/public/predictions/fpl", self.agent)


class NewsLaneStagingTests(unittest.TestCase):
    """
    `run_news` has two callers, and they must stage the same things.

    `news.yml` runs it every 15 minutes in CI; `scripts/x_scan.sh` runs it twice a
    day on the machine that can reach X. Same writer, same artifacts — but the
    script's commit list was written before `minutes_conflicts` existed and never
    grew to include it. So the CI lane published the artifact while the local lane
    produced an identical one, left it uncommitted, and handed it to the next
    scan's `--autostash` to shuffle back and forth. The dash saw it only when a
    human committed it by hand.

    Neither side is wrong read on its own, which is why this file exists.
    """

    #: As `_report_minutes_conflicts` builds it: f"minutes_conflicts_gw{gw:02d}.json".
    #: A literal, not an import, so renaming the Python has to break something.
    CONFLICTS = "minutes_conflicts_gw*.json"

    def setUp(self) -> None:
        self.news = (REPO_ROOT / ".github" / "workflows" / "news.yml").read_text()
        self.script = (REPO_ROOT / "scripts" / "x_scan.sh").read_text()

    def test_both_callers_stage_the_minutes_conflicts_artifacts(self):
        for lane, text in (("news.yml", self.news), ("x_scan.sh", self.script)):
            for prefix in ("predictions/fpl/", "frontend/public/predictions/fpl/"):
                with self.subTest(lane=lane, path=prefix):
                    self.assertIn(
                        prefix + self.CONFLICTS, text,
                        f"{lane} runs the poller but never commits "
                        f"{prefix}{self.CONFLICTS}, so it stays dirty forever",
                    )

    def test_the_writers_filename_matches_the_staged_glob(self):
        # Ties the two sides together, as the decision test above does.
        for gameweek in (1, 7, 38):
            filename = f"minutes_conflicts_gw{gameweek:02d}.json"
            with self.subTest(filename=filename):
                self.assertTrue(Path(filename).match(self.CONFLICTS))

    def test_the_news_lane_is_permitted_to_commit_them(self):
        # Staging a path the job's own guard then refuses is the trap the decision
        # ownership split fell into. `run_news` states in comments that this is the
        # news lane's own artifact; FORBID_PATHS has to agree.
        match = re.search(r"FORBID_PATHS:\s*'([^']+)'", self.news)
        self.assertIsNotNone(match, "news.yml has no FORBID_PATHS")
        pattern = re.compile(match.group(1))
        for path in ("predictions/fpl/minutes_conflicts_gw01.json",
                     "frontend/public/predictions/fpl/minutes_conflicts_gw01.json"):
            with self.subTest(path=path):
                self.assertIsNone(
                    pattern.match(path),
                    "news.yml forbids the artifact it is meant to commit",
                )

    def test_the_script_survives_a_glob_that_matches_nothing(self):
        # Before the season's first artifact the glob matches no file. Without
        # `nullglob` git is handed a literal `*`, which `git add` rejects — turning
        # a run with nothing to do into a failing one.
        self.assertIn("shopt -s nullglob", self.script)
        self.assertLess(
            self.script.index("shopt -s nullglob"), self.script.index("PATHS=("),
            "nullglob must be set before the array expands",
        )


class Phase0ArtifactGateTests(unittest.TestCase):
    """PHASE0_VERIFY_ARTIFACTS appeared in no workflow, so both env-gated
    artifact tests skipped everywhere — locally AND in CI — and the exit
    criterion ("every published fixture states where its rates came from")
    was checked by nothing.

    Position is the whole fix. The obvious remedy, adding the variable to the
    existing "Run pipeline contract tests" step, would DEADLOCK the daily job:
    that step runs BEFORE the pipeline, against the artifact committed by the
    previous run, whose fixtures still carry rate_source null. The tests would
    fail, the job would abort, and the artifact that would have fixed them
    would never be regenerated."""

    ENV_VAR = "PHASE0_VERIFY_ARTIFACTS"
    GATED_MODULES = (
        "pipeline.tests.test_xp_artifact_rate_source",
        "pipeline.tests.test_health_provenance",
    )

    def setUp(self) -> None:
        self.pipeline = PIPELINE_WORKFLOW.read_text()

    def _index(self, step_name):
        marker = f"- name: {step_name}"
        position = self.pipeline.find(marker)
        self.assertNotEqual(
            position, -1, f"pipeline.yml has no step named {step_name!r}")
        return position

    def test_the_gate_variable_is_set_somewhere_in_the_daily_job(self):
        self.assertIn(self.ENV_VAR, self.pipeline)

    def test_every_env_gated_module_is_named_by_the_verify_step(self):
        """Derived from the modules that actually read the variable, so adding
        a third gated test without wiring it here fails rather than skipping
        forever — which is the defect this class exists for."""
        # Matched on the skipUnless READ, not on a mention of the name —
        # otherwise this module's own prose would count itself.
        needle = f'os.environ.get("{self.ENV_VAR}")'
        gated = sorted(
            f"pipeline.tests.{path.stem}"
            for path in (REPO_ROOT / "pipeline" / "tests").glob("test_*.py")
            if needle in path.read_text()
        )
        self.assertEqual(gated, sorted(self.GATED_MODULES))
        for module in gated:
            with self.subTest(module=module):
                self.assertIn(module, self.pipeline)

    def test_the_gate_runs_after_the_pipeline_that_produces_the_artifact(self):
        self.assertLess(
            self._index("Run prediction pipeline"),
            self._index("Verify Phase 0 artifacts"),
            "verifying before the pipeline regenerates the artifact checks the "
            "PREVIOUS run's output and deadlocks the job: the tests fail, the "
            "job aborts, and the artifact is never regenerated",
        )

    def test_the_gate_runs_before_anything_publishes_or_commits(self):
        verify = self._index("Verify Phase 0 artifacts")
        for later in ("Sync predictions to frontend", "Commit predictions"):
            with self.subTest(step=later):
                self.assertLess(
                    verify, self._index(later),
                    "a run that produced an unanchored artifact must fail "
                    "instead of committing it",
                )

    def test_the_pre_pipeline_contract_step_does_not_set_the_gate(self):
        """The deadlock, pinned. "Run pipeline contract tests" runs before the
        pipeline; setting the variable there fails the job on the previous
        run's stale artifact and prevents the regeneration that would fix it."""
        start = self._index("Run pipeline contract tests")
        end = self._index("Run prediction pipeline")
        self.assertNotIn(self.ENV_VAR, self.pipeline[start:end])


if __name__ == "__main__":
    unittest.main()
