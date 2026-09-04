"""
Aggregating Understat's match rows into a team attack/defence view.

## Why Understat and not FBref

Measured 2026-09-04, on this machine: `fbrefdata` will not install (every version
caps at Python <3.13; the venv is 3.14.4), and `soccerdata`'s FBref reader raises
`AttributeError: 'FBref' object has no attribute '_driver'` at
`_common.py:645` before any request goes out. So both routes to FBref are dead
locally and only fixtures could test them. Understat's `read_team_match_stats`
returns 20 rows for 2026-27 here, carries for-and-against in a single row, and is
a second, independent xG model — which is what makes a "where do we disagree"
diagnostic worth reading at all.

## What these tests actually guard

1. **The home/away flip.** Each row holds both clubs. Reading `home_np_xg` as
   "this team's attack" is right for the home side and exactly backwards for the
   away side, and the bug is invisible in aggregate: the league totals come out
   identical either way. So the fixtures below give the two clubs different
   values and assert the attribution, not the sum.
2. **Shrinkage at the boundaries.** n=0 must return the league mean and never
   divide by zero; n=k must land halfway; large n must approach the raw rate.
3. **The rank gate.** A club under `min_matches_for_rank` gets no rank. Shrinkage
   alone still yields an ordering, and an ordering is what a reader takes off the
   page whatever interval sits beside it.

No network: `build_team_view` takes rows, so the fetch is somebody else's problem.
"""
import unittest

from pipeline.learning.team_view import (
    aggregate_matches, build_team_view, shrink,
)


def rows():
    """Two matches, shaped like `fetch_fbref_match_stats` after reset_index()."""
    return [
        {
            "home_team": "Liverpool", "away_team": "Coventry City",
            "home_np_xg": 2.4, "away_np_xg": 0.3,
            "home_xg": 2.4, "away_xg": 0.3,
            "home_deep_completions": 14, "away_deep_completions": 2,
            "home_goals": 3, "away_goals": 0,
            "home_ppda": 7.1, "away_ppda": 19.4,
        },
        {
            "home_team": "Coventry City", "away_team": "Liverpool",
            "home_np_xg": 0.7, "away_np_xg": 1.8,
            "home_xg": 0.7, "away_xg": 1.8,
            "home_deep_completions": 4, "away_deep_completions": 11,
            "home_goals": 1, "away_goals": 2,
            "home_ppda": 17.2, "away_ppda": 8.3,
        },
    ]


class Shrink(unittest.TestCase):
    def test_no_evidence_returns_the_league_mean(self):
        self.assertEqual(shrink(raw=9.9, n=0, league_mean=1.5, k=6.0), 1.5)

    def test_n_equal_to_k_lands_halfway(self):
        self.assertAlmostEqual(shrink(raw=3.0, n=6, league_mean=1.0, k=6.0), 2.0)

    def test_lots_of_evidence_approaches_the_raw_rate(self):
        self.assertAlmostEqual(
            shrink(raw=3.0, n=600, league_mean=1.0, k=6.0), 2.980198, places=5,
        )

    def test_a_zero_k_trusts_the_club_completely(self):
        self.assertAlmostEqual(shrink(raw=3.0, n=1, league_mean=1.0, k=0.0), 3.0)


class Aggregate(unittest.TestCase):
    def test_it_attributes_the_home_and_away_sides_correctly(self):
        agg = aggregate_matches(rows())
        # Liverpool: 2.4 at home for, 1.8 away for -> 4.2 for; 0.3 + 0.7 against.
        self.assertAlmostEqual(agg["Liverpool"]["np_xg_for"], 4.2)
        self.assertAlmostEqual(agg["Liverpool"]["np_xg_against"], 1.0)
        # Coventry is the mirror, which a sum-only test could not tell apart.
        self.assertAlmostEqual(agg["Coventry City"]["np_xg_for"], 1.0)
        self.assertAlmostEqual(agg["Coventry City"]["np_xg_against"], 4.2)

    def test_it_counts_matches_per_club(self):
        agg = aggregate_matches(rows())
        self.assertEqual(agg["Liverpool"]["matches"], 2)
        self.assertEqual(agg["Coventry City"]["matches"], 2)

    def test_ppda_is_the_clubs_own_pressing_not_a_conceded_figure(self):
        agg = aggregate_matches(rows())
        # Liverpool pressed at 7.1 and 8.3 -> mean 7.7, not the opponent's 19.4.
        self.assertAlmostEqual(agg["Liverpool"]["ppda"], (7.1 + 8.3) / 2)

    def test_a_row_missing_a_metric_does_not_invent_a_zero(self):
        thin = rows()
        del thin[0]["home_deep_completions"]
        agg = aggregate_matches(thin)
        # One of Liverpool's two matches had the field; the total is that one.
        self.assertAlmostEqual(agg["Liverpool"]["deep_completions_for"], 11)
        self.assertEqual(agg["Liverpool"]["deep_completions_observations"], 1)

    def test_an_empty_input_is_empty_rather_than_an_error(self):
        self.assertEqual(aggregate_matches([]), {})


class BuildTeamView(unittest.TestCase):
    def test_it_reports_the_shrunk_rate_and_the_raw_one(self):
        view = build_team_view(rows(), k=6.0, min_matches=1)
        lfc = next(t for t in view["teams"] if t["team"] == "Liverpool")
        self.assertAlmostEqual(lfc["np_xg_for_per_match"], 2.1)
        # Shrunk toward the league mean, so strictly between the two.
        self.assertLess(lfc["np_xg_for_shrunk"], 2.1)
        self.assertGreater(lfc["np_xg_for_shrunk"], view["league"]["np_xg_for_per_match"])

    def test_a_club_under_the_threshold_gets_no_rank(self):
        view = build_team_view(rows(), k=6.0, min_matches=3)
        for team in view["teams"]:
            self.assertIsNone(team["attack_rank"], team["team"])
            self.assertTrue(team["below_match_threshold"])

    def test_above_the_threshold_ranks_are_dense_and_start_at_one(self):
        view = build_team_view(rows(), k=6.0, min_matches=1)
        ranks = sorted(t["attack_rank"] for t in view["teams"])
        self.assertEqual(ranks, [1, 2])

    def test_the_better_attack_ranks_first(self):
        view = build_team_view(rows(), k=6.0, min_matches=1)
        best = min(view["teams"], key=lambda t: t["attack_rank"])
        self.assertEqual(best["team"], "Liverpool")

    def test_the_header_records_what_it_was_built_from(self):
        view = build_team_view(rows(), k=6.0, min_matches=1)
        self.assertEqual(view["source"], "understat:read_team_match_stats")
        self.assertEqual(view["shrinkage_k"], 6.0)
        self.assertEqual(view["min_matches_for_rank"], 1)
        self.assertEqual(view["n_matches"], 2)
        self.assertIn("generated_at", view)

    def test_it_says_plainly_that_it_feeds_nothing(self):
        # The one claim the page's honesty rests on, asserted rather than
        # left to a comment someone can delete.
        self.assertFalse(build_team_view(rows(), k=6.0, min_matches=1)["model_input"])


if __name__ == "__main__":
    unittest.main()
