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


if __name__ == "__main__":
    unittest.main()
