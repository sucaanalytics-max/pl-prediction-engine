"""
The Dixon-Coles cache key must change whenever the fit would.

Keyed on the data alone, a pickle fitted under the old prior or old code was
reused for up to 12h after either changed, so a ratings fix could ship and the
pipeline still publish the ratings it fixed.
"""
import copy
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
import pandas as pd

from pipeline import config
from pipeline.run_pipeline import _dc_cache_defect, _dc_cache_key, _dc_fit_signature


def _training() -> pd.DataFrame:
    return pd.DataFrame({
        "season": ["2526", "2526", "2627", "2627"],
        "Date": pd.to_datetime(["2026-04-01", "2026-04-08", "2026-08-22", "2026-08-29"]),
        "HomeTeam": ["Arsenal", "Chelsea", "Hull", "Arsenal"],
        "AwayTeam": ["Chelsea", "Arsenal", "Arsenal", "Coventry"],
        "FTHG": [2, 1, 0, 3],
        "FTAG": [0, 1, 2, 0],
        "home_form": [0.1, 0.2, 0.3, 0.4],  # not read by the DC fit
    })


class DixonColesCacheKeyTest(unittest.TestCase):
    def test_same_inputs_same_key(self):
        self.assertEqual(_dc_cache_key(_training()), _dc_cache_key(_training()))
        self.assertTrue(_dc_cache_key(_training()).startswith("dixon_coles_"))

    def test_corrected_early_score_changes_key(self):
        # The old key hashed len + tail(3): this row was invisible to it.
        df = _training()
        df.loc[0, "FTHG"] = 3
        self.assertNotEqual(_dc_cache_key(_training()), _dc_cache_key(df))

    def test_columns_the_fit_ignores_do_not_change_key(self):
        df = _training()
        df["home_form"] = 0.9
        self.assertEqual(_dc_cache_key(_training()), _dc_cache_key(df))

    def test_every_dixon_coles_registry_value_is_in_key(self):
        names = [n for n in config.PARAM_REGISTRY if n.startswith("dixon_coles.")]
        self.assertIn("dixon_coles.team_effect_sigma", names)
        self.assertIn("dixon_coles.promoted_attack_offset", names)
        base = _dc_cache_key(_training())
        for name in names:
            registry = copy.deepcopy(config.PARAM_REGISTRY)
            registry[name]["value"] = registry[name]["value"] + 0.05
            with mock.patch.object(config, "PARAM_REGISTRY", registry):
                self.assertNotEqual(base, _dc_cache_key(_training()), name)

    def test_training_window_changes_key(self):
        # The 2026-10-25 bug: SEASONS never rolled, so 2627 was missing.
        base = _dc_cache_key(_training())
        with mock.patch.object(config, "TRAINING_SEASONS", ["2324", "2425", "2526"]):
            self.assertNotEqual(base, _dc_cache_key(_training()))

    def test_sampler_settings_change_key(self):
        base = _dc_cache_key(_training())
        with mock.patch.dict(config.DIXON_COLES, {"pymc_draws": 1000}):
            self.assertNotEqual(base, _dc_cache_key(_training()))
        with mock.patch.dict(config.DIXON_COLES, {"xi_decay": 0.005}):
            self.assertNotEqual(base, _dc_cache_key(_training()))

    def test_model_source_changes_key(self):
        base = _dc_cache_key(_training())
        real = Path.read_bytes

        def edited(path):
            data = real(path)
            return data + b"\n# edit\n" if path.name == "dixon_coles.py" else data

        with mock.patch.object(Path, "read_bytes", edited):
            self.assertNotEqual(base, _dc_cache_key(_training()))

    def test_fit_inputs_change_key_and_sets_are_order_free(self):
        base = _dc_cache_key(_training())
        a = _dc_cache_key(_training(), {"current_clubs": {"Arsenal", "Hull", "Coventry"}})
        b = _dc_cache_key(_training(), {"current_clubs": {"Coventry", "Arsenal", "Hull"}})
        c = _dc_cache_key(_training(), {"current_clubs": {"Arsenal", "Hull", "Ipswich"}})
        self.assertNotEqual(base, a)
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_signature_reads_live_config(self):
        sig = _dc_fit_signature()
        self.assertEqual(sig["training_seasons"], list(config.TRAINING_SEASONS))
        self.assertIn(config.CURRENT_SEASON, sig["training_seasons"])
        self.assertEqual(len(sig["model_source"]), 64)


def _model(drop=None, rho_draws=4, teams=("Arsenal", "Hull")):
    var = lambda n: SimpleNamespace(values=np.zeros((1, n)))
    posterior = {
        "attack": var(4), "defence": var(4), "intercept": var(4),
        "home_adv": var(4), "rho": var(rho_draws),
    }
    posterior.pop(drop, None)
    return SimpleNamespace(trace=SimpleNamespace(posterior=posterior), teams=list(teams))


class CachedModelCheckTest(unittest.TestCase):
    """A cached pickle the value-bet path cannot read is a cache miss, not an abort."""

    def test_complete_model_is_usable(self):
        self.assertIsNone(_dc_cache_defect(_model()))

    def test_missing_rho_is_a_defect(self):
        self.assertIn("rho", _dc_cache_defect(_model(drop="rho")))

    def test_rho_draws_must_pair_with_intercept(self):
        self.assertIn("draws", _dc_cache_defect(_model(rho_draws=2)))

    def test_no_trace_or_no_teams_is_a_defect(self):
        self.assertIsNotNone(_dc_cache_defect(SimpleNamespace(trace=None, teams=["Arsenal"])))
        self.assertIsNotNone(_dc_cache_defect(_model(teams=())))
        self.assertIsNotNone(_dc_cache_defect(object()))


if __name__ == "__main__":
    unittest.main()
