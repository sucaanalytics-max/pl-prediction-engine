"""
The published projections view, and its prune.

## What matters here

**The prune must be strictly-before.** A rerun of the current gameweek that
deleted its own output would leave the page with nothing, and the file has
already been written by the time `prune` runs — so an off-by-one here is not a
tidy-up bug, it is a blank screen.

**A player with no bootstrap entry is still published.** Dropping him would make
the published universe depend on how complete the bootstrap happened to be, and
a player silently missing from a projections table is indistinguishable from one
nobody projected. He is emitted with null labels instead.

**`notable` ranks on upside, not on the mean.** A weekly-win entry is buying the
right tail, and a mean ranking buries exactly that. The ordering must also be
total, or a rerun reshuffles the table for no reason.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from pipeline.fpl import public_xp


def player(element_id: int, **over):
    row = {
        "element_id": element_id,
        "xp": 6.4,
        "xp_sd": 3.7,
        "mode": 2,
        "p_appears": 0.97,
        "p_60": 0.88,
        "e_minutes": 79.0,
        "e_goals": 0.42,
        "e_assists": 0.21,
        "p_goal": 0.35,
        "p_clean_sheet": 0.31,
        "p_ge_2": 0.95,
        "p_ge_5": 0.51,
        "p_ge_10": 0.15,
        "q10": 1.0,
        "q50": 5.0,
        "q90": 13.0,
        "n_fixtures": 1,
        "blank": False,
        "decomposition": {
            "appearance": 1.9, "goals": 2.1, "assists": 0.6,
            "clean_sheets": 0.3, "other": 1.5,
        },
        # Private-only fields that must not travel.
        "mc_se": 0.08,
        "p_ge_15": 0.02,
        "q99": 18.0,
        "p_multi_goal": 0.04,
    }
    row.update(over)
    return row


def artifact(*players, gameweek: int = 7):
    return {
        "metadata": {
            "gameweek": gameweek, "season": "2627", "n_draws": 10_000,
            "schema_version": 3,
        },
        "players": list(players),
        "diagnostics": {"whatever": True},
    }


NAMES = {1: ("Salah", "Liverpool", "MID"), 2: ("Haaland", "Man City", "FWD")}


class BuildTests(unittest.TestCase):
    def test_it_carries_the_decision_relevant_fields(self):
        view = public_xp.build(artifact(player(1)), NAMES, generated_at="t")
        row = view["players"][0]
        for field in ("xp", "mode", "p_ge_10", "q10", "q90", "decomposition"):
            self.assertIn(field, row)

    def test_it_leaves_the_optimiser_only_fields_behind(self):
        view = public_xp.build(artifact(player(1)), NAMES, generated_at="t")
        row = view["players"][0]
        for field in ("mc_se", "q99", "p_ge_15", "p_multi_goal"):
            self.assertNotIn(field, row)

    def test_it_labels_players_so_the_page_needs_no_join(self):
        view = public_xp.build(artifact(player(1)), NAMES, generated_at="t")
        self.assertEqual(view["players"][0]["name"], "Salah")
        self.assertEqual(view["players"][0]["position"], "MID")

    def test_an_unlabelled_player_is_still_published(self):
        # Dropping him would make the universe depend on bootstrap completeness.
        view = public_xp.build(artifact(player(99)), NAMES, generated_at="t")
        self.assertEqual(len(view["players"]), 1)
        self.assertIsNone(view["players"][0]["name"])

    def test_a_row_with_no_element_id_is_dropped(self):
        # Unattributable, and people make transfers from this table.
        broken = player(1)
        del broken["element_id"]
        view = public_xp.build(artifact(broken, player(2)), NAMES, generated_at="t")
        self.assertEqual(len(view["players"]), 1)

    def test_it_carries_the_draw_count(self):
        # p_ge_10 = 0.15 from 2,000 draws and from 10,000 are different claims
        # about precision.
        view = public_xp.build(artifact(player(1)), NAMES, generated_at="t")
        self.assertEqual(view["n_draws"], 10_000)

    def test_the_diagnostics_block_does_not_travel(self):
        view = public_xp.build(artifact(player(1)), NAMES, generated_at="t")
        self.assertNotIn("diagnostics", view)

    def test_a_missing_field_is_omitted_rather_than_nulled(self):
        thin = player(1)
        del thin["mode"]
        view = public_xp.build(artifact(thin), NAMES, generated_at="t")
        self.assertNotIn("mode", view["players"][0])

    def test_an_empty_artifact_yields_an_empty_player_list(self):
        view = public_xp.build(artifact(), NAMES, generated_at="t")
        self.assertEqual(view["players"], [])
        self.assertEqual(view["gameweek"], 7)


class PruneTests(unittest.TestCase):
    def _dir(self, *gameweeks):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)
        for gw in gameweeks:
            (directory / f"xp_public_gw{gw:02d}.json").write_text("{}", encoding="utf-8")
        return directory

    def test_it_removes_earlier_gameweeks(self):
        directory = self._dir(5, 6, 7)
        public_xp.prune(directory, keep=7)
        remaining = sorted(p.name for p in directory.glob("xp_public_gw*.json"))
        self.assertEqual(remaining, ["xp_public_gw07.json"])

    def test_it_never_removes_the_gameweek_it_is_keeping(self):
        # The current file is already written when this runs, so an off-by-one
        # here is a blank screen rather than an untidy directory.
        directory = self._dir(7)
        public_xp.prune(directory, keep=7)
        self.assertTrue((directory / "xp_public_gw07.json").exists())

    def test_it_leaves_later_gameweeks_alone(self):
        # A lookahead published on purpose is not this function's to remove.
        directory = self._dir(7, 8)
        public_xp.prune(directory, keep=7)
        self.assertTrue((directory / "xp_public_gw08.json").exists())

    def test_it_ignores_files_it_does_not_own(self):
        directory = self._dir(5)
        (directory / "messages.json").write_text("{}", encoding="utf-8")
        (directory / "decision_public_gw05_season.json").write_text("{}", encoding="utf-8")
        public_xp.prune(directory, keep=7)
        self.assertTrue((directory / "messages.json").exists())
        self.assertTrue((directory / "decision_public_gw05_season.json").exists())

    def test_a_missing_directory_is_not_an_error(self):
        self.assertEqual(public_xp.prune(Path("/nonexistent/nowhere"), keep=7), [])


class WriteTests(unittest.TestCase):
    def test_it_writes_and_prunes_in_one_call(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)
        (directory / "xp_public_gw06.json").write_text("{}", encoding="utf-8")

        view = public_xp.build(artifact(player(1)), NAMES, generated_at="t")
        path = public_xp.write(view, directory)

        assert path is not None
        self.assertEqual(path.name, "xp_public_gw07.json")
        self.assertFalse((directory / "xp_public_gw06.json").exists())
        written = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(written["players"][0]["name"], "Salah")

    def test_it_refuses_a_view_with_no_gameweek(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        # No gameweek means no filename and nothing that can ever supersede it.
        view = public_xp.build(
            {"metadata": {}, "players": []}, NAMES, generated_at="t",
        )
        self.assertIsNone(public_xp.write(view, Path(tmp.name)))


class NotableTests(unittest.TestCase):
    def test_it_ranks_on_upside_not_on_the_mean(self):
        rows = [
            {"element_id": 1, "xp": 7.0, "p_ge_10": 0.05},
            {"element_id": 2, "xp": 5.0, "p_ge_10": 0.30},
        ]
        # The weekly entry is buying the right tail, which a mean ranking hides.
        self.assertEqual(public_xp.notable(rows)[0]["element_id"], 2)

    def test_ties_break_on_xp_then_on_id_so_the_order_is_total(self):
        rows = [
            {"element_id": 3, "xp": 5.0, "p_ge_10": 0.2},
            {"element_id": 2, "xp": 5.0, "p_ge_10": 0.2},
            {"element_id": 1, "xp": 6.0, "p_ge_10": 0.2},
        ]
        # A partial order would reshuffle the table on every rerun.
        self.assertEqual([r["element_id"] for r in public_xp.notable(rows)], [1, 2, 3])

    def test_it_honours_the_limit(self):
        rows = [{"element_id": i, "xp": 1.0, "p_ge_10": 0.1} for i in range(200)]
        self.assertEqual(len(public_xp.notable(rows, limit=25)), 25)

    def test_a_missing_probability_sorts_last_rather_than_raising(self):
        rows = [{"element_id": 1, "xp": 5.0}, {"element_id": 2, "p_ge_10": 0.4}]
        self.assertEqual(public_xp.notable(rows)[0]["element_id"], 2)


if __name__ == "__main__":
    unittest.main()
