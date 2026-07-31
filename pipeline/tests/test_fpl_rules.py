"""
Tests for rule resolution, provenance enforcement and drift tiering.

Rules are facts, not parameters. The signing requirement is enforced in code so
that an unsourced rule cannot be read by any module, and the drift tiering is
tested so a change to squad legality raises while a change to the points table
degrades — the daily match-prediction pipeline must keep running either way.
"""
import gzip
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import yaml

from pipeline.fpl.rules import (
    CRITICAL,
    INFORMATIONAL,
    SCORING,
    RuleDriftError,
    is_retired_position,
    load_rules,
    load_signed_rules,
    normalise_position,
    selling_price,
    verify_against_bootstrap,
)

CAPTURED_BOOTSTRAP = (
    Path(__file__).resolve().parents[1]
    / "data" / "priors" / "bootstrap_preseason_2627.json.gz"
)
RULES_YAML = (
    Path(__file__).resolve().parents[1] / "knowledge" / "rules_2627.yaml"
)


def _bootstrap() -> dict:
    return json.loads(gzip.decompress(CAPTURED_BOOTSTRAP.read_bytes()))


class SignedRulesTests(unittest.TestCase):
    def test_signed_rules_load(self):
        signed = load_signed_rules()
        self.assertEqual(signed["saves_per_point"], 3)
        self.assertEqual(signed["goals_conceded_per_penalty"], 2)
        self.assertEqual(signed["long_play_threshold"], 60)
        self.assertTrue(signed["red_absorbs_yellow"])
        self.assertFalse(signed["defcon_stacks"])

    def test_defensive_contribution_thresholds_differ_by_position(self):
        defcon = load_signed_rules()["defcon"]
        self.assertEqual(defcon["DEF"].threshold, 10)
        self.assertEqual(defcon["MID"].threshold, 12)
        self.assertEqual(defcon["FWD"].threshold, 12)
        self.assertIsNone(defcon["GKP"].threshold)
        # Recoveries count for midfielders and forwards, not defenders.
        self.assertNotIn("recoveries", defcon["DEF"].counts)
        self.assertIn("recoveries", defcon["MID"].counts)

    def test_every_rule_in_the_yaml_carries_provenance(self):
        """An unsigned rule must fail from day one, not when someone notices."""
        document = yaml.safe_load(RULES_YAML.read_text())
        unsigned = []

        def walk(node, path):
            if isinstance(node, dict):
                if "value" in node or "note" in node:
                    if not ("verified_by" in node and "verified_on" in node):
                        # A nested threshold block is signed by its parent.
                        if "counts" not in node:
                            unsigned.append(path)
                for key, value in node.items():
                    if key not in ("value", "note", "verified_by", "verified_on",
                                   "counts"):
                        walk(value, f"{path}.{key}")

        for section in ("divisors", "minutes", "cards"):
            walk(document[section], section)
        self.assertEqual(unsigned, [], f"unsigned rules: {unsigned}")

    def test_missing_provenance_raises(self):
        document = yaml.safe_load(RULES_YAML.read_text())
        del document["divisors"]["saves_per_point"]["verified_by"]
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "rules.yaml"
            path.write_text(yaml.safe_dump(document))
            with self.assertRaises(ValueError):
                load_signed_rules(path)


class PositionVocabularyTests(unittest.TestCase):
    def test_archive_gk_maps_to_api_gkp(self):
        """The two sources disagree on the label for the same position."""
        self.assertEqual(normalise_position("GK"), "GKP")
        self.assertEqual(normalise_position("GKP"), "GKP")
        self.assertEqual(normalise_position("gk"), "GKP")

    def test_retired_position_is_distinguished_from_unknown(self):
        self.assertIsNone(normalise_position("AM"))
        self.assertTrue(is_retired_position("AM"))
        self.assertIsNone(normalise_position("QB"))
        self.assertFalse(is_retired_position("QB"))


