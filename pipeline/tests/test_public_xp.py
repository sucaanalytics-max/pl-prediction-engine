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


class PublishedByAProcessThatActuallyRunsTests(unittest.TestCase):
    """
    The view must be published by something that runs.

    ## The measured defect

    `public_xp` was complete and tested, with exactly one caller: `run_agent.py`. The
    agent self-gates on phase and is skipped for roughly ten days of every fourteen —
    measured on 2026-08-12, `needs_work` was false on every run for days.

    So the view was never published at all. No `xp_public_gw*.json` existed anywhere
    on disk or in git history, while `predictions/fpl/xp_gw01.json` held 577 players
    at 5,000 draws with quantiles, a points decomposition and Monte Carlo standard
    errors. `/players` fell back to last season's actuals, and the richest thing this
    repo computes reached no screen.

    A tested module with an unreachable caller passes every test it has. These assert
    reachability instead.
    """

    def _source(self, *parts):
        from pathlib import Path
        return (Path(__file__).resolve().parents[1].joinpath(*parts)).read_text(
            encoding="utf-8",
        )

    def test_the_daily_pipeline_publishes_it(self):
        """
        THE test.

        The pipeline is the process that WRITES the source artifact and runs every
        day, so it is the one that can keep the display copy from drifting.
        """
        source = self._source("run_pipeline.py")
        self.assertIn("publish_from_artifact", source)

    def test_it_publishes_the_xp_path_and_not_the_result_dict(self):
        # `export_gameweek_xp` returns {"xp": path, "sim_params": path}. Passing the
        # dict would raise inside a broad `except` that logs a warning and continues,
        # so the publish would have failed silently on every run.
        source = self._source("run_pipeline.py")
        self.assertIn('xp_written["xp"]', source)
        self.assertNotIn("publish_from_artifact(\n                xp_written,", source)

    def test_the_publish_happens_after_the_export(self):
        source = self._source("run_pipeline.py")
        self.assertLess(
            source.index("export_gameweek_xp("),
            source.index("publish_from_artifact("),
            "the display copy cannot be built before the artifact it derives from",
        )

    def test_one_implementation_two_callers(self):
        """
        Both the agent and the pipeline call the SAME function.

        Copying twenty lines into the pipeline would have been a second thing to keep
        in step — and the reason the view was missing was a caller that never ran, so
        duplicating callers without sharing the implementation would repeat the class.
        """
        from pipeline.fpl import public_xp

        self.assertTrue(hasattr(public_xp, "publish_from_artifact"))
        agent = self._source("learning", "run_agent.py")
        self.assertIn("public_xp", agent)

    def test_it_is_non_fatal(self):
        # A projection that has been computed and validated must not be lost because
        # the display copy failed. It returns None rather than raising.
        import tempfile
        from pathlib import Path

        from pipeline.fpl.public_xp import publish_from_artifact

        with tempfile.TemporaryDirectory() as tmp:
            out = publish_from_artifact(
                Path(tmp) / "does-not-exist.json", {}, Path(tmp),
            )
        self.assertIsNone(out)

    def test_it_prunes_after_writing_not_before(self):
        # A prune that ran first would delete the file it just wrote on a rerun of the
        # current gameweek, leaving the page with nothing.
        source = self._source("fpl", "public_xp.py")
        publish = source[source.index("def publish_from_artifact"):]
        self.assertLess(
            publish.index("write(view"),
            publish.index("prune("),
        )

    def test_the_frontend_reads_the_name_this_writes(self):
        """
        The filename is the contract.

        The frontend descriptor asks for `fpl/xp_public_gw{NN}.json`, and the private
        artifact is `xp_gw{NN}.json` — one underscore-separated word apart. Reading
        the wrong one is a blank section, which is how this went unnoticed.
        """
        from pathlib import Path

        descriptor = (
            Path(__file__).resolve().parents[2]
            / "frontend" / "lib" / "data" / "projections.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("fpl/xp_public_gw", descriptor)

        from pipeline.fpl import public_xp
        self.assertTrue(public_xp.FILENAME.match("xp_public_gw01.json"))


class HorizonBlockTests(unittest.TestCase):
    """
    The per-week projections, which the agent computed on every horizon run and
    published on none of them.

    The interesting cases are all about what NOT to publish: a week whose
    numbers would be mistaken for a better estimate of the same thing, and a
    week the projection could not fill.
    """

    def test_it_drops_week_zero(self):
        """
        Week 0 covers the current gameweek at the horizon draw count, while the
        row's own ``xp`` covers it at the decision draw count. Publishing both
        puts two different numbers for the same player in the same gameweek on
        the same screen, and the weaker one is indistinguishable from the
        stronger.
        """
        block = public_xp.build_horizon_block(
            [{1: 5.0}, {1: 4.2}, {1: 3.9}], first_gameweek=3, n_draws=5000,
        )
        self.assertIsNotNone(block)
        self.assertEqual([w["gameweek"] for w in block["weeks"]], [4, 5])

    def test_it_carries_the_draw_count(self):
        # 5,000 draws and 10,000 are different statements about precision, and a
        # horizon number in a column beside a decision number must say which.
        block = public_xp.build_horizon_block(
            [{1: 5.0}, {1: 4.2}], first_gameweek=3, n_draws=5000,
        )
        self.assertEqual(block["n_draws"], 5000)

    def test_it_keys_by_element_id_as_a_string(self):
        # JSON object keys are strings; the consumer parses them back. Stating
        # it here so a change to int keys fails loudly rather than at narrow time.
        block = public_xp.build_horizon_block(
            [{1: 5.0}, {412: 4.25}], first_gameweek=1, n_draws=5000,
        )
        self.assertEqual(block["weeks"][0]["xp"], {"412": 4.25})

    def test_it_omits_a_week_it_could_not_fill(self):
        # Absent reads as "no view for that week"; an empty map reads as "every
        # player projected to zero", which is a different and much worse claim.
        block = public_xp.build_horizon_block(
            [{1: 5.0}, {}, {1: 3.9}], first_gameweek=3, n_draws=5000,
        )
        self.assertEqual([w["gameweek"] for w in block["weeks"]], [5])

    def test_it_returns_none_without_a_horizon(self):
        # `_project_horizon` returns None rather than raising when it cannot
        # build one, and a myopic run must still publish its own gameweek.
        self.assertIsNone(public_xp.build_horizon_block(None, 3, 5000))
        self.assertIsNone(public_xp.build_horizon_block([], 3, 5000))
        self.assertIsNone(public_xp.build_horizon_block([{1: 5.0}], 3, 5000))
        self.assertIsNone(public_xp.build_horizon_block([{1: 5.0}, {1: 4.0}], None, 5000))

    def test_the_view_omits_the_key_entirely_without_a_horizon(self):
        # Not `"horizon": null`. A key whose value is null invites a consumer to
        # read it as a published absence rather than as nothing published.
        view = public_xp.build(
            {"metadata": {"gameweek": 3}, "players": []},
            {},
            generated_at="2026-08-14T00:00:00Z",
        )
        self.assertNotIn("horizon", view)

    def test_the_view_carries_it_when_there_is_one(self):
        view = public_xp.build(
            {"metadata": {"gameweek": 3, "n_draws": 10000}, "players": []},
            {},
            generated_at="2026-08-14T00:00:00Z",
            horizon=[{1: 5.0}, {1: 4.2}],
            horizon_draws=5000,
        )
        self.assertEqual(view["horizon"]["weeks"][0]["gameweek"], 4)
        # The two draw counts sit side by side and are not the same number.
        self.assertEqual(view["n_draws"], 10000)
        self.assertEqual(view["horizon"]["n_draws"], 5000)
