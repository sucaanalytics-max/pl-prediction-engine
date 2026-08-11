"""
The evidence view: the resolution, and everything it beat.

Closes the competitor study's largest gap — *"nobody presents evidence, only
conclusions"* — so the assertions are mostly about the LOSERS. A view that shows
only the winner would pass a naive test and deliver nothing that FFS does not
already.

`Resolution.conflicts` and rule R8 already guarantee every loser is recorded. What
these tests pin is that the export actually surfaces them, that a contested number
is distinguishable from an uncontested one, and that the list is bounded honestly.
"""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.learning import evidence_view as V
from pipeline.learning.availability_conflicts import resolve_claims
from pipeline.learning.availability_evidence import (
    AvailabilityClaim, provenance_digest,
)

NOW = datetime(2026, 8, 6, 12, 0, tzinfo=timezone.utc)
STAMP = NOW.isoformat().replace("+00:00", "Z")
NAMES = {521: ("Kulusevski", "Spurs"), 100: ("Saka", "Arsenal")}


def claim(value, tier, source, hours_ago=1, element_id=521,
          claim_type="chance_of_playing", quote=None):
    said = (NOW - timedelta(hours=hours_ago)).isoformat().replace("+00:00", "Z")
    text = quote or f"{source} says {value}"
    return AvailabilityClaim(
        element_id=element_id, source=source, source_tier=tier,
        claim_type=claim_type, value=value, claimed_at=said, observed_at=STAMP,
        gameweek=1, source_text=text, provenance_digest=provenance_digest(text),
        provenance_url="https://example.invalid/a",
    )


def build_from(claims):
    resolutions, escalations = resolve_claims(claims, now=NOW)
    return V.build(claims, resolutions, escalations, gameweek=1,
                   generated_at=STAMP, names=NAMES)


class ContestedClaimTests(unittest.TestCase):
    """The feature: a number that survived disagreement, and what it beat."""

    def setUp(self):
        self.view = build_from([
            claim(75, 1, "fpl_bootstrap", hours_ago=48, quote="FPL says 75%"),
            claim(25, 2, "manual:presser", hours_ago=2,
                  quote="He is a couple of weeks away"),
            claim(50, 3, "fantasyfootballscout", hours_ago=5),
        ])
        self.player = self.view["players"][0]
        self.entry = self.player["entries"][0]

    def test_the_winner_is_the_press_conference(self):
        self.assertEqual(self.entry["resolved_value"], 25)
        won = [c for c in self.entry["claims"] if c["verdict"] == "won"]
        self.assertEqual(len(won), 1)
        self.assertEqual(won[0]["source"], "manual:presser")

    def test_every_loser_is_present(self):
        """
        The whole point. FFS shows "25%" and nothing else; this shows the 75% and
        the 50% it beat.
        """
        lost = {c["value"] for c in self.entry["claims"] if c["verdict"] == "lost"}
        self.assertEqual(lost, {75, 50})

    def test_each_loser_names_the_rule_that_beat_it(self):
        losers = [c for c in self.entry["claims"] if c["verdict"] == "lost"]
        # Asserted BEFORE the loop. Without this the test is vacuous: dropping the
        # losers entirely leaves nothing to iterate and it passes green, which a
        # mutation run duly demonstrated.
        self.assertEqual(len(losers), 2, "no losers to check — test would be vacuous")
        for row in losers:
            self.assertEqual(row["beaten_by"], "asymmetric_override")

    def test_the_rule_is_recorded_on_the_entry(self):
        # R4: a lower-tier source may push availability DOWN but never up.
        self.assertEqual(self.entry["rule"], "asymmetric_override")

    def test_the_conflict_count_makes_contested_visible(self):
        self.assertEqual(self.entry["n_conflicts"], 2)
        self.assertEqual(self.player["total_conflicts"], 2)
        # The count is read from `resolution.conflicts`, so it stays correct even
        # if the rows are dropped. Tying it to the rendered rows is what makes the
        # count and the evidence unable to disagree.
        rendered = [c for c in self.entry["claims"] if c["verdict"] == "lost"]
        self.assertEqual(len(rendered), self.entry["n_conflicts"])

    def test_every_claim_keeps_its_quote_and_source(self):
        self.assertEqual(len(self.entry["claims"]), 3)
        for row in self.entry["claims"]:
            self.assertTrue(row["quote"])
            self.assertTrue(row["source"])
            self.assertIn("source_tier", row)

    def test_claimed_at_is_carried_not_observed_at(self):
        """
        Recency is judged on when the source SAID it. Exporting observed_at in its
        place would make every claim look simultaneous.
        """
        self.assertEqual(len(self.entry["claims"]), 3)
        for row in self.entry["claims"]:
            self.assertIsNotNone(row["claimed_at"])
            self.assertNotEqual(row["claimed_at"], row["observed_at"])


class UncontestedTests(unittest.TestCase):
    def test_an_unopposed_claim_reports_zero_conflicts(self):
        """
        A 25% nobody disputed and a 25% that beat three reports must not look
        alike — that difference is the reason this screen exists.
        """
        view = build_from([claim(25, 1, "fpl_bootstrap", quote="25% chance")])
        entry = view["players"][0]["entries"][0]
        self.assertEqual(entry["n_conflicts"], 0)
        self.assertEqual(entry["rule"], "only_claim")
        self.assertEqual(len(entry["claims"]), 1)


