"""
The news -> decision delta.

The competitor study's largest finding across eight products: *"nobody closes the
loop — news arrives, xMins update, the plan recomputes, and you are told what
changed and whether your decision flips."* This is that join, so the tests are
mostly about two things:

1. **The threshold is auditable.** A filter that silently swallows a real change is
   indistinguishable from a broken poller, so every suppression carries a reason
   and the reason is asserted.
2. **The first run does not flood.** Without a guard, the tick after deployment
   emits one delta per flagged player in the league and trains the human to ignore
   the feed on day one.

## The two stages, and why

``resolve_claims`` is pure stdlib; ``pipeline/decide/milp.py`` imports numpy at
module level and scipy's ``milp`` at run time. So the 15-minute poller can resolve
but cannot solve, and a single-stage delta would either need the heavy install on
every tick or carry a three-hour latency on "he is out". Stage 1 is emitted by the
poller, stage 2 by the agent, as separate append-only records.
"""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.config import DELTA
from pipeline.learning import deltas as D
from pipeline.learning.availability_conflicts import resolve_claims
from pipeline.learning.availability_evidence import (
    AvailabilityClaim, provenance_digest, record as record_claims, history,
)

NOW = datetime(2026, 8, 6, 12, 0, 0, tzinfo=timezone.utc)
STAMP = NOW.isoformat().replace("+00:00", "Z")


def _snap(**entries):
    """A snapshot literal, keyed as the differ expects."""
    return {
        key: {"value": value, "rule": "test", "winning_claim_id": None}
        for key, value in entries.items()
    }


def _change(**over):
    params = dict(element_id=521, claim_type="chance_of_playing",
                  before=75, after=25, reason="75% -> 25%")
    params.update(over)
    return D.ResolutionChange(**params)


def _delta(**over):
    params = dict(change=_change(), observed_at=STAMP, gameweek=1,
                  player_name="Kulusevski", club="Spurs")
    params.update(over)
    return D.Delta(**params)


def _impact(**over):
    params = dict(delta_id="abc123", observed_at=STAMP, gameweek=1,
                  entry_label="season")
    params.update(over)
    return D.DecisionImpact(**params)


class MaterialityTests(unittest.TestCase):
    """What is worth interrupting a human for."""

    def test_no_change_is_not_material(self):
        matters, reason = D.is_material("chance_of_playing", 75, 75, DELTA)
        self.assertFalse(matters)
        self.assertEqual(reason, "unchanged")

    def test_a_band_change_is_material(self):
        matters, reason = D.is_material("chance_of_playing", 75, 25, DELTA)
        self.assertTrue(matters)
        self.assertIn("75", reason)
        self.assertIn("25", reason)

    def test_a_small_move_is_suppressed_with_a_reason(self):
        """
        Only reachable for hand-filed claims: FPL itself emits 0/25/50/75/100, so
        every FPL move is a band change.
        """
        matters, reason = D.is_material("chance_of_playing", 75, 70, DELTA)
        self.assertFalse(matters)
        self.assertIn("under", reason)

    def test_any_status_change_is_material(self):
        for before, after in (("a", "d"), ("d", "i"), ("i", "a"), ("a", "s")):
            with self.subTest(change=(before, after)):
                matters, _ = D.is_material("status", before, after, DELTA)
                self.assertTrue(matters)

    def test_a_permanent_exit_is_always_material(self):
        matters, _ = D.is_material(
            "permanent_exit", None, {"kind": "loan"}, DELTA,
        )
        self.assertTrue(matters)

    def test_a_return_date_nudge_is_suppressed(self):
        matters, reason = D.is_material(
            "return_date", "2026-08-21", "2026-08-23", DELTA,
        )
        self.assertFalse(matters)
        self.assertIn("under", reason)

    def test_a_return_date_shift_of_a_week_is_material(self):
        matters, reason = D.is_material(
            "return_date", "2026-08-21", "2026-09-04", DELTA,
        )
        self.assertTrue(matters)
        self.assertIn("14d", reason)

    def test_an_unparseable_date_is_reported_rather_than_swallowed(self):
        matters, _ = D.is_material("return_date", "2026-08-21", "soon", DELTA)
        self.assertTrue(matters)

    # ── the first-run flood guard ────────────────────────────────────────────

    def test_a_newly_available_player_is_not_news(self):
        """
        The guard. Without it the first tick emits a delta for every player in the
        league, which is how a notification feed gets muted permanently.
        """
        matters, reason = D.is_material("chance_of_playing", None, 100, DELTA)
        self.assertFalse(matters)
        self.assertIn("unremarkable", reason)

    def test_a_newly_flagged_player_IS_news(self):
        matters, reason = D.is_material("chance_of_playing", None, 25, DELTA)
        self.assertTrue(matters)
        self.assertIn("newly flagged", reason)

    def test_a_new_available_status_is_not_news(self):
        matters, _ = D.is_material("status", None, "a", DELTA)
        self.assertFalse(matters)

    def test_a_new_injured_status_IS_news(self):
        matters, _ = D.is_material("status", None, "i", DELTA)
        self.assertTrue(matters)

    def test_a_resolution_disappearing_is_always_news(self):
        """
        Either the source retracted it or it aged past the staleness horizon, and
        both change what the projection is using.
        """
        matters, reason = D.is_material("chance_of_playing", 25, None, DELTA)
        self.assertTrue(matters)
        self.assertIn("no longer resolved", reason)


