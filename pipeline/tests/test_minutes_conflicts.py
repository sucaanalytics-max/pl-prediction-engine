"""
The minutes model versus the evidence already in the repository.

Built from a real, measured disagreement rather than a hypothetical: on the GW1
2026-27 artifact the model gave Gvardiol 14.3 expected minutes and 0.78 xP, while
`predictions/fpl/x_inbox.csv` held a timestamped, attributed post saying he
"played full 90" and "started LB". Both facts lived in this repository and nothing
connected them.

The load-bearing assertions are the ones about what this must NOT do. Its value
depends entirely on a human trusting what it points at, so a guessed player or a
derived minutes figure would be worse than no report.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from pipeline.learning import minutes_conflicts as mc

ROOT = Path(__file__).resolve().parents[2]

#: Two players sharing a surname, so ambiguity has something to refuse.
BOOTSTRAP = {
    "teams": [{"id": 1, "name": "Man City"}, {"id": 2, "name": "Brighton"}],
    "elements": [
        {"id": 10, "second_name": "Gvardiol", "web_name": "Gvardiol", "team": 1,
         "code": 1010},
        {"id": 11, "second_name": "Minteh", "web_name": "Minteh", "team": 2,
         "code": 1011},
        {"id": 12, "second_name": "Wilson", "web_name": "Wilson", "team": 1,
         "code": 1012},
        {"id": 13, "second_name": "Wilson", "web_name": "H.Wilson", "team": 2,
         "code": 1013},
    ],
}

XP = {"players": [
    {"element_id": 10, "e_minutes": 14.3, "xp": 0.78},     # model: will not play
    {"element_id": 11, "e_minutes": 86.0, "xp": 4.9},      # model: nailed on
    {"element_id": 12, "e_minutes": 20.0, "xp": 1.0},
    {"element_id": 13, "e_minutes": 20.0, "xp": 1.0},
]}

HEADER = ("lane,claim_type,value,player_surname,club,tier,source,quote,url,"
          "claimed_at,metric,horizon_gameweeks")


def inbox(text: str, source: str = "x:robtFPL",
          url: str = "https://x.com/robtFPL/status/1", when: str = "2026-08-09T13:17:25Z"):
    """One inbox row in the committed CSV's own shape."""
    safe = text.replace('"', '""')
    return (f"{HEADER}\n"
            f'availability,unparsed_news,"{safe}",,Man City,3,{source},,{url},{when},,')


GVARDIOL = ("Man City summary from the Atletico friendly. Foden, Dias and "
            "Gvardiol played full 90 - Gvardiol started LB and moved inside "
            "second half with Rico Lewis coming on.")


class TheCaseItWasBuiltFrom(unittest.TestCase):
    def test_the_gvardiol_disagreement_is_reported(self):
        conflicts, _ = mc.find_conflicts(XP, inbox(GVARDIOL), BOOTSTRAP)
        found = [c for c in conflicts if c.player == "Gvardiol"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].kind, "fringe-but-discussed")
        self.assertAlmostEqual(found[0].e_minutes, 14.3)

    def test_it_carries_the_verbatim_quote_and_its_url(self):
        # A report a human cannot check is not evidence. Paraphrasing it would
        # make this a second opinion rather than a pointer to the first.
        conflicts, _ = mc.find_conflicts(XP, inbox(GVARDIOL), BOOTSTRAP)
        c = next(x for x in conflicts if x.player == "Gvardiol")
        self.assertIn("played full 90", c.quote)
        self.assertTrue(c.url.startswith("https://"))
        self.assertEqual(c.claimed_at, "2026-08-09T13:17:25Z")
        self.assertEqual(c.source, "x:robtFPL")

    def test_a_player_the_model_expects_to_start_is_not_reported(self):
        # Otherwise every per-club summary reports its whole XI and the signal is
        # gone. Only the disagreement is interesting.
        conflicts, _ = mc.find_conflicts(
            {"players": [{"element_id": 10, "e_minutes": 86.0, "xp": 5.0}]},
            inbox(GVARDIOL), BOOTSTRAP,
        )
        self.assertEqual(conflicts, [])


