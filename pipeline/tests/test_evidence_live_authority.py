"""
A stored copy of FPL's own data must never out-vote the live bootstrap.

The agent resolves the evidence store BEFORE it records the bootstrap it has just
fetched, so every stored tier-1 claim is a copy of an earlier bootstrap. On the
first refresh after FPL changes a flag, that copy used to replace the live value
in `build_fpl_inputs`. Measured on the 2026-10-27T21:08Z refresh: Joao Pedro
(element 165) was i/0 live, resolved to 75 from his stored d/75 under
`tier_precedence`, and was published at 2.78 xP and 49 minutes. And because a
fully fit player records no claim at all, a cleared flag's stale copy kept winning
too (Elanga, 454: live a/100, resolved to 75).

These run the real resolver into the real `build_fpl_inputs`, because the defect
lived in the seam between them: each half was correct on its own terms.

What must NOT change is the manual lane: a fresher tier-2/3 claim may still lower
availability, and may still never raise it.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

import pandas as pd

from pipeline.fpl.rules import load_rules
from pipeline.learning.availability_conflicts import (
    RULE_LIVE,
    RULE_PERMANENCE,
    availability_view,
    live_overrides,
    resolve_claims,
)
from pipeline.learning.availability_evidence import (
    AvailabilityClaim,
    claims_from_bootstrap,
)
from pipeline.learning import evidence_view as V
from pipeline.learning.backfill import load_archive_season
from pipeline.models.fpl_inputs import build_fpl_inputs
from pipeline.models.minutes import is_fit_now

NOW = datetime(2026, 10, 27, 21, 8, tzinfo=timezone.utc)


def _at(hours: float) -> str:
    return (NOW - timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


# One element per scenario, all in one bootstrap so the model is fitted once.
JP, ELANGA, CLEARED, LOWERED, LOWERED_ALONE, RAISED, RAISED_ALONE = range(901, 908)
EXIT_MANUAL, EXIT_STALE = 908, 909

KNEE = "Knee injury - 75% chance of playing"


def _element(element_id, status="a", chance=None, news="", news_added=None):
    return {
        "id": element_id, "code": element_id, "first_name": "Test",
        "second_name": f"Player {element_id}", "web_name": f"P{element_id}",
        "element_type": 4, "team": 1, "status": status,
        "chance_of_playing_next_round": chance, "news": news,
        "news_added": news_added,
    }


def _bootstrap(elements):
    return {
        "teams": [{"id": 1, "name": "Arsenal", "short_name": "ARS"}],
        "element_types": [
            {"id": 1, "singular_name_short": "GKP"},
            {"id": 2, "singular_name_short": "DEF"},
            {"id": 3, "singular_name_short": "MID"},
            {"id": 4, "singular_name_short": "FWD"},
        ],
        "elements": list(elements),
        "events": [],
    }


def _manual(element_id, value, hours_ago, claim_type="chance_of_playing", tier=2):
    return AvailabilityClaim(
        element_id=element_id, source="manual:presser", source_tier=tier,
        claim_type=claim_type, value=value, claimed_at=_at(hours_ago),
        observed_at=_at(hours_ago - 0.5), gameweek=9,
        provenance_digest="deadbeef", source_text="He said so",
    )


# What FPL said when the store last read it. Claimed three days ago (news_added),
# observed eight hours later — the JP shape.
EARLIER = _bootstrap([
    _element(JP, "d", 75, KNEE, _at(77)),
    _element(ELANGA, "d", 75, KNEE, _at(77)),
    _element(CLEARED, "d", 75, KNEE, _at(77)),
    _element(LOWERED, "a", 100, "", _at(77)),
    _element(RAISED, "d", 25, "Hamstring - 25% chance of playing", _at(77)),
    _element(EXIT_MANUAL, "d", 75, KNEE, _at(77)),
    _element(EXIT_STALE, "u", 0, "Has joined Grimsby Town on loan", _at(77)),
])

# What FPL says now. JP's flag changed WITHOUT news_added being restamped.
LIVE = _bootstrap([
    _element(JP, "i", 0, KNEE, _at(77)),
    _element(ELANGA, "a", 100, "", None),
    _element(CLEARED, "a", None, "", None),
    _element(LOWERED, "a", 100, "", _at(77)),
    _element(LOWERED_ALONE, "a", None, "", None),
    _element(RAISED, "d", 25, "Hamstring - 25% chance of playing", _at(77)),
    # Flagged since the store last read him, so no tier-1 claim is on file yet.
    _element(RAISED_ALONE, "i", 0, "Ankle injury - Expected back 30 Nov", _at(1)),
    _element(EXIT_MANUAL, "d", 75, KNEE, _at(77)),
    _element(EXIT_STALE, "a", None, "", None),
])

STORED = (
    claims_from_bootstrap(EARLIER, 9, _at(69))
    + [
        _manual(LOWERED, 25, hours_ago=2),
        _manual(LOWERED_ALONE, 25, hours_ago=2),
        _manual(RAISED, 100, hours_ago=2),
        _manual(RAISED_ALONE, 75, hours_ago=30),
        _manual(EXIT_MANUAL, {"kind": "transfer", "club": "Elsewhere FC"},
                hours_ago=2, claim_type="permanent_exit"),
    ]
)


class LiveBootstrapIsTheAuthorityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.resolutions, cls.escalations = resolve_claims(STORED, now=NOW)
        cls.view = availability_view(cls.resolutions)
        cls.inputs = build_fpl_inputs(
            LIVE, load_archive_season("2526"), rules=load_rules(),
            now=pd.Timestamp(NOW), evidence=cls.view,
        )

    def _state(self, element_id):
        return self.inputs.availability[element_id]

    def test_the_stored_tier1_copy_did_resolve_to_the_stale_value(self):
        """The precondition: without it every test below passes vacuously."""
        self.assertEqual(self.resolutions[(JP, "chance_of_playing")].value, 75)
        self.assertEqual(self.resolutions[(JP, "chance_of_playing")].winning_tier, 1)
        self.assertEqual(self.resolutions[(ELANGA, "chance_of_playing")].value, 75)

    def test_a_flag_worsened_live_is_projected_from_the_live_flag(self):
        """Joao Pedro: stored d/75, live i/0. He was published at 2.78 xP."""
        state = self._state(JP)
        self.assertEqual(state.now, 0.0)
        self.assertEqual(state.evidence_claim_ids, ())

    def test_a_flag_cleared_live_to_a_hundred_is_fully_available(self):
        """Elanga: stored chance 75, live a/100."""
        self.assertEqual(self._state(ELANGA).now, 1.0)
        self.assertTrue(is_fit_now(self._state(ELANGA)))

    def test_a_flag_cleared_to_nothing_is_fully_available(self):
        """
        Live a / None / no news records NO claim, so nothing fresher ever reaches
        the store to outvote the stale d/75 until the staleness horizon.
        """
        self.assertNotIn(CLEARED, {c.element_id for c in claims_from_bootstrap(LIVE, 9, _at(0))})
        self.assertEqual(self._state(CLEARED).now, 1.0)
        self.assertTrue(is_fit_now(self._state(CLEARED)))

    def test_a_fresher_manual_claim_still_lowers_a_fit_player(self):
        for element_id in (LOWERED, LOWERED_ALONE):
            with self.subTest(element_id=element_id):
                state = self._state(element_id)
                self.assertAlmostEqual(state.now, 0.25)
                winner = self.resolutions[(element_id, "chance_of_playing")]
                self.assertEqual(winner.winning_tier, 2)
                self.assertEqual(state.evidence_claim_ids, (winner.winning_claim_id,))

    def test_an_optimistic_manual_claim_still_cannot_raise(self):
        """R4, refused in the resolver: FPL's stored d/25 wins, live is d/25."""
        self.assertAlmostEqual(self._state(RAISED).now, 0.25)

    def test_an_optimistic_manual_claim_cannot_raise_a_flag_not_yet_on_file(self):
        """
        FPL flagged him after the store last read him, so the manual 75 is the
        ONLY claim and R4 had nothing to test its direction against. The live
        field is the authority, so R4's test is applied against it instead.
        """
        resolution = self.resolutions[(RAISED_ALONE, "chance_of_playing")]
        self.assertEqual((resolution.value, resolution.winning_tier), (75, 2))
        self.assertEqual(self._state(RAISED_ALONE).now, 0.0)

    def test_a_manual_departure_still_zeroes_a_player_fpl_has_at_75(self):
        """R6 with a tier-2 exit over a tier-1 chance: a real exit signal."""
        resolution = self.resolutions[(EXIT_MANUAL, "chance_of_playing")]
        self.assertEqual(resolution.rule, RULE_PERMANENCE)
        self.assertEqual(resolution.winning_tier, 2)
        self.assertEqual(self._state(EXIT_MANUAL).now, 0.0)

    def test_a_stale_tier1_departure_does_not_zero_a_player_fpl_now_fields(self):
        """
        A tier-1 exit is our parse of FPL's news; the live news is parsed again in
        `availability_state`, so a stored copy adds nothing but staleness.
        """
        resolution = self.resolutions[(EXIT_STALE, "chance_of_playing")]
        self.assertEqual((resolution.rule, resolution.value), (RULE_PERMANENCE, 0))
        self.assertEqual(self._state(EXIT_STALE).now, 1.0)

    def test_a_tier1_conflict_does_not_mark_the_projection_conflicted(self):
        """The state says the number was made under a conflict; this one was not."""
        for element_id in (JP, ELANGA):
            with self.subTest(element_id=element_id):
                self.assertFalse(self._state(element_id).conflict)


