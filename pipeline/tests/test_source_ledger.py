"""
What the run says when a source quietly stops delivering.

The bug: `player_events.json` went from 24 August to 8 September without a
refresh. The Understat step catches its own failure by design, so the run stayed
green, and the one warning it did emit sat inside a 5,889-line log that nobody
reads when the tick is green.

Two assertions carry the fix. A source that was expected to deliver and did not
must produce a `::warning::` naming the artifact that goes stale — because
"Understat player events failed" means nothing to a reader who does not know what
consumes it. And a source absent BY DESIGN must never warn, because a warning on
every run is a warning nobody reads, which is how the fortnight happened.
"""
import unittest

from pipeline.source_ledger import SourceLedger, annotations_for


class DeadSource(unittest.TestCase):
    def test_it_warns_and_names_the_artifact_that_goes_stale(self):
        ledger = SourceLedger()
        ledger.failed("understat_player_events", "Understat player events",
                      "source unavailable", publishes="player_events.json")
        lines = annotations_for(ledger.report())
        warnings = [l for l in lines if l.startswith("::warning::")]
        self.assertEqual(len(warnings), 1)
        self.assertIn("Understat player events", warnings[0])
        self.assertIn("player_events.json will not refresh", warnings[0])

    def test_a_source_with_no_artifact_still_warns(self):
        # The Odds API feeds a model rather than publishing a file. Silence still
        # matters; there is just no filename to name.
        ledger = SourceLedger()
        ledger.failed("odds_api", "The Odds API", "no events came back")
        warnings = [l for l in annotations_for(ledger.report())
                    if l.startswith("::warning::")]
        self.assertEqual(len(warnings), 1)
        self.assertIn("the run continued without it", warnings[0])

    def test_it_carries_the_reason_rather_than_just_the_name(self):
        ledger = SourceLedger()
        ledger.failed("team_xg", "Team xG", "no rows")
        self.assertIn("no rows", annotations_for(ledger.report())[0])

    def test_a_reasonless_failure_still_reads_as_a_sentence(self):
        ledger = SourceLedger()
        ledger.failed("team_xg", "Team xG", "")
        self.assertIn("no reason given", annotations_for(ledger.report())[0])


class AbsentByDesign(unittest.TestCase):
    def test_it_never_warns(self):
        """
        The rule the whole distinction exists for. FBref's passing table has no
        provider — the one that offered it capped rich<14 and pinned soccerdata to
        a version that could not read Understat. Warning about that every run
        would make every warning here worthless within a month.
        """
        ledger = SourceLedger()
        ledger.absent_by_design("fbref_passing", "FBref passing", "no provider")
        lines = annotations_for(ledger.report())
        self.assertEqual([l for l in lines if l.startswith("::warning::")], [])

    def test_it_is_named_in_the_notice_rather_than_hidden(self):
        # Not warned about is not the same as not mentioned: a reader should be
        # able to see that the absence is known and intended.
        ledger = SourceLedger()
        ledger.absent_by_design("fbref_passing", "FBref passing", "no provider")
        notice = [l for l in annotations_for(ledger.report())
                  if l.startswith("::notice::")][0]
        self.assertIn("not collected by design", notice)
        self.assertIn("FBref passing", notice)

    def test_it_is_kept_out_of_the_delivered_count(self):
        # A source nobody expects must not flatter the ratio either.
        ledger = SourceLedger()
        ledger.delivered("a", "A")
        ledger.absent_by_design("b", "B", "no provider")
        notice = [l for l in annotations_for(ledger.report())
                  if l.startswith("::notice::")][0]
        self.assertIn("1 of 1 external sources delivered", notice)


class TheNotice(unittest.TestCase):
    def test_it_counts_what_arrived(self):
        ledger = SourceLedger()
        ledger.delivered("a", "A")
        ledger.delivered("b", "B")
        ledger.failed("c", "C", "down")
        notice = [l for l in annotations_for(ledger.report())
                  if l.startswith("::notice::")][0]
        self.assertIn("2 of 3 external sources delivered", notice)

    def test_a_clean_run_emits_a_notice_and_no_warning(self):
        ledger = SourceLedger()
        ledger.delivered("a", "A", "20 teams")
        lines = annotations_for(ledger.report())
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("::notice::"))

    def test_a_run_that_recorded_nothing_says_nothing(self):
        # Silence beats a spurious "0 of 0 sources" on a run that failed before it
        # reached any of them — the same call `run_news.py` makes.
        self.assertEqual(annotations_for({}), [])
        self.assertEqual(annotations_for({"sources": []}), [])


class TheLogTable(unittest.TestCase):
    def test_it_marks_the_three_states_distinctly(self):
        ledger = SourceLedger()
        ledger.delivered("a", "Alive", "20 teams")
        ledger.failed("b", "Broken", "down")
        ledger.absent_by_design("c", "Gone", "no provider")
        table = ledger.table()
        self.assertIn("ok   Alive", table)
        self.assertIn("DEAD Broken", table)
        self.assertIn("--   Gone", table)

    def test_it_says_so_when_nothing_was_recorded(self):
        self.assertIn("no external sources", SourceLedger().table())

    def test_a_detail_is_truncated_rather_than_flooding_the_log(self):
        ledger = SourceLedger()
        ledger.failed("b", "Broken", "x" * 500)
        self.assertLessEqual(len(ledger.outcomes[0].detail), 200)


if __name__ == "__main__":
    unittest.main()
