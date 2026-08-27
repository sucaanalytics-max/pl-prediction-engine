"""
The horizon block must survive a publisher that has none to offer.

Two processes write `xp_public_gw{NN}.json`. The AGENT solves a multi-week horizon and
passes it; the daily PIPELINE does not solve one and has nothing to pass. `run_pipeline`
carried a comment asserting the two "cannot disagree: it is a pure function of an artifact
neither of them mutates" — which was false. They disagree on SCHEMA: the agent published a
view carrying the `horizon` block the frontend's plan grid is built from, and the next
daily run overwrote it with one that had none.

`_keep_existing_horizon` closes that. These tests pin the shape it has to preserve, taken
from the real published view rather than invented: `horizon` is
`{"n_draws": 5000, "weeks": [...7]}`, and there is NO top-level `horizon_draws` key —
`build_horizon_block` puts the count inside the block. An earlier version of the helper
copied a top-level `horizon_draws` that has never existed in the output, which is the kind
of line that survives because it can never fire.
"""
import json
import tempfile
import unittest
from pathlib import Path

from pipeline.fpl import public_xp

# The real published shape, trimmed. `weeks` is a list of {element_id: xp} maps.
PUBLISHED_HORIZON = {
    "n_draws": 5000,
    "weeks": [{"1": 2.6}, {"1": 2.3}, {"1": 2.0}, {"1": 2.3}, {"1": 2.0}, {"1": 2.3}, {"1": 2.2}],
}


class TestKeepExistingHorizon(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def publish(self, payload):
        (self.dir / "xp_public_gw02.json").write_text(json.dumps(payload), encoding="utf-8")

    def test_a_horizonless_view_inherits_the_published_horizon(self):
        self.publish({"gameweek": 2, "horizon": PUBLISHED_HORIZON, "players": []})
        merged = public_xp._keep_existing_horizon({"gameweek": 2, "players": []}, self.dir)
        self.assertEqual(merged["horizon"], PUBLISHED_HORIZON)
        # The draws count rides inside the block, so carrying the block carries it.
        self.assertEqual(merged["horizon"]["n_draws"], 5000)
        self.assertEqual(len(merged["horizon"]["weeks"]), 7)

    def test_no_top_level_horizon_draws_is_invented(self):
        # `build` emits none, so neither may this. A key that appears only on the
        # carry-forward path would be a schema difference created by the fix.
        self.publish({"gameweek": 2, "horizon": PUBLISHED_HORIZON})
        merged = public_xp._keep_existing_horizon({"gameweek": 2}, self.dir)
        self.assertNotIn("horizon_draws", merged)

    def test_a_view_that_HAS_a_horizon_is_untouched(self):
        # The agent's own publish must not be second-guessed by a file on disk.
        self.publish({"gameweek": 2, "horizon": PUBLISHED_HORIZON})
        fresh = {"n_draws": 10_000, "weeks": [{"1": 9.9}]}
        merged = public_xp._keep_existing_horizon({"gameweek": 2, "horizon": fresh}, self.dir)
        self.assertEqual(merged["horizon"], fresh)

    def test_no_previous_file_is_not_an_error(self):
        view = {"gameweek": 2, "players": []}
        self.assertEqual(public_xp._keep_existing_horizon(dict(view), self.dir), view)

    def test_an_unreadable_previous_file_is_not_an_error(self):
        (self.dir / "xp_public_gw02.json").write_text("not json", encoding="utf-8")
        view = {"gameweek": 2}
        self.assertEqual(public_xp._keep_existing_horizon(dict(view), self.dir), view)

    def test_a_previous_file_without_a_horizon_carries_nothing(self):
        self.publish({"gameweek": 2, "players": []})
        merged = public_xp._keep_existing_horizon({"gameweek": 2}, self.dir)
        self.assertNotIn("horizon", merged)

    def test_it_reads_only_the_file_it_is_about_to_replace(self):
        # Keyed on the view's own gameweek. Reading GW3's horizon into GW2's view would
        # publish one week's plan under another week's number.
        (self.dir / "xp_public_gw03.json").write_text(
            json.dumps({"gameweek": 3, "horizon": PUBLISHED_HORIZON}), encoding="utf-8")
        merged = public_xp._keep_existing_horizon({"gameweek": 2}, self.dir)
        self.assertNotIn("horizon", merged)

    def test_a_view_with_no_gameweek_is_left_alone(self):
        # Without a gameweek there is no file to key on, and guessing one would be the
        # same defect as reading the wrong week's.
        self.publish({"gameweek": 2, "horizon": PUBLISHED_HORIZON})
        self.assertEqual(public_xp._keep_existing_horizon({"players": []}, self.dir),
                         {"players": []})


class TestTheRealPublishedView(unittest.TestCase):
    def test_the_shape_these_tests_assume_is_the_shape_on_disk(self):
        # If the published view ever stops matching, the fixture above is a fiction and
        # every assertion in this file is testing the wrong thing.
        path = Path("frontend/public/predictions/fpl")
        views = sorted(path.glob("xp_public_gw*.json")) if path.is_dir() else []
        if not views:
            self.skipTest("no published view in this checkout")
        published = json.loads(views[-1].read_text(encoding="utf-8"))
        self.assertNotIn("horizon_draws", published,
                         "build now emits a top-level horizon_draws; the helper must carry it")
        horizon = published.get("horizon")
        if horizon is None:
            self.skipTest("the published view carries no horizon right now")
        self.assertEqual(sorted(horizon.keys()), ["n_draws", "weeks"])
        self.assertIsInstance(horizon["weeks"], list)


if __name__ == "__main__":
    unittest.main()
