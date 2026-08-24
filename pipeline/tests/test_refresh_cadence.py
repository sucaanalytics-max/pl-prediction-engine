"""A wide refresh window must not mean a full simulation every three hours."""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.learning.run_agent import projection_is_current

NOW = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
MAX_AGE = timedelta(hours=20)


class ProjectionIsCurrent(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # A stand-in for FPL_PUBLIC_DIR itself (frontend/public/predictions/fpl/),
        # not for PREDICTIONS_DIR. The function reads the leaf directory the
        # frontend fetches from, not a "fpl" child of whatever is passed in.
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, gameweek, generated_at):
        path = self.root / f"xp_public_gw{gameweek:02d}.json"
        path.write_text(json.dumps({"generated_at": generated_at}))

    def test_absent_is_not_current(self):
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_a_fresh_projection_is_current(self):
        self.write(2, "2026-08-24T06:00:00Z")
        self.assertTrue(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_an_aged_projection_is_not_current(self):
        self.write(2, "2026-08-23T06:00:00Z")  # 30 hours old
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_another_gameweek_s_file_does_not_count(self):
        # The exact failure being fixed: gw01 on disk, gw02 requested.
        self.write(1, "2026-08-24T06:00:00Z")
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_an_unreadable_stamp_is_not_current(self):
        path = self.root / "xp_public_gw02.json"
        path.write_text("{not json")
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_a_missing_stamp_is_not_current(self):
        self.write(2, None)
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )

    def test_reads_the_public_dir_directly_not_a_predictions_style_tree(self):
        """
        The actual defect this whole file exists to catch: the gate's call site
        used to pass PREDICTIONS_DIR and the function appended "fpl" itself, so
        it checked `predictions/fpl/xp_public_gw{NN}.json` — a path that never
        held the file, since `_publish_public_xp` writes straight into
        FPL_PUBLIC_DIR (`frontend/public/predictions/fpl/`) with no further
        nesting. Reproducing that old shape here — the file one directory
        deeper than the leaf `public_dir` passed in — must NOT be found. If
        this ever starts passing as True, the function has regressed back to
        appending "fpl" and the gate will silently stop firing again.
        """
        nested = self.root / "fpl"
        nested.mkdir()
        (nested / "xp_public_gw02.json").write_text(
            json.dumps({"generated_at": "2026-08-24T06:00:00Z"})
        )
        self.assertFalse(
            projection_is_current(2, NOW, MAX_AGE, public_dir=self.root)
        )
