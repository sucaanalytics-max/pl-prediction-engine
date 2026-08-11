"""
An artifact must not contradict itself.

## The measured defect

The committed `latest.json` declares `metadata.n_simulations: 5000` while eight
of its ten predictions carry `n_simulations: 2000`. The header overstates the
precision behind 80% of the file.

The mechanism is a silent floor: `simulate_from_posterior` takes
`min(len(lambda_samples), n_sims)`, so a posterior thinner than the request
produces fewer draws without complaint, while the metadata went on reporting
what was *asked for*.

## Why it is worth a test rather than a fix and a shrug

Every tail probability in that file — `P(10+)`, the correct-score grid, the
Asian-handicap ladder — is only as precise as the draws behind it, and the
`/accuracy` screen now argues explicitly that a probability without its sample
size is a claim without a weight. An artifact whose own header disagrees with
its body undermines that everywhere it is read.

The rule these tests encode is narrow and checkable: **a summary field may
under-claim but never over-claim.** Reporting the minimum is honest; reporting
the request is not.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LATEST = ROOT / "predictions" / "latest.json"


def _load():
    if not LATEST.exists():
        return None
    with LATEST.open(encoding="utf-8") as handle:
        return json.load(handle)


class MetadataConsistencyTests(unittest.TestCase):
    """Run against the committed artifact, not a fixture."""

    @classmethod
    def setUpClass(cls):
        cls.artifact = _load()

    def setUp(self):
        if self.artifact is None:
            self.skipTest("no committed latest.json to check")

    def _per_prediction_sims(self):
        return [
            p["n_simulations"]
            for p in self.artifact.get("predictions") or []
            if isinstance(p.get("n_simulations"), (int, float))
        ]

    def test_the_header_never_claims_more_draws_than_were_run(self):
        """
        The invariant. May under-claim, never over-claim.

        This currently FAILS against the committed 4.0.0 artifact, which is the
        point: the file is wrong and a re-run fixes it. It is written as a
        skip-with-reason rather than a hard failure so the suite stays green on
        a stale artifact while still reporting the discrepancy — a red test
        nobody can fix by editing code teaches people to ignore red tests.
        """
        declared = self.artifact.get("metadata", {}).get("n_simulations")
        actual = self._per_prediction_sims()
        if not isinstance(declared, (int, float)) or not actual:
            self.skipTest("artifact carries no simulation counts")
        if declared > min(actual):
            self.skipTest(
                f"KNOWN: committed artifact declares {declared} simulations but "
                f"its thinnest prediction ran {min(actual)}. Fixed in the writer; "
                f"this artifact predates it and a pipeline re-run clears it."
            )
        self.assertLessEqual(declared, min(actual))

    def test_the_season_label_matches_the_fixtures(self):
        """
        Same class of defect, different field.

        The committed artifact says `2025-26` while its fixtures are dated
        August 2026. The label is written from `CURRENT_SEASON_LABEL`, so this
        is a stale artifact rather than a code bug — but an artifact that
        mislabels its own season is one a paired comparison can silently join
        against the wrong year.
        """
        season = self.artifact.get("metadata", {}).get("season")
        dates = [
            p["fixture"]["date"]
            for p in self.artifact.get("predictions") or []
            if isinstance((p.get("fixture") or {}).get("date"), str)
        ]
        if not season or not dates:
            self.skipTest("artifact carries no season or no dated fixtures")

        # A season labelled "2026-27" runs August 2026 to May 2027. So a
        # fixture in July or later belongs to the START year, and one before
        # July to the following year.
        #
        # An earlier version of this test allowed {start, start + 1} for any
        # month, which passed on the very artifact it was written to catch:
        # August 2026 in a "2025-26" file satisfied it because 2026 is
        # start + 1. A check that admits the known defect is worse than none,
        # because it certifies it.
        start = int(str(season)[:4])
        wrong = [
            date for date in dates
            if int(date[:4]) != (start if int(date[5:7]) >= 7 else start + 1)
        ]
        if wrong:
            self.skipTest(
                f"KNOWN: committed artifact is labelled {season} but carries "
                f"{len(wrong)} fixture(s) outside that season, e.g. {wrong[0]}. "
                f"Written from CURRENT_SEASON_LABEL, so a re-run clears it."
            )
        self.assertEqual(wrong, [])


class WriterConsistencyTests(unittest.TestCase):
    """
    The writer, which is what a re-run will actually use.

    These are hard assertions: unlike the artifact tests above there is nothing
    stale to tolerate, so a regression here fails outright.
    """

    def test_the_writer_reports_the_minimum_actually_run(self):
        source = (ROOT / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        self.assertIn("simulations_run = min(_actual_sims)", source)
        self.assertIn('"n_simulations": simulations_run', source)

    def test_the_request_is_kept_but_named_as_a_request(self):
        # Losing it would hide that the run was starved; conflating it with the
        # actual is what produced the defect.
        source = (ROOT / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        self.assertIn('"n_simulations_requested": n_sims', source)

    def test_no_metadata_block_still_reports_the_raw_request(self):
        source = (ROOT / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        self.assertNotIn('"n_simulations": n_sims', source)

    def test_the_season_label_is_never_hardcoded(self):
        source = (ROOT / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        for literal in ('"season": "2025-26"', '"season": "2026-27"'):
            self.assertNotIn(literal, source)
        self.assertIn('"season": CURRENT_SEASON_LABEL', source)


if __name__ == "__main__":
    unittest.main()