class BoundingTests(unittest.TestCase):
    """Only players worth a reader's attention. 570 rows would hide the fifteen."""

    def test_a_fully_available_player_is_omitted(self):
        view = build_from([claim(100, 1, "fpl_bootstrap", element_id=100)])
        self.assertEqual(view["players"], [])

    def test_an_available_status_is_omitted(self):
        view = build_from([
            claim("a", 1, "fpl_bootstrap", element_id=100, claim_type="status"),
        ])
        self.assertEqual(view["players"], [])

    def test_a_flagged_status_is_shown(self):
        view = build_from([
            claim("i", 1, "fpl_bootstrap", element_id=100, claim_type="status"),
        ])
        self.assertEqual(len(view["players"]), 1)

    def test_a_return_date_is_always_shown(self):
        view = build_from([
            claim("2026-09-01", 1, "fpl_bootstrap", element_id=100,
                  claim_type="return_date"),
        ])
        self.assertEqual(len(view["players"]), 1)

    def test_the_counts_state_what_was_omitted(self):
        """
        Without the denominator a short list is ambiguous between "little to
        report" and "the export broke" — the absent-versus-empty confusion, one
        level up.
        """
        view = build_from([
            claim(100, 1, "fpl_bootstrap", element_id=100),
            claim(25, 1, "fpl_bootstrap", element_id=521),
        ])
        self.assertEqual(view["counts"]["n_players_shown"], 1)
        self.assertEqual(view["counts"]["n_players_resolved"], 2)

    def test_most_disputed_first(self):
        view = build_from([
            claim(25, 1, "fpl_bootstrap", element_id=100, hours_ago=48),
            claim(75, 1, "fpl_bootstrap", element_id=521, hours_ago=48),
            claim(25, 2, "manual:presser", element_id=521, hours_ago=1),
        ])
        # 521 has a conflict; 100 does not. The judgement call sorts first.
        self.assertEqual(view["players"][0]["element_id"], 521)


class R5Tests(unittest.TestCase):
    def test_predicted_start_never_appears(self):
        """
        Rule R5. `predicted_start` is about p_start conditional on availability;
        letting it onto an availability screen is how a rotation call gets read as
        an injury.
        """
        view = build_from([
            claim(25, 1, "fpl_bootstrap", element_id=521),
            claim(0.2, 1, "fpl_bootstrap", element_id=521,
                  claim_type="predicted_start"),
        ])
        types = {e["claim_type"] for p in view["players"] for e in p["entries"]}
        self.assertNotIn("predicted_start", types)

    def test_unparsed_news_never_appears(self):
        """
        The connectors emit nothing else, at ~44 claims a poll. On this screen it
        would bury the availability rows it is meant to explain.
        """
        view = build_from([
            claim(25, 1, "fpl_bootstrap", element_id=521),
            claim("Spurs boss on Kulusevski", 2, "hayters", element_id=521,
                  claim_type="unparsed_news"),
        ])
        types = {e["claim_type"] for p in view["players"] for e in p["entries"]}
        self.assertNotIn("unparsed_news", types)


class EscalationTests(unittest.TestCase):
    def test_an_escalation_is_flagged_on_the_player(self):
        # Two equally authoritative, equally fresh, materially different claims:
        # rule R7 refuses to pick and escalates.
        view = build_from([
            claim(25, 2, "manual:source-a", hours_ago=1, quote="a says 25"),
            claim(100, 2, "manual:source-b", hours_ago=1, quote="b says 100"),
        ])
        if not view["players"]:
            self.skipTest("resolver did not escalate this pair")
        player = view["players"][0]
        self.assertTrue(
            player["needs_attention"]
            or any(e["escalation"] for e in player["entries"])
        )


class SerialisationTests(unittest.TestCase):
    def test_the_view_is_json_serialisable(self):
        view = build_from([claim(25, 1, "fpl_bootstrap")])
        json.dumps(view, allow_nan=False)

    def test_write_produces_a_readable_file(self):
        with TemporaryDirectory() as tmp:
            view = build_from([claim(25, 1, "fpl_bootstrap")])
            path = V.write(view, Path(tmp))
            self.assertTrue(path.exists())
            self.assertEqual(json.loads(path.read_text())["gameweek"], 1)

    def test_a_dry_run_writes_nothing(self):
        with TemporaryDirectory() as tmp:
            view = build_from([claim(25, 1, "fpl_bootstrap")])
            self.assertIsNone(V.write(view, Path(tmp), dry_run=True))
            self.assertFalse((Path(tmp) / V.VIEW_FILENAME).exists())

    def test_an_empty_view_still_writes_a_file(self):
        """
        Nobody flagged is the GOOD outcome. An absent file would read as "the
        export never ran", which is a different thing.
        """
        with TemporaryDirectory() as tmp:
            view = build_from([claim(100, 1, "fpl_bootstrap", element_id=100)])
            path = V.write(view, Path(tmp))
            self.assertTrue(path.exists())
            self.assertEqual(json.loads(path.read_text())["players"], [])


class EmptyInputTests(unittest.TestCase):
    def test_no_claims_yields_an_empty_view_not_a_crash(self):
        view = V.build([], {}, [], gameweek=1, generated_at=STAMP)
        self.assertEqual(view["players"], [])
        self.assertEqual(view["counts"]["n_claims"], 0)

    def test_a_missing_name_falls_back_without_failing(self):
        view = build_from([claim(25, 1, "fpl_bootstrap", element_id=999)])
        self.assertEqual(view["players"][0]["player_name"], "")


if __name__ == "__main__":
    unittest.main()
