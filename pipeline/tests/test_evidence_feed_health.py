"""
Reporting how fresh the claim feed is, separately from what it found.

## The failure this closes, measured 2026-09-04

`minutes_conflicts_gw03.json` carried 15 conflicts. Every one traced to an
`x:robtFPL` claim dated 8-13 August — pre-season friendlies, 19 days stale — and
nothing in the artifact or on `/evidence` said so. Meanwhile:

* the launchd job that runs the scan was **not loaded**, and no plist was
  installed in `~/Library/LaunchAgents`;
* `x_inbox.csv` held 13 rows whose newest was 2026-08-16;
* running the scraper by hand returned `ERR_HTTP_RESPONSE_CODE_FAILURE` — X now
  refuses a logged-out browser outright.

So the feed had been dead for three weeks and the surface built on it looked
healthy. The zero-conflict copy is worse than the populated one: it reads "no
projection contradicts the evidence. That is a result, not an absence", which is
exactly false when there is no evidence to contradict anything.

The fix has to come from the producer, not the page: with zero conflicts there
are no `claimed_at` values in the artifact at all, so a consumer cannot tell a
healthy quiet feed from a dead one. `evidence_feed_health` reads the whole inbox
rather than the conflicting subset, which is the only place that distinction
exists.
"""
import unittest

from pipeline.learning.minutes_conflicts import evidence_feed_health, to_artifact


def rows(*dates):
    return [{"claimed_at": d, "value": "text"} for d in dates]


class FeedHealth(unittest.TestCase):
    def test_it_reports_the_newest_claim_across_the_whole_inbox(self):
        health = evidence_feed_health(
            rows("2026-08-08T16:04:48Z", "2026-08-16T11:08:06Z", "2026-08-11T09:00:00Z")
        )
        self.assertEqual(health["newest_claim_at"], "2026-08-16T11:08:06Z")
        self.assertEqual(health["rows"], 3)

    def test_an_empty_inbox_reports_none_rather_than_a_fabricated_date(self):
        health = evidence_feed_health([])
        self.assertIsNone(health["newest_claim_at"])
        self.assertEqual(health["rows"], 0)

    def test_rows_without_a_date_do_not_become_the_newest(self):
        health = evidence_feed_health(rows("2026-08-16T11:08:06Z", "", None))
        self.assertEqual(health["newest_claim_at"], "2026-08-16T11:08:06Z")
        # Still counted: they are rows in the inbox, and a feed of undated rows
        # is a different fault from an empty one.
        self.assertEqual(health["rows"], 3)

    def test_it_does_not_sort_lexically_across_offsets(self):
        # "+00:00" and "Z" are the same instant spelled two ways, and the inbox
        # carries both. A lexical max puts "Z" after "+", which would report the
        # OLDER row as newest.
        health = evidence_feed_health(
            rows("2026-09-01T10:00:00+00:00", "2026-08-01T10:00:00Z")
        )
        self.assertTrue(health["newest_claim_at"].startswith("2026-09-01"))


class ArtifactCarriesIt(unittest.TestCase):
    def test_the_artifact_reports_the_feed_when_given_one(self):
        art = to_artifact([], {}, generated_at="2026-09-04T10:43:31Z",
                          feed=evidence_feed_health(rows("2026-08-16T11:08:06Z")))
        self.assertEqual(art["evidence_feed"]["newest_claim_at"], "2026-08-16T11:08:06Z")
        self.assertEqual(art["evidence_feed"]["rows"], 1)

    def test_an_absent_feed_is_null_rather_than_omitted(self):
        # Omitting the key would make "old producer" and "empty inbox"
        # indistinguishable to the narrower.
        art = to_artifact([], {}, generated_at="2026-09-04T10:43:31Z")
        self.assertIn("evidence_feed", art)
        self.assertIsNone(art["evidence_feed"]["newest_claim_at"])
        self.assertEqual(art["evidence_feed"]["rows"], 0)


if __name__ == "__main__":
    unittest.main()