class R6AttributionTests(unittest.TestCase):
    def test_the_exit_wins_and_the_displaced_chance_is_named(self):
        stored_chance = [
            c for c in claims_from_bootstrap(EARLIER, 9, _at(69))
            if c.element_id == EXIT_MANUAL and c.claim_type == "chance_of_playing"
        ]
        departure = _manual(EXIT_MANUAL, {"kind": "loan", "club": "X"},
                            hours_ago=2, claim_type="permanent_exit")
        resolutions, _ = resolve_claims(stored_chance + [departure], now=NOW)
        chance = resolutions[(EXIT_MANUAL, "chance_of_playing")]
        self.assertEqual(chance.winning_claim_id, departure.claim_id)
        accounted = set(chance.conflicts) | {chance.winning_claim_id}
        self.assertTrue({c.claim_id for c in stored_chance} <= accounted)


class LiveOverridesNeverRaisesTests(unittest.TestCase):
    def test_a_malformed_resolution_falls_back_to_the_live_fields(self):
        class Broken:
            value = "not a number"
            winning_tier = 2

        with self.assertLogs("pipeline.learning.availability_conflicts", "WARNING"):
            self.assertEqual(
                live_overrides({"chance_of_playing": Broken()}, "a", None), {}
            )


class EvidenceViewReportsWhatPricedThePlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        resolutions, escalations = resolve_claims(STORED, now=NOW)
        live = {
            int(e["id"]): (e["status"], e["chance_of_playing_next_round"])
            for e in LIVE["elements"]
        }
        cls.view = V.build(STORED, resolutions, escalations, gameweek=9,
                           generated_at=_at(0), live=live)
        cls.players = {p["element_id"]: p for p in cls.view["players"]}

    def _entry(self, element_id, claim_type):
        for entry in self.players[element_id]["entries"]:
            if entry["claim_type"] == claim_type:
                return entry
        self.fail(f"no {claim_type} entry for {element_id}")

    def test_a_stale_copy_is_not_shown_as_the_resolved_value(self):
        entry = self._entry(JP, "chance_of_playing")
        self.assertEqual((entry["resolved_value"], entry["rule"]), (0, RULE_LIVE))
        self.assertEqual({c["verdict"] for c in entry["claims"]}, {"lost"})
        self.assertEqual(self._entry(JP, "status")["resolved_value"], "i")

    def test_a_player_fit_live_is_not_listed_as_flagged(self):
        self.assertNotIn(CLEARED, self.players)

    def test_an_applied_manual_claim_still_shows_as_the_winner(self):
        entry = self._entry(LOWERED, "chance_of_playing")
        self.assertEqual(entry["resolved_value"], 25)
        self.assertNotEqual(entry["rule"], RULE_LIVE)

    def test_without_live_fields_the_view_is_unchanged(self):
        resolutions, escalations = resolve_claims(STORED, now=NOW)
        plain = V.build(STORED, resolutions, escalations, gameweek=9,
                        generated_at=_at(0))
        jp = next(p for p in plain["players"] if p["element_id"] == JP)
        chance = next(e for e in jp["entries"] if e["claim_type"] == "chance_of_playing")
        self.assertEqual(chance["resolved_value"], 75)


if __name__ == "__main__":
    unittest.main()
