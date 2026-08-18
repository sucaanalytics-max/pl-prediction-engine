"""
Contract tests for the gameweek expected-points artifact.

Two things are being protected. First, that a violated invariant stops the write
rather than producing a plausible-looking file — the pipeline is unattended, so
an inconsistency that reaches disk becomes a squad recommendation with nothing
revealing the fault. Second, that double and blank gameweeks are representable
at all: the engine this replaces mishandles both, silently.
"""
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd

from pipeline.fpl.artifacts import (
    ACCEPTED_RATE_SOURCES,
    RATE_SOURCES,
    SCHEMA_DIR,
    ArtifactContractError,
    assert_valid_xp_artifact,
    build_sim_params,
    build_xp_artifact,
    export_gameweek_xp,
    validate_xp_artifact,
    write_json_atomically,
)
from pipeline.fpl.rules import load_rules
from pipeline.models.minutes import MinutesModel
from pipeline.models.player_events import PlayerEventRates
from pipeline.simulation.gameweek_sim import (
    FixtureSpec,
    simulate_gameweek,
    stable_hash,
)
from pipeline.simulation.player_sim import PlayerInput

RULES = load_rules()
GENERATED_AT = "2026-08-20T06:00:00Z"


def _history():
    rows = []
    for team, prefix in (("Alpha", "a"), ("Beta", "b"), ("Gamma", "g")):
        spec = (
            [(f"{prefix}k{i}", "GKP", 1.0 if i == 1 else 0.0) for i in (1, 2)]
            + [(f"{prefix}d{i}", "DEF", 1.0 if i <= 3 else 0.2) for i in range(1, 7)]
            + [(f"{prefix}m{i}", "MID", 1.0 if i <= 4 else 0.2) for i in range(1, 7)]
            + [(f"{prefix}f{i}", "FWD", 1.0 if i <= 2 else 0.15) for i in range(1, 5)]
        )
        for name, position, start_rate in spec:
            for gameweek in range(1, 39):
                started = (gameweek % 10) / 10.0 < start_rate
                minutes = 90 if started else (20 if gameweek % 3 == 0 and start_rate > 0.05 else 0)
                scored = 1 if position == "FWD" and started and gameweek % 4 == 0 else 0
                rows.append({
                    "name_key": name, "position_norm": position, "team": team,
                    "GW": gameweek, "minutes": minutes,
                    "starts": 1 if started else 0, "goals_scored": scored,
                    "assists": 1 if position == "MID" and started and gameweek % 5 == 0 else 0,
                    "clean_sheets": 1 if position in ("GKP", "DEF") and started and gameweek % 3 == 0 else 0,
                    "bonus": 3 if scored else 0,
                    "yellow_cards": 1 if started and gameweek % 9 == 0 else 0,
                    "saves": (3 if position == "GKP" else 0) * minutes / 90.0,
                    "expected_goals": (0.5 if position == "FWD" else 0.05) * minutes / 90.0,
                    "expected_assists": (0.2 if position == "MID" else 0.03) * minutes / 90.0,
                    "clearances_blocks_interceptions": (6 if position == "DEF" else 2) * minutes / 90.0,
                    "tackles": 2 * minutes / 90.0,
                    "recoveries": 5 * minutes / 90.0,
                })
    return pd.DataFrame(rows)


HISTORY = _history()
MINUTES_MODEL = MinutesModel().fit(
    HISTORY, key="name_key", position_column="position_norm"
)
EVENTS = PlayerEventRates().fit(
    HISTORY, key="name_key", position_column="position_norm", rules=RULES
)
ELEMENT_IDS = {
    name: 1000 + index
    for index, name in enumerate(sorted(HISTORY["name_key"].unique()))
}