class SellingPriceTests(unittest.TestCase):
    def test_a_fall_is_passed_on_in_full(self):
        self.assertEqual(selling_price(50, 48), 48)

    def test_no_change_returns_purchase_price(self):
        self.assertEqual(selling_price(50, 50), 50)

    def test_half_the_rise_is_retained_and_rounded_down(self):
        # A 0.1m rise returns nothing; 0.2m returns 0.1m; 0.3m returns 0.1m.
        self.assertEqual(selling_price(50, 51), 50)
        self.assertEqual(selling_price(50, 52), 51)
        self.assertEqual(selling_price(50, 53), 51)
        self.assertEqual(selling_price(50, 54), 52)

    def test_selling_price_table_over_rises_of_zero_to_twenty(self):
        """Monotonic, never above now_cost, never below purchase price."""
        purchase = 60
        previous = purchase
        for rise in range(0, 21):
            now = purchase + rise
            price = selling_price(purchase, now)
            self.assertGreaterEqual(price, purchase)
            self.assertLessEqual(price, now)
            self.assertGreaterEqual(price, previous)
            self.assertEqual(price, purchase + rise // 2)
            previous = price


class BootstrapVerificationTests(unittest.TestCase):
    def test_captured_bootstrap_matches_expectations(self):
        """No drift between the live API and what this code was written for."""
        drift = verify_against_bootstrap(_bootstrap())
        self.assertEqual(
            [d for d in drift if d["tier"] in (CRITICAL, SCORING)],
            [],
            f"unexpected drift: {drift}",
        )

    def test_squad_rule_change_raises(self):
        bootstrap = _bootstrap()
        bootstrap["game_settings"]["squad_team_limit"] = 4
        with self.assertRaises(RuleDriftError):
            verify_against_bootstrap(bootstrap)

    def test_budget_change_raises(self):
        bootstrap = _bootstrap()
        bootstrap["game_settings"]["squad_total_spend"] = 1050
        with self.assertRaises(RuleDriftError):
            verify_against_bootstrap(bootstrap)

    def test_scoring_change_degrades_without_raising(self):
        """A wrong FPL points table must not stop the Kelly path updating."""
        bootstrap = _bootstrap()
        bootstrap["game_config"]["scoring"]["assists"] = 4
        drift = verify_against_bootstrap(bootstrap)
        scoring_drift = [d for d in drift if d["tier"] == SCORING]
        self.assertTrue(scoring_drift)

        rules = load_rules(bootstrap)
        self.assertTrue(rules.degraded)
        # And the live value is used, not the stale expectation.
        self.assertEqual(rules.assist_points, 4)

    def test_a_null_scoring_value_degrades_instead_of_raising(self):
        """
        int(None) raised a bare TypeError, breaking the documented contract that
        SCORING-tier drift degrades while the daily pipeline keeps running. FPL
        is free to null a field mid-season.
        """
        bootstrap = _bootstrap()
        bootstrap["game_config"]["scoring"]["assists"] = None
        rules = load_rules(bootstrap)
        self.assertTrue(rules.degraded)
        self.assertEqual(rules.assist_points, 3)

    def test_a_null_inside_a_positional_map_degrades(self):
        bootstrap = _bootstrap()
        bootstrap["game_config"]["scoring"]["goals_scored"] = {
            "GKP": 10, "DEF": None, "MID": 5, "FWD": 4,
        }
        rules = load_rules(bootstrap)
        self.assertTrue(rules.degraded)
        self.assertEqual(rules.goal_points["DEF"], 6)

    def test_a_positional_map_replaced_by_a_scalar_degrades(self):
        bootstrap = _bootstrap()
        bootstrap["game_config"]["scoring"]["clean_sheets"] = "nope"
        rules = load_rules(bootstrap)
        self.assertTrue(rules.degraded)
        self.assertEqual(rules.clean_sheet_points["GKP"], 4)

    def test_unknown_chip_is_recorded_not_raised(self):
        bootstrap = _bootstrap()
        bootstrap["chips"] = list(bootstrap["chips"]) + [
            {"name": "manager", "number": 1, "start_event": 1, "stop_event": 38}
        ]
        rules = load_rules(bootstrap)
        self.assertIn("manager", rules.unmodelled_chips)
        self.assertFalse(rules.degraded)


class ResolvedRulesTests(unittest.TestCase):
    def test_rules_from_bootstrap_carry_live_values(self):
        rules = load_rules(_bootstrap())
        self.assertEqual(rules.source, "bootstrap+signed_yaml")
        self.assertEqual(rules.squad_size, 15)
        self.assertEqual(rules.lineup_size, 11)
        self.assertEqual(rules.club_limit, 3)
        self.assertEqual(rules.budget_tenths, 1000)
        self.assertEqual(rules.budget, 100.0)
        self.assertEqual(rules.quotas, {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3})
        self.assertEqual(rules.play_bounds["GKP"], (1, 1))
        self.assertEqual(rules.play_bounds["DEF"], (3, 5))

    def test_max_banked_free_transfers_is_five(self):
        """
        Derived from game_settings.max_extra_free_transfers = 4, plus the one
        earned each week. Machine-readable, so it cannot silently go stale.
        """
        self.assertEqual(load_rules(_bootstrap()).max_banked_free_transfers, 5)

    def test_sell_on_fee_is_a_half(self):
        self.assertEqual(load_rules(_bootstrap()).sell_on_fee, 0.5)

    def test_rules_load_without_bootstrap_for_pure_unit_tests(self):
        rules = load_rules()
        self.assertEqual(rules.source, "signed_yaml_only")
        self.assertFalse(rules.degraded)


class ChipCalendarTests(unittest.TestCase):
    def test_wildcard_and_free_hit_cannot_be_played_in_gameweek_one(self):
        """
        Bench Boost and Triple Captain start at GW1; Wildcard and Free Hit at
        GW2. Read straight from the API rather than assumed — this is exactly the
        kind of rule that is easy to get wrong from memory.
        """
        chips = _bootstrap()["chips"]
        starts = {}
        for chip in chips:
            starts.setdefault(chip["name"], set()).add(chip["start_event"])
        self.assertEqual(min(starts["wildcard"]), 2)
        self.assertEqual(min(starts["freehit"]), 2)
        self.assertEqual(min(starts["bboost"]), 1)
        self.assertEqual(min(starts["3xc"]), 1)

    def test_two_of_each_chip_split_across_the_season(self):
        chips = _bootstrap()["chips"]
        counts = {}
        for chip in chips:
            counts[chip["name"]] = counts.get(chip["name"], 0) + 1
        self.assertEqual(
            counts, {"wildcard": 2, "freehit": 2, "bboost": 2, "3xc": 2}
        )


if __name__ == "__main__":
    unittest.main()