class ItNeverFabricates(unittest.TestCase):
    """
    The restraint IS the design.

    Turning "played full 90 in a friendly" into an `e_minutes` of 85 needs a fitted
    model of how pre-season minutes predict competitive ones. A regex that reads
    "90" out of a sentence and writes it into a projection would be a fabricated
    number wearing a citation — the exact failure `availability_news.py` earns its
    corpus to avoid, and one that R4 would let push a real player's projection.
    """

    def test_no_minutes_value_is_derived_from_the_text(self):
        conflicts, _ = mc.find_conflicts(XP, inbox(GVARDIOL), BOOTSTRAP)
        c = next(x for x in conflicts if x.player == "Gvardiol")
        # Every number on the record comes from the model, not the sentence. The
        # quote plainly contains "90"; nothing may have adopted it.
        self.assertEqual(c.e_minutes, 14.3)
        self.assertEqual(c.xp, 0.78)
        self.assertIn("90", c.quote)

    def test_the_projection_it_was_given_is_left_untouched(self):
        """
        Behavioural, because the source-text version of this was meaningless.

        My first attempt asserted `"e_minutes ="` never appears in the module — but
        that is exactly how you READ the value into a local, so the test forbade
        correct code while a genuine mutation (`projection["e_minutes"] = 85`)
        would have contained a different string and passed. Comparing the artifact
        before and after tests the property rather than a spelling of it.
        """
        import copy
        artifact = copy.deepcopy(XP)
        before = copy.deepcopy(artifact)
        mc.find_conflicts(artifact, inbox(GVARDIOL), BOOTSTRAP)
        self.assertEqual(artifact, before,
                         "find_conflicts mutated the projection it was given")

    def test_an_ambiguous_surname_is_refused_not_resolved(self):
        """
        441 of 663 surname keys are ambiguous — six Wilsons, six Phillipses.
        Picking one would make the whole report untrustworthy, since its only
        value is that a human can rely on what it points at.
        """
        conflicts, ambiguous = mc.find_conflicts(
            XP, inbox("Wilson started and looked sharp in the friendly."), BOOTSTRAP,
        )
        self.assertEqual([c.player for c in conflicts], [])
        self.assertIn("wilson", ambiguous)
        self.assertEqual(sorted(ambiguous["wilson"]), [12, 13])


class TheInverseCheck(unittest.TestCase):
    """A nailed-on player discussed with injury language is the other failure."""

    def test_a_doubted_starter_is_reported(self):
        conflicts, _ = mc.find_conflicts(
            XP, inbox("Brighton summary. Minteh injury one to keep an eye on."),
            BOOTSTRAP,
        )
        found = [c for c in conflicts if c.player == "Minteh"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].kind, "nailed-but-doubted")

    def test_a_starter_mentioned_without_doubt_is_not_reported(self):
        # Being named in a team-news post is normal for a starter. Only the
        # combination is worth a human's attention.
        conflicts, _ = mc.find_conflicts(
            XP, inbox("Brighton summary. Minteh took the corners as expected."),
            BOOTSTRAP,
        )
        self.assertEqual([c for c in conflicts if c.player == "Minteh"], [])


class Ranking(unittest.TestCase):
    def test_the_widest_disagreement_comes_first(self):
        # Attention is the scarce resource; a 14-minute contradiction outranks a
        # 40-minute one.
        rows = "\n".join([
            inbox(GVARDIOL),
            inbox("Wilson aside, Gvardiol and Minteh both featured.").split("\n", 1)[1],
        ])
        conflicts, _ = mc.find_conflicts(
            {"players": [
                {"element_id": 10, "e_minutes": 14.3, "xp": 0.78},
                {"element_id": 11, "e_minutes": 40.0, "xp": 2.0},
            ]},
            rows, BOOTSTRAP,
        )
        self.assertTrue(conflicts)
        self.assertEqual(conflicts[0].player, "Gvardiol")


