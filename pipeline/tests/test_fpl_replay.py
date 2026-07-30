"""
The replay oracle as an acceptance test.

This is the only check on the constants the FPL API does not publish: the
``saves ÷ 3`` and ``goals conceded ÷ 2`` divisors, the 60-minute threshold, and
the two Defensive Contribution thresholds with their position-dependent counted
action sets. ``verify_against_bootstrap`` cannot see any of them.

It runs on committed data, so it works pre-season and needs no network.
"""
import unittest

from pipeline.fpl.replay import replay_season

# Pre-registered acceptance criterion from the build plan. The observed rate is
# 1.000; the bar is set slightly below so that a genuine upstream data revision
# in a handful of rows reports rather than fails the build.
MINIMUM_EXACT_RATE = 0.999


class ReplayOracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Scoring ~57,000 rows twice is a second or so; do it once.
        cls.current = replay_season("2526")
        cls.previous = replay_season("2425")

    def test_prior_season_reproduces_every_settled_score(self):
        self.assertGreaterEqual(
            self.current.exact_rate,
            MINIMUM_EXACT_RATE,
            f"{self.current.summary()}; first mismatches: "
            f"{self.current.mismatches[:5]}",
        )

    def test_prior_season_corpus_is_the_expected_size(self):
        """Guards against a truncated archive quietly making the test easy."""
        self.assertGreater(self.current.n_scoreable, 29_000)

    def test_defensive_contribution_counted_set_is_verified_independently(self):
        """
        Recomputing the action count from CBI, tackles and recoveries under each
        position must reproduce the archive's own precomputed
        ``defensive_contribution`` column. This confirms that recoveries count
        for midfielders and forwards but not defenders, and that goalkeepers
        never accumulate any — none of which is machine-readable.
        """
        self.assertGreater(self.current.defcon_rows_checked, 29_000)
        self.assertEqual(self.current.defcon_agreement_rate, 1.0)

    def test_every_mismatch_is_attributed_to_a_named_cause(self):
        unexplained = [
            cause
            for cause in self.current.causes
            if cause.startswith("unexplained_")
        ]
        self.assertEqual(unexplained, [], f"causes: {dict(self.current.causes)}")

    def test_no_rows_are_skipped_for_an_unrecognised_position(self):
        """
        The archive says "GK" where the API says "GKP". Before that alias existed
        this silently skipped 3,427 rows — 11.5% of the corpus — while still
        reporting a 99.996% pass rate on the remainder.
        """
        unknown = [
            cause
            for cause in self.current.causes
            if cause.startswith("unknown_position")
        ]
        self.assertEqual(unknown, [], f"causes: {dict(self.current.causes)}")

    def test_older_season_also_replays_exactly(self):
        """
        2024-25 predates defensive contribution, so this exercises the scoring
        function with that term structurally absent.
        """
        self.assertGreaterEqual(
            self.previous.exact_rate,
            MINIMUM_EXACT_RATE,
            f"{self.previous.summary()}; first mismatches: "
            f"{self.previous.mismatches[:5]}",
        )

    def test_retired_positions_are_excluded_visibly_not_silently(self):
        """
        2024-25 carries 322 Assistant Manager rows. That chip no longer exists —
        every mng_* key in game_config.scoring is 0 — so they are unscoreable
        under current rules and must be reported as excluded rather than counted
        as passes or lumped in with unrecognised labels.
        """
        self.assertGreater(self.previous.n_retired_position, 300)
        self.assertNotIn("AM", "".join(self.previous.causes))


if __name__ == "__main__":
    unittest.main()