def _squad(prefix):
    players = []
    for name in sorted(n for n in ELEMENT_IDS if n.startswith(prefix)):
        position = HISTORY.loc[HISTORY["name_key"] == name, "position_norm"].iloc[0]
        players.append(
            PlayerInput(
                element_id=ELEMENT_IDS[name],
                position=position,
                roles=MINUTES_MODEL.predict(position, name),
                rates=EVENTS.rates(position, name),
                player_key=name,
            )
        )
    return players


SQUADS = {"Alpha": _squad("a"), "Beta": _squad("b"), "Gamma": _squad("g")}


def _draws(fixtures, n_draws=500, all_ids=None):
    return simulate_gameweek(
        fixtures, SQUADS, EVENTS, RULES, n_draws=n_draws,
        seed_entropy=7, all_element_ids=all_ids,
    )


SINGLE = [
    FixtureSpec("m1", 5, "Alpha", "Beta", 1.6, 1.1, "2026-09-12T14:00:00Z",
                rate_source="market_blend"),
]
# Alpha plays twice: a double gameweek. Gamma does not play at all: a blank.
DOUBLE = [
    FixtureSpec("m1", 5, "Alpha", "Beta", 1.6, 1.1, "2026-09-12T14:00:00Z",
                rate_source="market_blend"),
    FixtureSpec("m2", 5, "Beta", "Alpha", 1.3, 1.4, "2026-09-15T19:00:00Z",
                rate_source="dixon_coles_posterior+level"),
]


class StableHashTests(unittest.TestCase):
    def test_hash_is_stable_across_processes(self):
        """
        Python's built-in hash is salted per interpreter, so using it to seed a
        simulation would make runs irreproducible while looking deterministic.
        """
        self.assertEqual(stable_hash("Alpha_Beta"), stable_hash("Alpha_Beta"))
        self.assertNotEqual(stable_hash("a"), stable_hash("b"))

    def test_hash_is_pinned_to_a_known_value(self):
        """
        Pinned, not just self-consistent. A self-consistent hash would still let
        a change of algorithm silently reseed every simulation, so a diff in an
        artifact would no longer mean a real parameter change.
        """
        import hashlib

        expected = int.from_bytes(
            hashlib.sha256(b"20260912_Alpha_Beta").digest()[:8], "big"
        )
        self.assertEqual(stable_hash("20260912_Alpha_Beta"), expected)


class GameweekCombinationTests(unittest.TestCase):
    def test_single_fixture_players_have_one_fixture(self):
        draws = _draws(SINGLE)
        rows = {row["element_id"]: row for row in draws.summary_rows()}
        alpha = rows[SQUADS["Alpha"][0].element_id]
        self.assertEqual(alpha["n_fixtures"], 1)
        self.assertFalse(alpha["blank"])

    def test_double_gameweek_sums_both_fixtures_on_one_draw(self):
        """
        The defect in the engine this replaces: it slices fixtures rather than
        gameweeks, so a double's second match is dropped from captain expected
        value entirely.
        """
        single = _draws(SINGLE)
        double = _draws(DOUBLE)
        element = SQUADS["Alpha"][0].element_id

        single_row = next(
            r for r in single.summary_rows() if r["element_id"] == element
        )
        double_row = next(
            r for r in double.summary_rows() if r["element_id"] == element
        )
        self.assertEqual(single_row["n_fixtures"], 1)
        self.assertEqual(double_row["n_fixtures"], 2)
        # Two fixtures must project more points and more minutes than one.
        self.assertGreater(double_row["xp"], single_row["xp"])
        self.assertGreater(double_row["e_minutes"], single_row["e_minutes"])

    def test_double_gameweek_minutes_can_exceed_ninety(self):
        draws = _draws(DOUBLE)
        element = SQUADS["Alpha"][0].element_id
        column = draws.minutes[:, draws.index_of(element)]
        self.assertGreater(int(column.max()), 90)

    def test_blank_gameweek_players_are_present_with_zero(self):
        """Absent and 'projected zero' must be distinguishable."""
        draws = _draws(SINGLE)
        rows = {row["element_id"]: row for row in draws.summary_rows()}
        gamma = rows[SQUADS["Gamma"][0].element_id]
        self.assertTrue(gamma["blank"])
        self.assertEqual(gamma["fixtures"], [])
        self.assertEqual(gamma["xp"], 0.0)
        self.assertEqual(gamma["p_appears"], 0.0)

    def test_universe_is_stable_between_gameweeks(self):
        """
        A universe that changes shape cannot support paired comparisons, which is
        how the ledger will later score one model against another.
        """
        single = _draws(SINGLE)
        double = _draws(DOUBLE)
        self.assertEqual(set(single.element_ids), set(double.element_ids))

    def test_extra_element_ids_are_emitted_as_blanks(self):
        draws = _draws(SINGLE, all_ids=[999_001])
        rows = {row["element_id"]: row for row in draws.summary_rows()}
        self.assertIn(999_001, rows)
        self.assertTrue(rows[999_001]["blank"])

    def test_identical_seeds_reproduce_identical_output(self):
        first = _draws(SINGLE)
        second = _draws(SINGLE)
        np.testing.assert_array_equal(first.points, second.points)

    def test_a_fixture_without_a_squad_is_skipped_and_reported(self):
        """Simulating it anyway would emit confident zeros for both clubs."""
        draws = _draws([FixtureSpec("mX", 5, "Alpha", "Nowhere", 1.5, 1.0)])
        self.assertEqual(draws.notes["n_fixtures_skipped"], 1)
        self.assertIn("mX", draws.notes["skipped_fixtures"])

    def test_diagnostics_count_doubles_and_blanks(self):
        draws = _draws(DOUBLE)
        self.assertGreater(draws.notes["n_double_gameweek_players"], 0)
        self.assertGreater(draws.notes["n_blank_gameweek_players"], 0)


class ArtifactContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.draws = _draws(DOUBLE)
        cls.artifact = build_xp_artifact(
            cls.draws, "2627", GENERATED_AT, RULES, DOUBLE
        )

    def test_a_well_formed_artifact_passes(self):
        self.assertEqual(validate_xp_artifact(self.artifact), [])

    def test_metadata_declares_every_approximation(self):
        """An undeclared approximation is indistinguishable from a claim."""
        metadata = self.artifact["metadata"]
        self.assertEqual(metadata["bonus_method"], "empirical_conditional_bucket")
        self.assertFalse(metadata["bonus_tail_claim"])
        self.assertFalse(metadata["substitution_count_exact"])
        self.assertFalse(metadata["dgw_rotation_correlation_modelled"])
        self.assertEqual(metadata["goal_minute_model"], "uniform_1_90")

    def test_metadata_records_the_parameters_that_produced_it(self):
        self.assertIn("minutes.start_shrinkage", self.artifact["metadata"]["parameters"])

    def test_metadata_records_whether_rules_were_degraded(self):
        self.assertIn("fpl_rules_source", self.artifact["metadata"])
        self.assertIn("fpl_rules_degraded", self.artifact["metadata"])

    def test_p_60_above_p_appears_is_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["players"][0]["p_60"] = 1.0
        broken["players"][0]["p_appears"] = 0.5
        self.assertTrue(
            any("p_60" in problem for problem in validate_xp_artifact(broken))
        )

    def test_multi_goal_above_goal_is_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["players"][0]["p_goal"] = 0.1
        broken["players"][0]["p_multi_goal"] = 0.4
        self.assertTrue(
            any("p_multi_goal" in problem for problem in validate_xp_artifact(broken))
        )

    def test_non_monotone_tail_is_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["players"][0]["p_ge_10"] = 0.9
        broken["players"][0]["p_ge_5"] = 0.1
        self.assertTrue(
            any("p_ge_10" in problem for problem in validate_xp_artifact(broken))
        )

    def test_non_monotone_quantiles_are_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["players"][0]["q90"] = -5
        self.assertTrue(
            any("q90" in problem for problem in validate_xp_artifact(broken))
        )

    def test_probability_outside_the_unit_interval_is_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["players"][0]["p_appears"] = 1.4
        self.assertTrue(
            any("outside" in problem for problem in validate_xp_artifact(broken))
        )

    def test_a_blank_player_with_points_is_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        blank = next(p for p in broken["players"] if p["blank"])
        blank["xp"] = 4.2
        self.assertTrue(
            any("blank" in problem for problem in validate_xp_artifact(broken))
        )

    def test_duplicate_element_ids_are_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["players"].append(json.loads(json.dumps(broken["players"][0])))
        self.assertTrue(
            any("duplicate" in problem for problem in validate_xp_artifact(broken))
        )

    def test_non_finite_values_are_rejected(self):
        """
        json.dumps emits bare NaN and Infinity. Python re-reads them; the
        browser's JSON.parse does not. Without this the file looks fine on this
        side and breaks the page silently.
        """
        broken = json.loads(json.dumps(self.artifact))
        broken["players"][0]["xp"] = float("nan")
        problems = validate_xp_artifact(broken)
        self.assertTrue(any("finite" in problem for problem in problems), problems)

    def test_infinity_is_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["players"][0]["q90"] = float("inf")
        self.assertTrue(
            any("finite" in problem for problem in validate_xp_artifact(broken))
        )

    def test_missing_metadata_is_rejected(self):
        self.assertTrue(validate_xp_artifact({"players": []}))

    def test_assert_raises_on_a_broken_artifact(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["players"][0]["p_appears"] = 2.0
        with self.assertRaises(ArtifactContractError):
            assert_valid_xp_artifact(broken)


class FixtureRateSourceContractTests(unittest.TestCase):
    """A published fixture with a null rate_source is indistinguishable from
    one nobody ever wired provenance for, and an unrecognised value means the
    blend grew a branch nothing downstream was told about. Both must fail
    the contract, not just reach disk with the FPL layer silently reading
    unanchored rates."""

    @classmethod
    def setUpClass(cls):
        cls.artifact = build_xp_artifact(
            _draws(DOUBLE), "2627", GENERATED_AT, RULES, DOUBLE
        )

    def test_a_well_formed_artifact_with_rate_sources_passes(self):
        self.assertEqual(validate_xp_artifact(self.artifact), [])

    def test_null_rate_source_is_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["fixtures"][0]["rate_source"] = None
        problems = validate_xp_artifact(broken)
        self.assertTrue(
            any("rate_source is null or missing" in p for p in problems), problems
        )

    def test_missing_rate_source_key_is_rejected(self):
        broken = json.loads(json.dumps(self.artifact))
        del broken["fixtures"][0]["rate_source"]
        problems = validate_xp_artifact(broken)
        self.assertTrue(
            any("rate_source is null or missing" in p for p in problems), problems
        )

    def test_unrecognised_rate_source_is_rejected(self):
        """An unexpected fourth value is exactly the case worth failing on —
        it means the blend grew a branch nothing here was updated for."""
        broken = json.loads(json.dumps(self.artifact))
        broken["fixtures"][0]["rate_source"] = "vibes"
        problems = validate_xp_artifact(broken)
        self.assertTrue(
            any("not a recognised value" in p for p in problems), problems
        )

    def test_each_accepted_rate_source_passes(self):
        for source in ACCEPTED_RATE_SOURCES:
            with self.subTest(rate_source=source):
                broken = json.loads(json.dumps(self.artifact))
                for fixture in broken["fixtures"]:
                    fixture["rate_source"] = source
                problems = validate_xp_artifact(broken)
                self.assertEqual([p for p in problems if "rate_source" in p], [])

    def test_assert_raises_on_a_null_rate_source(self):
        broken = json.loads(json.dumps(self.artifact))
        broken["fixtures"][0]["rate_source"] = None
        with self.assertRaises(ArtifactContractError):
            assert_valid_xp_artifact(broken)


class ContractAcceptsEveryRealProducer(unittest.TestCase):
    """Durable guard, Fix round 2's CRITICAL finding: ACCEPTED_RATE_SOURCES
    must stay a superset of every string a real producer can actually
    return — not a fixed list this test maintains independently, since that
    would only re-encode the same assumption that just broke the seal. Each
    test here exercises the REAL producer function and asserts whatever it
    actually returns is accepted, so a future change to any producer that
    introduces a new source string fails here, in CI, rather than at a
    gameweek deadline.
    """

    def test_resolve_rates_flat_default_is_accepted(self):
        from pipeline.models.fixture_rates import resolve_rates
        result = resolve_rates("m1", "Alpha", "Beta", exported=None, strengths=None)
        self.assertEqual(result.source, "flat_default")
        self.assertIn(result.source, ACCEPTED_RATE_SOURCES)

    def test_resolve_rates_archive_team_strengths_is_accepted(self):
        """TeamStrengths is a plain class (its own __init__ takes no
        arguments; `.fit(archive)` populates it) — constructed bare and
        populated directly here rather than guessing a keyword constructor
        it doesn't have."""
        from pipeline.models.fixture_rates import TeamStrengths, resolve_rates
        strengths = TeamStrengths()
        strengths.attack = {"Alpha": 1.1, "Beta": 0.9}
        strengths.defence = {"Alpha": 1.0, "Beta": 1.0}
        strengths.home_share = 0.55
        strengths.league_mean_goals = 1.35
        strengths.fitted = True
        result = resolve_rates(
            "m1", "Alpha", "Beta", exported=None, strengths=strengths
        )
        self.assertEqual(result.source, "archive_team_strengths")
        self.assertIn(result.source, ACCEPTED_RATE_SOURCES)

    def test_resolve_rates_prefers_and_passes_through_the_exported_posterior(self):
        from pipeline.models.fixture_rates import FixtureRates, resolve_rates
        exported = {
            "m1": FixtureRates("Alpha", "Beta", 1.6, 1.1, "dixon_coles_posterior+level")
        }
        result = resolve_rates("m1", "Alpha", "Beta", exported=exported, strengths=None)
        self.assertEqual(result.source, "dixon_coles_posterior+level")
        self.assertIn(result.source, ACCEPTED_RATE_SOURCES)

    def test_load_exported_rates_legacy_payload_fallback_is_accepted(self):
        """A fixture_xg.json row missing its OWN rate_source falls back to
        the PAYLOAD-level `source` field (fixture_rates.py's
        load_exported_rates, the "pre-anchor file" branch in its own
        docstring), which fixture_rates.py's export_fixture_xg can set to
        "dixon_coles_posterior+market_blend" — a string distinct from every
        RATE_SOURCES value. Exercised through a real temp file, not a mock,
        so this is the actual parsing path, not an assumption about it."""
        from pipeline.models.fixture_rates import load_exported_rates
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture_xg.json"
            path.write_text(json.dumps({
                "source": "dixon_coles_posterior+market_blend",
                "fixtures": [
                    {
                        "match_id": "m1", "home_team": "Alpha", "away_team": "Beta",
                        "lambda_home": 1.5, "mu_away": 1.0, "gameweek": 1,
                        # No "rate_source" key on this row — the legacy case.
                    },
                ],
            }))
            rates = load_exported_rates(path)
        self.assertEqual(rates["m1"].source, "dixon_coles_posterior+market_blend")
        self.assertIn(rates["m1"].source, ACCEPTED_RATE_SOURCES)

    def test_fixture_specs_from_fixture_xg_unknown_sentinel_is_accepted(self):
        """fixture_specs_from_fixture_xg (fpl_inputs.py) stamps "unknown" —
        deliberately, not null — when a row has a usable rate but no
        rate_source of its own. This is the exact daily-lane call site Task
        5 wired in, so it must be accepted here too."""
        from pipeline.models.fpl_inputs import fixture_specs_from_fixture_xg
        specs = fixture_specs_from_fixture_xg({
            "fixtures": [
                {
                    "match_id": "m1", "home_team": "Arsenal", "away_team": "Chelsea",
                    "gameweek": 1, "lambda_home": 1.5, "mu_away": 1.0,
                },
            ]
        })
        self.assertEqual(specs[0].rate_source, "unknown")
        self.assertIn(specs[0].rate_source, ACCEPTED_RATE_SOURCES)

    def test_ensemble_unanchored_stays_accepted(self):
        """Pinned directly rather than only reached via fpl_inputs, so a
        future edit that dropped this string from ACCEPTED_RATE_SOURCES
        fails here even before touching the daily-lane fallback."""
        self.assertIn("ensemble_unanchored", ACCEPTED_RATE_SOURCES)

    def test_every_rate_sources_value_is_still_accepted(self):
        """RATE_SOURCES (blend_log's three values) must remain a subset —
        ACCEPTED_RATE_SOURCES only ever widens, never narrows, what the
        original fixture_xg.json contract already accepted."""
        for source in RATE_SOURCES:
            with self.subTest(rate_source=source):
                self.assertIn(source, ACCEPTED_RATE_SOURCES)


class SealPathNeverAbortsOnALegitimateSource(unittest.TestCase):
    """Regression test for Fix round 2's CRITICAL finding.

    run_agent.py's refresh_expected_points (:391-399) builds one FixtureSpec
    per unplayed fixture with rate_source=resolve_rates(...).source, then
    feeds the list straight into export_gameweek_xp — called from _seal(),
    which has no repair path. This test builds specs the same way (calling
    the real resolve_rates, not a stand-in) across its three branches
    (exported posterior found, archive strengths as fallback, flat-default
    last resort) and asserts export_gameweek_xp does NOT raise. Its absence
    is exactly why the suite stayed green while BLOCKING 2's new contract
    check could still have crashed the seal: no test called
    refresh_expected_points end to end.

    Proven, not assumed: constructing these same specs WITHOUT rate_source
    (mirroring run_agent.py before Fix round 2's part 1) raises
    ArtifactContractError with exactly two violations, one per fixture,
    both "rate_source is null or missing" — see task-5-report.md's Fix
    round 2 section for the verbatim reproduction.
    """

    def test_specs_built_the_way_run_agent_does_do_not_abort_export(self):
        from pipeline.models.fixture_rates import FixtureRates, resolve_rates

        # m1 resolves via the exported posterior (found in `exported`); m2
        # has no exported or fitted-strengths rate, so it resolves via
        # resolve_rates' flat-default last resort. Between them this covers
        # two of resolve_rates' three branches with the real function, not a
        # stand-in for it — the third (archive_team_strengths) is exercised
        # directly in ContractAcceptsEveryRealProducer above.
        exported = {
            "m1": FixtureRates("Alpha", "Beta", 1.6, 1.1, "dixon_coles_posterior+level")
        }
        fixture_sides = [("m1", "Alpha", "Beta"), ("m2", "Gamma", "Alpha")]
        specs = []
        for match_id, home, away in fixture_sides:
            rates = resolve_rates(match_id, home, away, exported, strengths=None)
            specs.append(
                FixtureSpec(
                    match_id=match_id, gameweek=5, home_team=home, away_team=away,
                    lambda_home=rates.lambda_home, mu_away=rates.mu_away,
                    rate_source=rates.source,
                )
            )
        self.assertEqual(
            [s.rate_source for s in specs],
            ["dixon_coles_posterior+level", "flat_default"],
        )
        draws = simulate_gameweek(
            specs, SQUADS, EVENTS, RULES, n_draws=200, seed_entropy=7,
            all_element_ids=None,
        )
        with TemporaryDirectory() as tmp:
            try:
                export_gameweek_xp(
                    draws, "2627", GENERATED_AT, RULES, Path(tmp), 7, specs,
                )
            except ArtifactContractError as exc:
                self.fail(
                    "export_gameweek_xp raised on specs built the way "
                    f"run_agent.py's seal path builds them: {exc}"
                )


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.draws = _draws(SINGLE)

    def test_export_writes_both_files(self):
        with TemporaryDirectory() as tmp:
            written = export_gameweek_xp(
                self.draws, "2627", GENERATED_AT, RULES, Path(tmp), 7, SINGLE
            )
            self.assertTrue(written["xp"].exists())
            self.assertTrue(written["sim_params"].exists())
            self.assertEqual(written["xp"].name, "xp_gw05.json")

    def test_nothing_is_written_when_the_contract_fails(self):
        """
        A stale or partial artifact is worse than a missing one: a missing file is
        obviously missing.
        """
        with TemporaryDirectory() as tmp:
            self.draws.element_ids = list(self.draws.element_ids)
            broken = self.draws
            # Force an impossible summary by corrupting the minutes matrix.
            broken.minutes = np.full_like(broken.minutes, -5)
            with self.assertRaises(ArtifactContractError):
                export_gameweek_xp(
                    broken, "2627", GENERATED_AT, RULES, Path(tmp), 7, SINGLE
                )
            self.assertFalse((Path(tmp) / "fpl" / "xp_gw05.json").exists())

    def test_sim_params_carry_the_seed_and_no_binaries(self):
        params = build_sim_params("2627", 5, GENERATED_AT, 7, 500, SINGLE)
        self.assertEqual(params["seed_entropy"], 7)
        self.assertEqual(params["n_draws"], 500)
        self.assertIn("minutes.start_shrinkage", params["parameters"])
        # Regenerable by construction: the payload must stay small.
        self.assertLess(len(json.dumps(params)), 20_000)

    def test_a_non_finite_payload_raises_and_leaves_no_file(self):
        """The write must refuse rather than emit JSON the browser cannot parse."""
        with TemporaryDirectory() as tmp:
            target = Path(tmp) / "out.json"
            with self.assertRaises(ArtifactContractError):
                write_json_atomically({"xp": float("nan")}, target)
            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.glob("*.tmp")), [])

    def test_atomic_write_leaves_no_temporary_file(self):
        with TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested" / "out.json"
            write_json_atomically({"a": 1}, target)
            self.assertTrue(target.exists())
            self.assertEqual(list(target.parent.glob("*.tmp")), [])


