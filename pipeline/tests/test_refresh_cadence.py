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
        self.root = Path(self.tmp.name)
        (self.root / "fpl").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, gameweek, generated_at):
        path = self.root / "fpl" / f"xp_public_gw{gameweek:02d}.json"
        path.write_text(json.dumps({"generated_at": generated_at}))

    def test_absent_is_not_current(self):
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_a_fresh_projection_is_current(self):
        self.write(2, "2026-08-24T06:00:00Z")
        self.assertTrue(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_an_aged_projection_is_not_current(self):
        self.write(2, "2026-08-23T06:00:00Z")  # 30 hours old
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_another_gameweek_s_file_does_not_count(self):
        # The exact failure being fixed: gw01 on disk, gw02 requested.
        self.write(1, "2026-08-24T06:00:00Z")
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_an_unreadable_stamp_is_not_current(self):
        path = self.root / "fpl" / "xp_public_gw02.json"
        path.write_text("{not json")
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_a_missing_stamp_is_not_current(self):
        self.write(2, None)
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))
