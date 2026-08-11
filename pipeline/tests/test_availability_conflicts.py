"""
Tests for availability conflict resolution — one per rule, named for the rule.

Named for the rule rather than the function because the rules are the
specification: a test called ``test_R4_...`` that fails tells you which decision
changed, whereas ``test_resolve_claims_3`` tells you nothing.

The governing asymmetry under test: FPL is slow to flag and fast to clear, so the
dangerous error is fielding someone who is out. But the deeper asymmetry is
evidence quality — "he's out" from a manager is near-certain, while "he's in
contention" is a probability a third party cannot calibrate. Hence R4: a
lower-tier source may push availability DOWN but never up.
"""
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.learning.availability_conflicts import (
    RULE_ASYMMETRIC,
    RULE_ASYMMETRIC_REFUSED,
    RULE_ONLY_CLAIM,
    RULE_PERMANENCE,
    RULE_RECENCY,
    RULE_STALE,
    RULE_TIER,
    RULE_UNRESOLVED,
    availability_view,
    resolve_claims,
    summarise,
)
from pipeline.learning.availability_evidence import AvailabilityClaim

NOW = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)


def _at(hours: float) -> str:
    """A timestamp `hours` before NOW."""
    return (NOW - timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


def _claim(**overrides) -> AvailabilityClaim:
    payload = {
        "element_id": 1,
        "source": "fpl_bootstrap",
        "source_tier": 1,
        "claim_type": "chance_of_playing",
        "value": 75,
        "claimed_at": _at(24),
        "observed_at": _at(1),
        "gameweek": 1,
    }
    payload.update(overrides)
    # Tier 2+ needs provenance to be valid at all (R0), so supply it by default
    # rather than making every test remember.
    if payload["source_tier"] >= 2 and "provenance_digest" not in payload:
        payload["provenance_digest"] = "deadbeef"
    return AvailabilityClaim(**payload)


def _one(claims, element_id=1, claim_type="chance_of_playing"):
    resolutions, escalations = resolve_claims(claims, now=NOW)
    return resolutions[(element_id, claim_type)], escalations


class R0ValidityTests(unittest.TestCase):
    def test_a_claim_made_after_it_was_observed_is_dropped(self):
        """
        Impossible, and the check that stops an old article outranking a newer club
        update: a source cannot have published after we read it.
        """
        good = _claim(value=75)
        bad = _claim(value=10, claimed_at=_at(-48), source="manual:presser")
        resolution, _ = _one([good, bad])
        self.assertEqual(resolution.value, 75)
        self.assertEqual(len(resolution.dropped), 1)
        self.assertIn("claimed after it was observed", resolution.dropped[0])

    def test_an_out_of_domain_chance_is_dropped(self):
        for value in (-5, 150, "seventy"):
            with self.subTest(value=value):
                resolution, _ = _one([_claim(value=75), _claim(value=value,
                                                              source="other")])
                self.assertEqual(resolution.value, 75)
                self.assertTrue(resolution.dropped)

    def test_a_tier_two_claim_without_provenance_is_dropped(self):
        """An unauditable claim that can move a projection is worse than no claim."""
        unauditable = AvailabilityClaim(
            element_id=1, source="manual:presser", source_tier=2,
            claim_type="chance_of_playing", value=10,
            claimed_at=_at(1), observed_at=_at(0), gameweek=1,
        )
        resolution, _ = _one([_claim(value=75), unauditable])
        self.assertEqual(resolution.value, 75)
        self.assertTrue(any("provenance" in d for d in resolution.dropped))

    def test_a_malformed_date_claim_is_dropped(self):
        resolution, _ = _one(
            [_claim(claim_type="return_date", value="soon")],
            claim_type="return_date",
        )
        self.assertIsNone(resolution.value)
        self.assertEqual(resolution.rule, "all_claims_invalid")

    def test_all_claims_invalid_still_produces_a_record(self):
        """
        "Everything this source sent was malformed" must be visible rather than
        looking like silence.
        """
        resolutions, _ = resolve_claims(
            [_claim(claim_type="return_date", value="nonsense")], now=NOW
        )
        self.assertIn((1, "return_date"), resolutions)
        self.assertEqual(resolutions[(1, "return_date")].rule, "all_claims_invalid")


class R1StalenessTests(unittest.TestCase):
    def test_a_fresh_lower_tier_claim_beats_a_stale_official_one(self):
        """
        Staleness outranks tier. Reuses minutes.news_staleness_days so the system
        has one staleness concept, not two that can drift apart.
        """
        stale = _claim(value=75, claimed_at=_at(24 * 40))
        fresh = _claim(value=10, claimed_at=_at(2), source="manual:presser",
                       source_tier=2)
        resolution, _ = _one([stale, fresh])
        self.assertEqual(resolution.value, 10)
        self.assertEqual(resolution.rule, RULE_STALE)
        self.assertIn(stale.claim_id, resolution.conflicts)

    def test_everything_stale_still_resolves_rather_than_returning_nothing(self):
        """
        A stale answer beats no answer.

        Gap kept below the material-disagreement threshold on purpose. An earlier
        version used 75 against 50 — exactly 25 apart, which IS material — so it
        escalated conservatively to 50 and the test failed while the code was
        right. Isolate one rule per test.
        """
        resolution, escalations = _one([
            _claim(value=75, claimed_at=_at(24 * 40)),
            _claim(value=70, claimed_at=_at(24 * 50), source="other"),
        ])
        self.assertEqual(resolution.value, 75)
        self.assertEqual(escalations, [])

    def test_two_stale_sources_far_apart_still_escalate(self):
        """Staleness does not exempt a material disagreement from being reported."""
        resolution, escalations = _one([
            _claim(value=75, claimed_at=_at(24 * 40)),
            _claim(value=50, claimed_at=_at(24 * 50), source="other"),
        ])
        self.assertTrue(resolution.unresolved)
        self.assertEqual(resolution.value, 50, "conservative")
        self.assertEqual(len(escalations), 1)

    def test_the_material_threshold_is_inclusive(self):
        """
        Exactly 25 points apart counts as material. Inclusive because 0.75 against
        0.50 availability is a real difference in whether a player is fielded, and
        the conservative choice at a boundary is to report it.
        """
        from pipeline.learning.availability_conflicts import CHANCE_CONFLICT_POINTS

        resolution, _ = _one([
            _claim(value=75, source="a", source_tier=2, claimed_at=_at(2)),
            _claim(value=75 - CHANCE_CONFLICT_POINTS, source="b", source_tier=2,
                   claimed_at=_at(2)),
        ])
        self.assertTrue(resolution.unresolved)


class R2RecencyTests(unittest.TestCase):
    def test_the_latest_claim_from_one_source_wins(self):
        old = _claim(value=75, claimed_at=_at(48))
        new = _claim(value=25, claimed_at=_at(2))
        resolution, _ = _one([old, new])
        self.assertEqual(resolution.value, 25)
        self.assertIn(old.claim_id, resolution.conflicts)

    def test_ties_break_deterministically(self):
        """
        The resolution rides into a sealed record, so a re-run that resolved
        differently would make the seal unreproducible.
        """
        import random

        pair = [
            _claim(value=75, source="a", claimed_at=_at(2), observed_at=_at(1)),
            _claim(value=25, source="b", claimed_at=_at(2), observed_at=_at(1)),
        ]
        first, _ = _one(pair)
        for seed in range(6):
            shuffled = list(pair)
            random.Random(seed).shuffle(shuffled)
            again, _ = _one(shuffled)
            self.assertEqual(again.winning_claim_id, first.winning_claim_id)

    def test_a_claim_with_no_publication_time_orders_by_observation(self):
        """
        FPL's structured fields publish no timestamp. Ordering by `observed_at`
        there is a documented fallback, not a fabricated publication time.
        """
        earlier = _claim(value=75, claimed_at=None, observed_at=_at(5))
        later = _claim(value=25, claimed_at=None, observed_at=_at(1))
        resolution, _ = _one([earlier, later])
        self.assertEqual(resolution.value, 25)


class R3TierTests(unittest.TestCase):
    def test_the_lower_tier_number_wins_when_equally_fresh(self):
        official = _claim(value=75, claimed_at=_at(3))
        aggregator = _claim(value=60, claimed_at=_at(3), source="agg", source_tier=3)
        resolution, _ = _one([official, aggregator])
        self.assertEqual(resolution.value, 75)
        self.assertEqual(resolution.rule, RULE_TIER)
        self.assertIn(aggregator.claim_id, resolution.conflicts)


class R4AsymmetricOverrideTests(unittest.TestCase):
    def test_a_fresher_unofficial_source_may_say_he_is_OUT(self):
        """
        The direction that matters. FPL is slow to flag, so a fresher presser
        saying "he's out" is believed — that claim is near-certain.
        """
        official = _claim(value=100, claimed_at=_at(24))
        presser = _claim(value=0, claimed_at=_at(1), source="manual:presser",
                         source_tier=2)
        resolution, escalations = _one([official, presser])
        self.assertEqual(resolution.value, 0)
        self.assertEqual(resolution.rule, RULE_ASYMMETRIC)
        self.assertEqual(escalations, [])

    def test_a_fresher_unofficial_source_may_NOT_say_he_is_FIT(self):
        """
        "He's in contention" is a probability a third party cannot calibrate, so it
        loses — but it is recorded and surfaced, never silently discarded.
        """
        official = _claim(value=0, claimed_at=_at(24))
        optimistic = _claim(value=100, claimed_at=_at(1), source="manual:presser",
                            source_tier=2)
        resolution, escalations = _one([official, optimistic])
        self.assertEqual(resolution.value, 0)
        self.assertEqual(resolution.rule, RULE_ASYMMETRIC_REFUSED)
        self.assertIn(optimistic.claim_id, resolution.conflicts)
        self.assertEqual(len(escalations), 1)
        self.assertIn("never raise", escalations[0].escalation)

    def test_a_STALER_unofficial_source_cannot_override_at_all(self):
        """The override requires being strictly fresher, not merely pessimistic."""
        official = _claim(value=100, claimed_at=_at(1))
        old_presser = _claim(value=0, claimed_at=_at(48), source="manual:presser",
                             source_tier=2)
        resolution, _ = _one([official, old_presser])
        self.assertEqual(resolution.value, 100)
        self.assertEqual(resolution.rule, RULE_TIER)

    def test_a_tier_three_source_cannot_shorten_a_suspension(self):
        """
        An eligibility date is not a matter of opinion, and `unavailable_until`
        carries no optimism ordering an aggregator could win on.
        """
        official = _claim(claim_type="unavailable_until", value="2026-08-29",
                          claimed_at=_at(24))
        aggregator = _claim(claim_type="unavailable_until", value="2026-08-22",
                            claimed_at=_at(1), source="agg", source_tier=3)
        resolution, _ = _one([official, aggregator], claim_type="unavailable_until")
        self.assertEqual(resolution.value, "2026-08-29")


class R5PredictedLineupTests(unittest.TestCase):
    def test_a_predicted_start_never_reaches_the_availability_view(self):
        """
        A predicted XI says "he is in the eleven" — information about p_start
        CONDITIONAL on availability. Letting it through here is how a rotation call
        becomes an injury flag.
        """
        resolutions, _ = resolve_claims([
            _claim(claim_type="chance_of_playing", value=75),
            _claim(claim_type="predicted_start", value=0.9, source="agg",
                   source_tier=3),
        ], now=NOW)

        self.assertIn((1, "predicted_start"), resolutions)
        view = availability_view(resolutions)
        self.assertIn("chance_of_playing", view[1])
        self.assertNotIn("predicted_start", view[1])

    def test_an_out_of_domain_predicted_start_is_dropped(self):
        resolution, _ = _one(
            [_claim(claim_type="predicted_start", value=1.7, source="agg",
                    source_tier=3)],
            claim_type="predicted_start",
        )
        self.assertIsNone(resolution.value)


class R6PermanenceTests(unittest.TestCase):
    def test_a_departure_beats_a_stale_optimistic_chance(self):
        """
        FPL sometimes leaves a chance on a player who has left, and a departed
        player at 75% would be bought.
        """
        resolutions, _ = resolve_claims([
            _claim(claim_type="chance_of_playing", value=75),
            _claim(claim_type="permanent_exit",
                   value={"kind": "loan", "club": "Grimsby Town"},
                   source="fpl_news_parse"),
        ], now=NOW)
        chance = resolutions[(1, "chance_of_playing")]
        self.assertEqual(chance.value, 0)
        self.assertEqual(chance.rule, RULE_PERMANENCE)

    def test_a_player_without_an_exit_keeps_his_chance(self):
        resolutions, _ = resolve_claims(
            [_claim(claim_type="chance_of_playing", value=75)], now=NOW
        )
        self.assertEqual(resolutions[(1, "chance_of_playing")].value, 75)
        self.assertEqual(resolutions[(1, "chance_of_playing")].rule, RULE_ONLY_CLAIM)


class R7UnresolvableTests(unittest.TestCase):
    def test_two_equally_fresh_same_tier_sources_far_apart_escalate(self):
        left = _claim(value=90, source="manual:presser-a", source_tier=2,
                      claimed_at=_at(2))
        right = _claim(value=10, source="manual:presser-b", source_tier=2,
                       claimed_at=_at(2))
        resolution, escalations = _one([left, right])

        self.assertTrue(resolution.unresolved)
        self.assertEqual(resolution.rule, RULE_UNRESOLVED)
        # The CONSERVATIVE value is used, so the projection errs toward benching.
        self.assertEqual(resolution.value, 10)
        self.assertEqual(len(escalations), 1)
        for fragment in ("presser-a", "presser-b", "90", "10"):
            self.assertIn(fragment, escalations[0].escalation)

    def test_a_small_disagreement_does_not_escalate(self):
        """Below the material threshold, taking either is defensible."""
        resolution, escalations = _one([
            _claim(value=75, source="a", source_tier=2, claimed_at=_at(2)),
            _claim(value=65, source="b", source_tier=2, claimed_at=_at(2)),
        ])
        self.assertFalse(resolution.unresolved)
        self.assertEqual(escalations, [])

    def test_return_dates_more_than_a_week_apart_escalate(self):
        resolution, escalations = _one([
            _claim(claim_type="return_date", value="2026-09-01", source="a",
                   source_tier=2, claimed_at=_at(2)),
            _claim(claim_type="return_date", value="2026-10-15", source="b",
                   source_tier=2, claimed_at=_at(2)),
        ], claim_type="return_date")
        self.assertTrue(resolution.unresolved)
        self.assertEqual(len(escalations), 1)

    def test_one_saying_available_and_another_absent_escalates(self):
        resolution, escalations = _one([
            _claim(claim_type="status", value="a", source="a", source_tier=2,
                   claimed_at=_at(2)),
            _claim(claim_type="status", value="i", source="b", source_tier=2,
                   claimed_at=_at(2)),
        ], claim_type="status")
        self.assertTrue(resolution.unresolved)
        self.assertEqual(resolution.value, "i", "conservative reading")


class R8NeverSilentTests(unittest.TestCase):
    def test_every_resolution_names_every_claim_that_lost(self):
        """
        The only kind of "we did not quietly pick a side" that survives an
        unattended pipeline — a comment saying so would not.
        """
        claims = [
            _claim(value=75, source="fpl_bootstrap", claimed_at=_at(24)),
            _claim(value=50, source="fpl_bootstrap", claimed_at=_at(48)),
            _claim(value=30, source="agg", source_tier=3, claimed_at=_at(3)),
            _claim(value=10, source="stale", source_tier=2, claimed_at=_at(24 * 40)),
        ]
        resolution, _ = _one(claims)
        accounted = set(resolution.conflicts) | {resolution.winning_claim_id}
        self.assertEqual(accounted, {c.claim_id for c in claims})

    def test_the_summary_counts_every_rule_used(self):
        resolutions, escalations = resolve_claims([
            _claim(value=75),
            _claim(element_id=2, value=90, source="a", source_tier=2,
                   claimed_at=_at(2)),
            _claim(element_id=2, value=10, source="b", source_tier=2,
                   claimed_at=_at(2)),
        ], now=NOW)
        summary = summarise(resolutions, escalations)
        self.assertEqual(summary["n_players"], 2)
        self.assertEqual(summary["n_unresolved"], 1)
        self.assertEqual(summary["n_escalations"], 1)
        self.assertEqual(sum(summary["by_rule"].values()), summary["n_resolutions"])


class EmptyInputTests(unittest.TestCase):
    def test_no_claims_resolves_to_nothing_rather_than_raising(self):
        resolutions, escalations = resolve_claims([], now=NOW)
        self.assertEqual(resolutions, {})
        self.assertEqual(escalations, [])
        self.assertEqual(summarise(resolutions, escalations)["n_resolutions"], 0)


if __name__ == "__main__":
    unittest.main()


class CommittedFeedTests(unittest.TestCase):
    """
    Guards the committed message feed against synthetic content.

    Not really about conflicts, but it is the same class of problem and needs a
    home: the feed shipped with exactly one message, "GW7 — team team ready",
    dated 2026-08-02 — nineteen days before GW1's deadline, with the entry label
    left unsubstituted. It was test output, and treating it as operational evidence
    would mean the agent appeared to have decided a gameweek that had not happened.
    """

    FEED = Path(__file__).resolve().parents[2] / "predictions" / "fpl" / "messages.json"
    # GW1 of 2026-27. Nothing the agent says about a gameweek can predate the
    # season it belongs to.
    SEASON_START = datetime(2026, 8, 21, tzinfo=timezone.utc)

    @unittest.skipUnless(FEED.exists(), "no committed feed")
    def test_no_message_predates_the_season_it_describes(self):
        import json

        payload = json.loads(self.FEED.read_text())
        offenders = []
        for message in payload.get("messages", []):
            created = message.get("created_at") or ""
            try:
                when = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except ValueError:
                offenders.append(f"{message.get('id')}: unparseable {created!r}")
                continue
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            if int(message.get("gameweek", 0)) >= 1 and when < self.SEASON_START:
                offenders.append(
                    f"{message.get('id')}: GW{message.get('gameweek')} dated {created}"
                )
        self.assertEqual(
            offenders, [],
            "the committed feed contains messages that predate the season they "
            "describe, so they cannot be real agent output:\n  "
            + "\n  ".join(offenders),
        )

    @unittest.skipUnless(FEED.exists(), "no committed feed")
    def test_the_feed_header_matches_its_contents(self):
        import json

        payload = json.loads(self.FEED.read_text())
        self.assertEqual(payload.get("n_messages"), len(payload.get("messages", [])))