class DiffTests(unittest.TestCase):
    def test_finds_a_changed_value(self):
        changes, suppressed = D.diff(
            _snap(**{"521:chance_of_playing": 75}),
            _snap(**{"521:chance_of_playing": 25}),
            DELTA,
        )
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0].element_id, 521)
        self.assertEqual(suppressed, {})

    def test_reports_suppressions_separately_from_silence(self):
        """
        A change that did not clear the bar is recorded as suppressed; a value that
        did not move at all is not mentioned. Collapsing those would make the
        threshold unauditable.
        """
        changes, suppressed = D.diff(
            _snap(**{"1:chance_of_playing": 75, "2:chance_of_playing": 50}),
            _snap(**{"1:chance_of_playing": 70, "2:chance_of_playing": 50}),
            DELTA,
        )
        self.assertEqual(changes, [])
        self.assertIn("1:chance_of_playing", suppressed)
        self.assertNotIn("2:chance_of_playing", suppressed)

    def test_ignores_claim_types_that_do_not_bear_on_availability(self):
        changes, _ = D.diff(
            _snap(**{"521:predicted_start": 0.9}),
            _snap(**{"521:predicted_start": 0.2}),
            DELTA,
        )
        # R5: predicted_start is about p_start, not availability. Letting it
        # through here is how a rotation call becomes an injury alert.
        self.assertEqual(changes, [])

    def test_ignores_unparsed_news_entirely(self):
        """
        The connectors emit nothing but `unparsed_news`, at 44 claims per poll. If
        that were watched, every poll would be a notification storm.
        """
        changes, _ = D.diff(
            _snap(**{"521:unparsed_news": "a"}),
            _snap(**{"521:unparsed_news": "b"}),
            DELTA,
        )
        self.assertEqual(changes, [])

    def test_an_empty_before_does_not_flood(self):
        """First run: 20 available players, no deltas."""
        after = _snap(**{f"{i}:chance_of_playing": 100 for i in range(1, 21)})
        changes, _ = D.diff({}, after, DELTA)
        self.assertEqual(changes, [])

    def test_an_empty_before_still_reports_the_flagged_ones(self):
        after = _snap(**{
            "1:chance_of_playing": 100, "2:chance_of_playing": 25,
            "3:chance_of_playing": 0,
        })
        changes, _ = D.diff({}, after, DELTA)
        self.assertEqual({c.element_id for c in changes}, {2, 3})

    def test_carries_the_rule_that_produced_the_new_value(self):
        after = {"521:chance_of_playing": {
            "value": 25, "rule": "asymmetric_override", "winning_claim_id": "abc",
        }}
        changes, _ = D.diff(_snap(**{"521:chance_of_playing": 75}), after, DELTA)
        self.assertEqual(changes[0].rule, "asymmetric_override")
        self.assertEqual(changes[0].winning_claim_id, "abc")

    def test_is_deterministic_in_order(self):
        before = _snap(**{"9:status": "a", "2:status": "a", "5:status": "a"})
        after = _snap(**{"9:status": "i", "2:status": "i", "5:status": "i"})
        ids = [c.element_id for c in D.diff(before, after, DELTA)[0]]
        self.assertEqual(ids, sorted(ids))