class SchemaTests(unittest.TestCase):
    """The schema file is the single contract both languages validate against."""

    def test_schema_file_exists_and_parses(self):
        path = SCHEMA_DIR / "xp_gw.schema.json"
        self.assertTrue(path.exists())
        schema = json.loads(path.read_text())
        self.assertIn("players", schema["properties"])

    def test_artifact_satisfies_the_schema_where_jsonschema_is_available(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema not installed")
        schema = json.loads((SCHEMA_DIR / "xp_gw.schema.json").read_text())
        artifact = build_xp_artifact(_draws(DOUBLE), "2627", GENERATED_AT, RULES, DOUBLE)
        jsonschema.validate(artifact, schema)

    def test_every_required_player_field_is_produced(self):
        """Catches schema drift without needing jsonschema installed."""
        schema = json.loads((SCHEMA_DIR / "xp_gw.schema.json").read_text())
        required = schema["properties"]["players"]["items"]["required"]
        row = _draws(SINGLE).summary_rows()[0]
        for field in required:
            with self.subTest(field=field):
                self.assertIn(field, row)

    def test_every_required_metadata_field_is_produced(self):
        schema = json.loads((SCHEMA_DIR / "xp_gw.schema.json").read_text())
        required = schema["properties"]["metadata"]["required"]
        artifact = build_xp_artifact(_draws(SINGLE), "2627", GENERATED_AT, RULES, SINGLE)
        for field in required:
            with self.subTest(field=field):
                self.assertIn(field, artifact["metadata"])


if __name__ == "__main__":
    unittest.main()
