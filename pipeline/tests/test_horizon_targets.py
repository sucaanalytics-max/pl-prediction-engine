"""Which gameweeks the horizon covers.

The shipped defect: the loop began at `offset 0` and `break`d when a target week
had no unplayed fixtures. Once the current gameweek's matches finished, `weeks`
came back empty, `len(weeks) < 2` returned None, and weeks 1-7 — which DID have
fixtures — were discarded with it. Between the last match of GW N and the deadline
of GW N+1, which is most of a week, the horizon was None by construction.
"""
import unittest

from pipeline.learning.run_agent import horizon_targets


def fixture(event, finished):
    return {"event": event, "finished": finished, "team_h": 1, "team_a": 2}


class HorizonTargets(unittest.TestCase):
    def test_all_weeks_unplayed_gives_the_full_horizon(self):
        raw = [fixture(gw, False) for gw in range(1, 12)]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2, 3, 4, 5, 6, 7, 8])

    def test_a_finished_current_week_is_skipped_not_fatal(self):
        # THE REGRESSION. GW1 played out; GW2-9 are still to come.
        raw = [fixture(1, True)] + [fixture(gw, False) for gw in range(2, 12)]
        self.assertEqual(horizon_targets(raw, 1, 8), [2, 3, 4, 5, 6, 7, 8, 9])

    def test_a_partly_finished_week_still_counts(self):
        raw = [fixture(1, True), fixture(1, False)] + [
            fixture(gw, False) for gw in range(2, 6)
        ]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2, 3, 4, 5])

    def test_it_stops_at_the_end_of_the_published_schedule(self):
        # Past GW3 nothing is scheduled. Padding with zeros would tell the
        # optimiser every player blanks, so stopping is correct.
        raw = [fixture(gw, False) for gw in (1, 2, 3)]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2, 3])

    def test_a_genuinely_blank_week_stops_the_horizon(self):
        # GW3 has no fixtures at all; GW4 does. The horizon stops rather than
        # jumping the gap, because a squad cannot be planned across a week the
        # optimiser has no view of.
        raw = [fixture(1, False), fixture(2, False), fixture(4, False)]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2])

    def test_eval_horizon_caps_the_length(self):
        raw = [fixture(gw, False) for gw in range(1, 20)]
        self.assertEqual(len(horizon_targets(raw, 1, 8)), 8)

    def test_every_week_finished_returns_empty(self):
        raw = [fixture(gw, True) for gw in range(1, 5)]
        self.assertEqual(horizon_targets(raw, 1, 8), [])

    def test_fixtures_with_no_event_are_ignored(self):
        # FPL leaves `event` null on unscheduled fixtures.
        raw = [fixture(None, False), fixture(1, False), fixture(2, False)]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2])