class TheArtifact(unittest.TestCase):
    def test_it_states_that_it_never_applies_a_correction(self):
        # Written into the file, because a reader of the JSON should not have to
        # infer the contract from the module that produced it.
        payload = mc.to_artifact([], {}, generated_at="2026-08-13T00:00:00Z")
        self.assertIn("never applied", payload["note"])
        self.assertEqual(payload["schema_version"], 1)

    def test_it_records_the_thresholds_it_judged_against(self):
        # A conflict list is uninterpretable without the line that produced it.
        payload = mc.to_artifact([], {}, generated_at="2026-08-13T00:00:00Z")
        self.assertEqual(payload["thresholds"]["fringe_minutes"], mc.FRINGE_MINUTES)
        self.assertEqual(payload["thresholds"]["nailed_minutes"], mc.NAILED_MINUTES)

    def test_it_round_trips_as_json(self):
        conflicts, ambiguous = mc.find_conflicts(XP, inbox(GVARDIOL), BOOTSTRAP)
        payload = mc.to_artifact(conflicts, ambiguous,
                                 generated_at="2026-08-13T00:00:00Z")
        again = json.loads(json.dumps(payload))
        self.assertEqual(again["conflicts"][0]["player"], "Gvardiol")


class Degenerate(unittest.TestCase):
    def test_an_empty_inbox_is_not_an_error(self):
        self.assertEqual(mc.find_conflicts(XP, "", BOOTSTRAP), ([], {}))

    def test_a_player_with_no_projection_is_skipped(self):
        # The scan covers the whole league; the artifact covers one gameweek.
        conflicts, _ = mc.find_conflicts({"players": []}, inbox(GVARDIOL), BOOTSTRAP)
        self.assertEqual(conflicts, [])


class AgainstTheRealData(unittest.TestCase):
    """
    Run against what is actually committed, so this cannot pass on fixtures alone.

    Skips rather than fails when the artifact is absent: `xp_gw01.json` is written
    by the daily pipeline and a fresh clone does not have it.
    """

    def setUp(self):
        self.xp_path = ROOT / "predictions" / "fpl" / "xp_gw01.json"
        self.inbox_path = ROOT / "predictions" / "fpl" / "x_inbox.csv"
        self.boot_path = ROOT / "data" / "raw" / "fpl" / "bootstrap_static.json"
        if not all(p.is_file() for p in
                   (self.xp_path, self.inbox_path, self.boot_path)):
            self.skipTest("no local pipeline artifacts")

    def test_it_finds_the_gvardiol_conflict_in_the_committed_data(self):
        conflicts, _ = mc.find_conflicts(
            json.loads(self.xp_path.read_text(encoding="utf-8")),
            self.inbox_path.read_text(encoding="utf-8"),
            json.loads(self.boot_path.read_text(encoding="utf-8")),
        )
        names = {c.player for c in conflicts}
        self.assertIn(
            "Gvardiol", names,
            "the disagreement this module exists for is no longer detected",
        )

    def test_every_reported_quote_really_names_its_player(self):
        # The one inference this makes is surname resolution. If a report line's
        # quote does not contain the player it names, the pointer is wrong and the
        # whole artifact is untrustworthy.
        from pipeline.data.news_extract import fold
        conflicts, _ = mc.find_conflicts(
            json.loads(self.xp_path.read_text(encoding="utf-8")),
            self.inbox_path.read_text(encoding="utf-8"),
            json.loads(self.boot_path.read_text(encoding="utf-8")),
        )
        self.assertTrue(conflicts, "no conflicts to check")
        for c in conflicts:
            surname = fold(c.player).split(".")[-1]
            self.assertIn(surname[:5], fold(c.quote),
                          f"{c.player} is not named in the quote cited for them")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