class SnapshotTests(unittest.TestCase):
    def test_keeps_only_availability_types(self):
        claims = [
            AvailabilityClaim(
                element_id=521, source="fpl_bootstrap", source_tier=1,
                claim_type=kind, value=value, claimed_at=None,
                observed_at=STAMP, gameweek=1,
            )
            for kind, value in (("chance_of_playing", 25), ("predicted_start", 0.5))
        ]
        resolutions, _ = resolve_claims(claims, now=NOW)
        snap = D.snapshot(resolutions)
        self.assertIn("521:chance_of_playing", snap)
        self.assertNotIn("521:predicted_start", snap)

    def test_excludes_conflicts_so_a_repeated_story_is_not_a_delta(self):
        """
        `conflicts` grows whenever another outlet repeats the same claim. Diffing on
        it would emit a delta every time a second source said the same thing.
        """
        snap = D.snapshot({(521, "status"): type("R", (), {
            "value": "i", "rule": "r", "winning_claim_id": "w",
            "conflicts": ("x", "y"),
        })()})
        self.assertNotIn("conflicts", snap["521:status"])


class ImpactThresholdTests(unittest.TestCase):
    """Stage 2: the threshold on the DECISION, not the projection."""

    def test_a_root_move_flip_is_always_reportable(self):
        impact = _impact(root_move_before="hold", root_move_after="Salah -> Palmer",
                         xp_moved=({"element_id": 1, "before": 5.0, "after": 4.99},))
        reportable, why = D.impact_is_reportable(impact, DELTA)
        self.assertTrue(reportable)
        self.assertIn("recommended move changed", why)

    def test_a_captain_flip_is_always_reportable(self):
        impact = _impact(captain_before=100, captain_after=200)
        self.assertTrue(D.impact_is_reportable(impact, DELTA)[0])

    def test_a_large_xp_move_that_flips_nothing_is_reportable(self):
        impact = _impact(
            root_move_before="hold", root_move_after="hold",
            xp_moved=({"element_id": 1, "before": 6.0, "after": 4.0},),
        )
        reportable, why = D.impact_is_reportable(impact, DELTA)
        self.assertTrue(reportable)
        self.assertIn("xp moved", why)

    def test_a_small_xp_move_that_flips_nothing_is_NOT_reportable(self):
        """
        The plan's own example: "an xp move of 0.3 that flips nothing is not a
        delta; one of 0.1 that flips the captain is."
        """
        impact = _impact(
            root_move_before="hold", root_move_after="hold",
            xp_moved=({"element_id": 1, "before": 6.0, "after": 5.9},),
        )
        reportable, why = D.impact_is_reportable(impact, DELTA)
        self.assertFalse(reportable)
        self.assertIn("flips nothing", why)

    def test_a_tiny_move_that_flips_the_captain_IS_reportable(self):
        impact = _impact(
            captain_before=100, captain_after=200,
            xp_moved=({"element_id": 1, "before": 6.0, "after": 5.9},),
        )
        self.assertTrue(D.impact_is_reportable(impact, DELTA)[0])

    def test_a_material_cost_of_inaction_is_reportable(self):
        impact = _impact(root_move_before="hold", root_move_after="hold",
                         ev_cost_of_inaction=1.8)
        reportable, why = D.impact_is_reportable(impact, DELTA)
        self.assertTrue(reportable)
        self.assertIn("inaction costs", why)

    def test_flipped_is_false_when_nothing_moved(self):
        self.assertFalse(_impact(root_move_before="hold",
                                 root_move_after="hold").flipped)

    def test_flipped_treats_none_and_empty_string_as_the_same(self):
        """
        Otherwise "no move recommended" versus "" reads as a flip on every run,
        which is the `Date.parse("")` class of bug in a different costume.
        """
        self.assertFalse(_impact(root_move_before=None, root_move_after="").flipped)

    def test_an_impact_with_no_data_at_all_is_not_reportable(self):
        self.assertFalse(D.impact_is_reportable(_impact(), DELTA)[0])


