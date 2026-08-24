"""The dashboard serves one entry. The two bot entries moved to another project."""
import unittest

from pipeline.config import FPL_ENTRIES


class OneEntryOnly(unittest.TestCase):
    def test_exactly_one_entry(self):
        self.assertEqual(list(FPL_ENTRIES), ["owner"])

    def test_it_is_the_owner_s_team(self):
        self.assertEqual(FPL_ENTRIES["owner"]["entry_id"], 20945)

    def test_the_objective_is_season(self):
        # The weekly objective is gated on a calibrated field model that does not
        # exist, so it silently fell back to season on every run. One entry on the
        # season objective means the gate at run_decide.py:298 never fires.
        self.assertEqual(FPL_ENTRIES["owner"]["objective"], "season")

    def test_no_entry_carries_the_weekly_objective(self):
        self.assertNotIn(
            "weekly", [e["objective"] for e in FPL_ENTRIES.values()]
        )

    def test_the_bot_entries_are_gone(self):
        ids = {e["entry_id"] for e in FPL_ENTRIES.values()}
        self.assertNotIn(2561567, ids)  # Ronny
        self.assertNotIn(2561099, ids)  # Wazza
