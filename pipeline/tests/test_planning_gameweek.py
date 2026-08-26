"""
Which gameweek the pipeline predicts FOR.

FPL keeps an event ``is_current`` from its own deadline until the NEXT one. So for
the days between a gameweek's last match and the following deadline, the current
event names a week already played — and anything forward-looking that trusts it
points at the past.

Measured on 2026-08-26: ``is_current`` was GW1, played five days earlier, while
the squad being priced was GW2's. ``get_upcoming_fixtures`` already rolled past it
and returned GW2's matches, but ``run_pipeline`` stamped ``get_current_gameweek``'s
un-rolled scalar beside them, so every prediction record for GW2's fixtures
carried ``gameweek: 1``.

These are the same cases ``frontend/lib/fpl-live-planning.test.ts`` pins for
``planningEventId``, with the same event ids and deadlines, because the two
functions answer the same question on the two sides of the wire and a silent
disagreement between them is the whole bug class.
"""
import unittest

import pandas as pd

from pipeline.data.fpl_api import get_current_gameweek, planning_gameweek

GW1 = "2026-08-21T17:30:00Z"
GW2 = "2026-08-28T17:30:00Z"
GW3 = "2026-09-04T17:30:00Z"


def event(gw_id, deadline, current=False, next_=False, finished=False):
    """The shape ``bootstrap["events"]`` returns, trimmed to what is read."""
    return {
        "id": gw_id,
        "name": f"Gameweek {gw_id}",
        "deadline_time": deadline,
        "is_current": current,
        "is_next": next_,
        "finished": finished,
    }


SEASON = [
    event(1, GW1, current=True),
    event(2, GW2, next_=True),
    event(3, GW3),
]


def at(when):
    return pd.Timestamp(when)


class TestTheIncident(unittest.TestCase):
    def test_rolls_past_the_current_event_once_its_deadline_has_gone(self):
        # 26 Aug: GW1 played, GW2 not yet locked. The answer must be 2.
        self.assertEqual(
            planning_gameweek({"events": SEASON}, at("2026-08-26T08:35:00Z")), 2
        )

    def test_the_current_gameweek_still_says_one(self):
        # The two functions disagree BY DESIGN at this moment. If this ever passes
        # with 2, `get_current_gameweek` has been "fixed" and every retrospective
        # caller — settling, review — is now reading the wrong week.
        self.assertEqual(get_current_gameweek({"events": SEASON}), 1)

    def test_stays_on_the_current_event_before_its_deadline(self):
        self.assertEqual(
            planning_gameweek({"events": SEASON}, at("2026-08-20T09:00:00Z")), 1
        )

    def test_stays_put_in_the_last_second_before_the_deadline(self):
        self.assertEqual(
            planning_gameweek({"events": SEASON}, at("2026-08-21T17:29:59Z")), 1
        )

    def test_rolls_forward_the_instant_the_deadline_lands(self):
        # FPL locks teams on the second; at the deadline the week is closed.
        self.assertEqual(planning_gameweek({"events": SEASON}, at(GW1)), 2)


class TestWhatItRefusesToGuess(unittest.TestCase):
    def test_does_not_roll_forward_without_a_parseable_deadline(self):
        # No deadline is no evidence the week has closed. Rolling forward here
        # would aim the whole run at a week that may not be next.
        odd = [event(1, "not a date", current=True), event(2, GW2)]
        self.assertEqual(
            planning_gameweek({"events": odd}, at("2026-08-26T08:35:00Z")), 1
        )

    def test_does_not_roll_forward_on_a_missing_deadline(self):
        odd = [event(1, None, current=True), event(2, GW2)]
        self.assertEqual(
            planning_gameweek({"events": odd}, at("2026-08-26T08:35:00Z")), 1
        )

    def test_never_names_a_gameweek_the_season_does_not_contain(self):
        last = [event(38, "2027-05-24T14:00:00Z", current=True)]
        self.assertEqual(
            planning_gameweek({"events": last}, at("2027-06-01T00:00:00Z")), 38
        )

    def test_falls_back_to_one_on_an_empty_season(self):
        # The id becomes a fixture filter and a request path segment; a NaN would
        # be worse than wrong because it fails silently rather than loudly.
        self.assertEqual(planning_gameweek({"events": []}, at(GW2)), 1)
        self.assertEqual(planning_gameweek({}, at(GW2)), 1)


class TestFplsOwnPrecedence(unittest.TestCase):
    def test_uses_is_next_when_no_event_is_current(self):
        between = [
            event(1, GW1, finished=True),
            event(2, GW2, next_=True),
        ]
        # is_next's deadline is still ahead, so it stands.
        self.assertEqual(
            planning_gameweek({"events": between}, at("2026-08-26T08:35:00Z")), 2
        )

    def test_falls_through_to_the_first_unfinished_event(self):
        # Neither flag set — mid-season the API has been seen this way briefly
        # around a deadline.
        flagless = [
            event(1, GW1, finished=True),
            event(2, GW2),
            event(3, GW3),
        ]
        self.assertEqual(
            planning_gameweek({"events": flagless}, at("2026-08-26T08:35:00Z")), 2
        )

    def test_a_naive_deadline_is_read_as_utc_not_local(self):
        # FPL sends a Z suffix, but a cached or hand-edited payload may not. A
        # naive timestamp compared against a tz-aware `now` raises in pandas, so
        # this asserts the localisation rather than the value alone.
        naive = [event(1, "2026-08-21T17:30:00", current=True), event(2, GW2)]
        self.assertEqual(
            planning_gameweek({"events": naive}, at("2026-08-26T08:35:00Z")), 2
        )


if __name__ == "__main__":
    unittest.main()