class RecordTests(unittest.TestCase):
    def test_a_delta_id_is_stable_across_observation_times(self):
        """
        So the poller does not re-report standing news every fifteen minutes, and
        so a stage-2 enrichment can be joined to a stage-1 record.
        """
        first = _delta(observed_at="2026-08-06T12:00:00Z")
        second = _delta(observed_at="2026-08-06T15:00:00Z")
        self.assertEqual(first.delta_id, second.delta_id)

    def test_a_different_change_gets_a_different_id(self):
        self.assertNotEqual(
            _delta().delta_id,
            _delta(change=_change(after=50)).delta_id,
        )

    def test_records_and_dedupes(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertIsNotNone(D.record([_delta()], root))
            self.assertIsNone(D.record([_delta()], root))
            self.assertEqual(len(D.history(root)), 1)

    def test_an_impact_appends_alongside_its_resolution_change(self):
        """
        Append-only, so an enrichment is a second record rather than an edit. Both
        share a delta_id and are deduped by (kind, id).
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            delta = _delta()
            D.record([delta], root)
            D.record([_impact(delta_id=delta.delta_id)], root)
            records = D.history(root)
            self.assertEqual(len(records), 2)
            self.assertEqual({r["kind"] for r in records},
                             {D.KIND_RESOLUTION, D.KIND_IMPACT})
            self.assertEqual({r["delta_id"] for r in records}, {delta.delta_id})

    def test_a_corrupt_line_costs_one_duplicate_not_all_reporting(self):
        """
        Deliberately unlike the evidence store, which raises. A shortened claim
        history silently changes a projection; a shortened delta log only risks
        re-sending one notification.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = D.path_for(root)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"broken\n' + json.dumps(_delta().as_dict()) + "\n")
            self.assertEqual(len(D.history(root)), 1)
            self.assertIn(_delta().delta_id, D.known_ids(root)[D.KIND_RESOLUTION])

    def test_serialises_without_nan(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            D.record([_impact(ev_cost_of_inaction=1.83333)], root)
            text = D.path_for(root).read_text()
            self.assertNotIn("NaN", text)
            self.assertIn("1.8333", text)

    def test_an_empty_batch_writes_nothing(self):
        with TemporaryDirectory() as tmp:
            self.assertIsNone(D.record([], Path(tmp)))
            self.assertFalse(D.path_for(Path(tmp)).exists())

    def test_a_dry_run_writes_nothing(self):
        with TemporaryDirectory() as tmp:
            self.assertIsNone(D.record([_delta()], Path(tmp), dry_run=True))
            self.assertFalse(D.path_for(Path(tmp)).exists())


class PruneAndEnrichTests(unittest.TestCase):
    def test_prune_keeps_a_bounded_window(self):
        records = [_delta(gameweek=gw).as_dict() for gw in (1, 5, 8, 9, 10)]
        kept = D.prune(records, current_gameweek=10, keep_gameweeks=4)
        self.assertEqual({r["gameweek"] for r in kept}, {8, 9, 10})

    def test_prune_is_what_keeps_the_published_copy_fixed_size(self):
        # The reason forecast_ledger.json is never published: it grows all season.
        records = [_delta(gameweek=gw).as_dict() for gw in range(1, 39)]
        kept = D.prune(records, current_gameweek=38, keep_gameweeks=4)
        self.assertEqual(len(kept), 4)

    def test_unenriched_finds_changes_with_no_impact_yet(self):
        delta = _delta()
        records = [delta.as_dict()]
        self.assertEqual(len(D.unenriched(records)), 1)

    def test_unenriched_excludes_changes_that_have_an_impact(self):
        delta = _delta()
        records = [delta.as_dict(), _impact(delta_id=delta.delta_id).as_dict()]
        self.assertEqual(D.unenriched(records), [])

    def test_unenriched_ignores_impacts_for_other_deltas(self):
        delta = _delta()
        records = [delta.as_dict(), _impact(delta_id="somethingelse").as_dict()]
        self.assertEqual(len(D.unenriched(records)), 1)


class DescribeMoveTests(unittest.TestCase):
    def test_no_transfers_is_hold_not_unknown(self):
        self.assertEqual(
            D.describe_move({"transfers_in": [], "transfers_out": []}), "hold",
        )

    def test_an_absent_plan_is_unknown_not_hold(self):
        """
        "we have no previous decision" and "the previous decision was to do
        nothing" are different, and conflating them would make the first run of
        every gameweek look like a flip.
        """
        self.assertIsNone(D.describe_move(None))
        self.assertIsNone(D.describe_move({}))

    def test_order_does_not_create_a_phantom_flip(self):
        a = D.describe_move({"transfers_in": [1, 2], "transfers_out": [3, 4]})
        b = D.describe_move({"transfers_in": [2, 1], "transfers_out": [4, 3]})
        self.assertEqual(a, b)

    def test_a_real_swap_differs_from_hold(self):
        swap = D.describe_move({"transfers_in": [9], "transfers_out": [7]})
        self.assertNotEqual(swap, "hold")


class AssessImpactTests(unittest.TestCase):
    """Stage 2, pure — no numpy, no scipy, no solver."""

    CHANGES = [{"delta_id": "d1", "element_id": 521},
               {"delta_id": "d2", "element_id": 100}]

    def _assess(self, **over):
        params = dict(
            changes=self.CHANGES,
            previous_plan={"transfers_in": [], "transfers_out": [], "captain": 100},
            new_plan={"transfers_in": [9], "transfers_out": [521], "captain": 200},
            xp_before={521: 5.4, 100: 6.1},
            xp_after={521: 1.2, 100: 6.1},
            observed_at=STAMP, gameweek=1, entry_label="season",
        )
        params.update(over)
        return D.assess_impact(**params)

    def test_one_impact_per_change(self):
        self.assertEqual(len(self._assess()), 2)

    def test_each_impact_keeps_its_own_delta_id(self):
        self.assertEqual([i.delta_id for i in self._assess()], ["d1", "d2"])

    def test_every_impact_carries_the_same_plan_diff(self):
        """
        The plan moved once. Attributing that single move to each contributing
        piece of news is honest exactly because it does not invent an
        apportionment between them.
        """
        impacts = self._assess()
        self.assertEqual({i.root_move_after for i in impacts}, {"[521] -> [9]"})
        self.assertTrue(all(i.flipped for i in impacts))

    def test_xp_moved_is_per_player(self):
        impacts = self._assess()
        self.assertEqual(impacts[0].xp_moved[0]["element_id"], 521)
        self.assertEqual(impacts[0].xp_moved[0]["before"], 5.4)
        self.assertEqual(impacts[0].xp_moved[0]["after"], 1.2)

    def test_a_player_absent_from_one_artifact_yields_None_not_zero(self):
        """
        Newly added or newly gone. Coercing to 0.0 would score "we do not know" as
        a 5.4-point collapse and cross the reporting threshold on nothing.
        """
        impacts = self._assess(xp_after={100: 6.1})
        row = impacts[0].xp_moved[0]
        self.assertEqual(row["before"], 5.4)
        self.assertIsNone(row["after"])
        self.assertFalse(D.impact_is_reportable(
            D.DecisionImpact(delta_id="x", observed_at=STAMP, gameweek=1,
                             entry_label="season", xp_moved=tuple(impacts[0].xp_moved),
                             root_move_before="hold", root_move_after="hold"),
            DELTA,
        )[0])

    def test_ev_cost_needs_both_halves(self):
        self.assertIsNone(self._assess(new_ev=60.0).pop().ev_cost_of_inaction)
        self.assertIsNone(
            self._assess(previous_plan_rescored_ev=58.0).pop().ev_cost_of_inaction
        )

    def test_ev_cost_is_new_best_minus_old_move_rescored(self):
        """
        Not the raw gap between two plans: that would count model drift as urgency
        and produce a number every time the simulator was reseeded.
        """
        impacts = self._assess(new_ev=60.0, previous_plan_rescored_ev=58.2)
        self.assertAlmostEqual(impacts[0].ev_cost_of_inaction, 1.8, places=6)

    def test_a_club_level_change_has_no_xp_row(self):
        impacts = self._assess(changes=[{"delta_id": "d3", "element_id": 0}])
        self.assertEqual(impacts[0].xp_moved, ())

    def test_no_changes_means_no_impacts(self):
        self.assertEqual(self._assess(changes=[]), [])

    def test_a_missing_previous_plan_does_not_read_as_a_flip(self):
        impacts = self._assess(previous_plan=None,
                               new_plan={"transfers_in": [], "transfers_out": [],
                                         "captain": 100})
        # root_move goes None -> "hold", which IS a change of knowledge, but the
        # captain is unchanged. The flip flag is honest about the first case.
        self.assertIsNone(impacts[0].root_move_before)
        self.assertEqual(impacts[0].root_move_after, "hold")

    def test_serialises_with_the_flip_flag_computed(self):
        payload = self._assess()[0].as_dict()
        self.assertTrue(payload["root_move"]["flipped"])
        self.assertEqual(payload["captain"], {"before": 100, "after": 200})
        self.assertEqual(payload["kind"], D.KIND_IMPACT)


class PublishTests(unittest.TestCase):
    """
    The bounded public view.

    The private log is append-only and unbounded; the published copy is pruned.
    That asymmetry is the same reason `forecast_ledger.json` is never published: it
    is the audit record and it grows all season, while the app only needs the
    recent past.
    """

    def test_writes_a_pruned_copy(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            D.record([_delta(gameweek=gw) for gw in (1, 5, 9, 10)], root)
            target = D.publish(root, public, current_gameweek=10, keep_gameweeks=4)
            self.assertIsNotNone(target)
            lines = target.read_text(encoding="utf-8").strip().splitlines()
            self.assertEqual(len(lines), 2)  # gw 9 and 10
            self.assertEqual({json.loads(x)["gameweek"] for x in lines}, {9, 10})

    def test_writes_an_empty_file_rather_than_no_file(self):
        """
        Absent means "nothing has ever run"; empty means "nothing recent
        happened". The app renders those differently, so the distinction has to
        survive to disk.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            D.record([_delta(gameweek=1)], root)
            target = D.publish(root, public, current_gameweek=30, keep_gameweeks=4)
            self.assertTrue(target.exists())
            self.assertEqual(target.read_text(encoding="utf-8"), "")

    def test_republishing_replaces_rather_than_appends(self):
        """
        The published file is a VIEW of the log. One that only ever grew would
        drift from the thing it views and would never shed a pruned gameweek.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            D.record([_delta(gameweek=9)], root)
            D.publish(root, public, current_gameweek=9, keep_gameweeks=4)
            D.publish(root, public, current_gameweek=9, keep_gameweeks=4)
            lines = (public / D.DELTAS_FILENAME).read_text().strip().splitlines()
            self.assertEqual(len(lines), 1)

    def test_every_published_line_is_valid_json(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            delta = _delta(gameweek=9)
            D.record([delta, _impact(delta_id=delta.delta_id, gameweek=9)], root)
            target = D.publish(root, public, current_gameweek=9, keep_gameweeks=4)
            for line in target.read_text().strip().splitlines():
                json.loads(line)  # raises if not

    def test_a_dry_run_writes_nothing(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            D.record([_delta(gameweek=9)], root)
            self.assertIsNone(
                D.publish(root, public, current_gameweek=9, keep_gameweeks=4,
                          dry_run=True)
            )
            self.assertFalse((public / D.DELTAS_FILENAME).exists())

    def test_publishing_with_no_log_at_all_yields_an_empty_file(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            target = D.publish(root, public, current_gameweek=1, keep_gameweeks=4)
            self.assertTrue(target.exists())
            self.assertEqual(target.read_text(), "")


class EndToEndTests(unittest.TestCase):
    """
    A real claim store, resolved twice, with R4 doing the work in between.

    This is the loop the whole feature is: a press conference contradicts FPL's own
    field, the asymmetric override lets it push availability DOWN, and the delta
    names the rule that did it.
    """

    def _claim(self, root, value, tier, source, said, ctype="chance_of_playing"):
        quote = f"{source} says {value}"
        return AvailabilityClaim(
            element_id=521, source=source, source_tier=tier, claim_type=ctype,
            value=value, claimed_at=said.isoformat().replace("+00:00", "Z"),
            observed_at=STAMP, gameweek=1, source_text=quote,
            provenance_digest=provenance_digest(quote),
            provenance_url="https://example.invalid/a",
        )

    def test_a_presser_contradicting_fpl_produces_one_delta_naming_r4(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            record_claims(
                [self._claim(root, 75, 1, "fpl_bootstrap", NOW - timedelta(days=2))],
                root,
            )
            before = D.snapshot(resolve_claims(history(root), now=NOW)[0])

            record_claims(
                [self._claim(root, 25, 2, "manual:presser", NOW - timedelta(hours=1))],
                root,
            )
            after = D.snapshot(resolve_claims(history(root), now=NOW)[0])

            changes, suppressed = D.diff(before, after, DELTA)
            self.assertEqual(len(changes), 1)
            self.assertEqual(suppressed, {})
            change = changes[0]
            self.assertEqual((change.before, change.after), (75, 25))
            # R4, by its name in the resolver.
            self.assertEqual(change.rule, "asymmetric_override")

    def test_the_reverse_direction_is_refused_by_r4_so_there_is_no_delta(self):
        """
        A tier-2 source may push availability DOWN but never UP. So an optimistic
        presser cannot overrule FPL's own flag, and no delta is emitted — which is
        the rule working, not the differ failing.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            record_claims(
                [self._claim(root, 25, 1, "fpl_bootstrap", NOW - timedelta(days=2))],
                root,
            )
            before = D.snapshot(resolve_claims(history(root), now=NOW)[0])

            record_claims(
                [self._claim(root, 100, 2, "manual:presser", NOW - timedelta(hours=1))],
                root,
            )
            after = D.snapshot(resolve_claims(history(root), now=NOW)[0])

            self.assertEqual(after["521:chance_of_playing"]["value"], 25)
            changes, _ = D.diff(before, after, DELTA)
            self.assertEqual(changes, [])

    def test_re_resolving_an_unchanged_store_produces_no_delta(self):
        """The 15-minute tick must be silent when nothing happened."""
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            record_claims(
                [self._claim(root, 25, 1, "fpl_bootstrap", NOW - timedelta(days=1))],
                root,
            )
            first = D.snapshot(resolve_claims(history(root), now=NOW)[0])
            second = D.snapshot(resolve_claims(history(root), now=NOW)[0])
            self.assertEqual(D.diff(first, second, DELTA)[0], [])


if __name__ == "__main__":
    unittest.main()
