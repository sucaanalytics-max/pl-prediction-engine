"""
Tests for the versioned parameter store.

The store is the last line of defence before a fitted value reaches the models,
so these test what it REFUSES at least as hard as what it records — and, above
all, that history is append-only: a rollback that rewrote the past would erase
the evidence of the very mistake it was correcting.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.config import PARAM_REGISTRY
from pipeline.learning.params import (
    PARAMS_FILENAME,
    PromotionError,
    active,
    defaults,
    history,
    promote,
    resolve,
    rollback,
)

NAME = next(n for n, e in PARAM_REGISTRY.items() if e.get("tier") == "F")
PASSING = [{"gate": "out_of_sample", "passed": True, "reason": ""}]
STAMP = "2026-08-01T00:00:00Z"


class _Store(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _promote(self, value, reason="test", gates=None):
        return promote(self.dir, {NAME: value}, gates or PASSING, reason, STAMP)


class TestActiveAndDefaults(_Store):
    def test_nothing_promoted_is_version_zero_on_registry_defaults(self):
        """
        A real state, distinct from "promoted values that happen to equal the
        defaults" — otherwise "never refit" and "refit to the same numbers"
        would be indistinguishable in the record.
        """
        current = active(self.dir)
        self.assertEqual(current.version, 0)
        self.assertEqual(current.values, defaults())

    def test_resolve_fills_in_registry_additions(self):
        """
        A parameter added after the last promotion has no entry in that version.
        Raising would make every new parameter a breaking change.
        """
        self._promote(PARAM_REGISTRY[NAME]["value"] * 1.01)
        resolved = resolve(self.dir)
        self.assertEqual(set(resolved), set(PARAM_REGISTRY))


class TestPromotion(_Store):
    def test_promotion_records_the_before_and_after(self):
        before = PARAM_REGISTRY[NAME]["value"]
        version = self._promote(before * 1.02)
        self.assertEqual(version.version, 1)
        self.assertEqual(version.changed[NAME]["from"], before)
        self.assertAlmostEqual(version.changed[NAME]["to"], before * 1.02)

    def test_failed_gates_are_refused_by_the_store_itself(self):
        """
        The store does not take the caller's word for it. A promotion path that
        trusted its caller would make the gates advisory.
        """
        failing = PASSING + [{"gate": "bounds", "passed": False, "reason": "out of range"}]
        with self.assertRaises(PromotionError):
            self._promote(1.0, gates=failing)
        self.assertEqual(history(self.dir), [])

    def test_unregistered_parameters_are_refused(self):
        with self.assertRaises(PromotionError):
            promote(self.dir, {"not.a.parameter": 1.0}, PASSING, "x", STAMP)

    def test_an_empty_change_set_is_refused(self):
        with self.assertRaises(PromotionError):
            promote(self.dir, {}, PASSING, "x", STAMP)

    def test_gates_are_stored_including_the_passing_ones(self):
        """
        A record showing only what failed cannot be audited: it does not say
        what was checked.
        """
        version = self._promote(PARAM_REGISTRY[NAME]["value"] * 1.01)
        self.assertEqual(len(version.gates), len(PASSING))
        self.assertTrue(all(g["passed"] for g in version.gates))

    def test_dry_run_writes_nothing(self):
        promote(self.dir, {NAME: 1.0}, PASSING, "x", STAMP, dry_run=True)
        self.assertFalse((self.dir / "fpl" / PARAMS_FILENAME).exists())

    def test_versions_increment_and_accumulate(self):
        base = PARAM_REGISTRY[NAME]["value"]
        self._promote(base * 1.01)
        self._promote(base * 1.02)
        versions = history(self.dir)
        self.assertEqual([v.version for v in versions], [1, 2])
        self.assertAlmostEqual(active(self.dir).values[NAME], base * 1.02)


class TestRollback(_Store):
    def test_rollback_moves_forward_and_keeps_the_bad_version(self):
        """
        The property the whole module exists for. Undoing v2 appends v3; v2
        stays in the record with its gates, because an append-only history that
        can be edited is not an audit trail.
        """
        base = PARAM_REGISTRY[NAME]["value"]
        self._promote(base * 1.01)
        self._promote(base * 1.5, reason="the bad one")

        version = rollback(self.dir, 1, "rollback of v2", STAMP)
        self.assertEqual(version.version, 3)
        self.assertEqual(version.rollback_of, 2)
        self.assertAlmostEqual(active(self.dir).values[NAME], base * 1.01)

        versions = history(self.dir)
        self.assertEqual([v.version for v in versions], [1, 2, 3])
        self.assertEqual(versions[1].reason, "the bad one")

    def test_rollback_never_rewrites_the_file(self):
        base = PARAM_REGISTRY[NAME]["value"]
        self._promote(base * 1.01)
        self._promote(base * 1.5)
        path = self.dir / "fpl" / PARAMS_FILENAME
        before = path.read_text()

        rollback(self.dir, 1, "undo", STAMP)
        after = path.read_text()
        self.assertTrue(
            after.startswith(before),
            "rollback rewrote earlier history instead of appending to it",
        )

    def test_rolling_back_to_the_active_version_is_refused(self):
        self._promote(PARAM_REGISTRY[NAME]["value"] * 1.01)
        with self.assertRaises(PromotionError):
            rollback(self.dir, 1, "no-op", STAMP)

    def test_unknown_target_is_refused(self):
        self._promote(PARAM_REGISTRY[NAME]["value"] * 1.01)
        with self.assertRaises(PromotionError):
            rollback(self.dir, 99, "x", STAMP)

    def test_rollback_with_no_history_is_refused(self):
        with self.assertRaises(PromotionError):
            rollback(self.dir, 1, "x", STAMP)


class TestCorruption(_Store):
    def test_a_corrupt_line_raises_rather_than_being_skipped(self):
        """
        Skipping a bad line would silently revert the active parameter set to an
        older version, which is a worse failure than refusing to start.
        """
        self._promote(PARAM_REGISTRY[NAME]["value"] * 1.01)
        path = self.dir / "fpl" / PARAMS_FILENAME
        path.write_text(path.read_text() + "{not json}\n")
        with self.assertRaises(PromotionError):
            history(self.dir)

    def test_blank_lines_are_tolerated(self):
        self._promote(PARAM_REGISTRY[NAME]["value"] * 1.01)
        path = self.dir / "fpl" / PARAMS_FILENAME
        path.write_text(path.read_text() + "\n\n")
        self.assertEqual(len(history(self.dir)), 1)
