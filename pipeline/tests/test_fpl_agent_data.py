"""
Contract tests for FPL fetch provenance and the season-archive backfill.

The provenance tests exist because of a specific, verified failure mode: the
bootstrap fetcher fell back to a stale cache on *any* exception, and the GitHub
Actions cache restore key has no run pin. On deadline day, when the FPL API is
most likely to fail, that combination produced a permanent forecast record
built on stale prices and stale availability, with nothing in the artifact
revealing it.
"""
import gzip
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pipeline.data import fpl_api
from pipeline.data.fpl_api import (
    SOURCE_FRESH_CACHE,
    SOURCE_NETWORK,
    SOURCE_STALE_CACHE,
    _fetch_cached_json,
)
from pipeline.learning.backfill import (
    DEFCON_COLUMNS,
    SCORING_COLUMNS,
    _normalise_name,
    archive_path,
    has_defcon,
    link_archive_to_priors,
    load_archive_season,
)


class _Response:
    """Minimal stand-in for a requests Response."""

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _Boom(RuntimeError):
    """Simulated upstream outage."""


class FetchProvenanceTests(unittest.TestCase):
    """Monkeypatch the module-level fetcher, per the repo's testing idiom."""

    def setUp(self):
        self._original = fpl_api.fetch_with_retry
        self.addCleanup(setattr, fpl_api, "fetch_with_retry", self._original)

    def _fetch(self, tmp, force=False, allow_stale=True, ttl_hours=12):
        return _fetch_cached_json(
            "https://example.invalid/bootstrap",
            Path(tmp) / "payload.json",
            ttl_hours=ttl_hours,
            force=force,
            allow_stale=allow_stale,
            label="test payload",
        )

    def test_successful_fetch_reports_network_provenance(self):
        fpl_api.fetch_with_retry = lambda *a, **k: _Response({"v": 1})
        with TemporaryDirectory() as tmp:
            data, prov = self._fetch(tmp)
            self.assertEqual(data, {"v": 1})
            self.assertEqual(prov["source"], SOURCE_NETWORK)
            self.assertEqual(prov["age_seconds"], 0.0)

    def test_fresh_cache_is_reused_and_labelled_as_cache(self):
        fpl_api.fetch_with_retry = lambda *a, **k: _Response({"v": 1})
        with TemporaryDirectory() as tmp:
            self._fetch(tmp)

            def _fail(*a, **k):
                raise AssertionError("network must not be called for a fresh cache")

            fpl_api.fetch_with_retry = _fail
            data, prov = self._fetch(tmp)
            self.assertEqual(data, {"v": 1})
            self.assertEqual(prov["source"], SOURCE_FRESH_CACHE)

    def test_force_bypasses_a_fresh_cache(self):
        fpl_api.fetch_with_retry = lambda *a, **k: _Response({"v": 1})
        with TemporaryDirectory() as tmp:
            self._fetch(tmp)
            fpl_api.fetch_with_retry = lambda *a, **k: _Response({"v": 2})
            data, prov = self._fetch(tmp, force=True)
            self.assertEqual(data, {"v": 2})
            self.assertEqual(prov["source"], SOURCE_NETWORK)

    def test_raises_on_stale_when_disallowed(self):
        """The seal path must fail loudly rather than record a stale forecast."""
        fpl_api.fetch_with_retry = lambda *a, **k: _Response({"v": 1})
        with TemporaryDirectory() as tmp:
            self._fetch(tmp)  # populate the cache

            def _boom(*a, **k):
                raise _Boom("upstream 503")

            fpl_api.fetch_with_retry = _boom
            with self.assertRaises(_Boom):
                # force=True expires the cache, allow_stale=False forbids the
                # silent fallback. Together these are what a seal passes.
                self._fetch(tmp, force=True, allow_stale=False)

    def test_serves_stale_cache_when_allowed_and_flags_it(self):
        """Default behaviour is preserved for the resilient daily pipeline."""
        fpl_api.fetch_with_retry = lambda *a, **k: _Response({"v": 1})
        with TemporaryDirectory() as tmp:
            self._fetch(tmp)

            def _boom(*a, **k):
                raise _Boom("upstream 503")

            fpl_api.fetch_with_retry = _boom
            data, prov = self._fetch(tmp, force=True, allow_stale=True)
            self.assertEqual(data, {"v": 1})
            self.assertEqual(prov["source"], SOURCE_STALE_CACHE)
            self.assertGreaterEqual(prov["age_seconds"], 0.0)

    def test_raises_when_no_cache_exists_regardless_of_allow_stale(self):
        def _boom(*a, **k):
            raise _Boom("upstream 503")

        fpl_api.fetch_with_retry = _boom
        with TemporaryDirectory() as tmp:
            with self.assertRaises(_Boom):
                self._fetch(tmp, allow_stale=True)


class NameNormalisationTests(unittest.TestCase):
    def test_accents_are_folded(self):
        self.assertEqual(_normalise_name("Jérémy Doku"), "jeremy doku")
        self.assertEqual(_normalise_name("Ibrahima Konaté"), "ibrahima konate")

    def test_punctuation_and_case_are_folded(self):
        self.assertEqual(_normalise_name("Nott'm  Forest"), "nott m forest")
        self.assertEqual(_normalise_name("O'Shea"), "o shea")

    def test_empty_input_is_safe(self):
        self.assertEqual(_normalise_name(""), "")


class ArchiveBackfillTests(unittest.TestCase):
    """Guards the committed archive extracts and the cross-season link."""

    def test_prior_season_archive_is_committed_and_complete(self):
        path = archive_path("2526")
        self.assertTrue(
            path.exists(), f"{path} missing — run pipeline.learning.backfill"
        )
        frame = load_archive_season("2526")
        # A full season of settled player-gameweek rows.
        self.assertGreater(len(frame), 25_000)
        self.assertEqual(sorted(frame["GW"].unique().tolist()), list(range(1, 39)))
        for column in SCORING_COLUMNS:
            self.assertIn(column, frame.columns)

    def test_prior_season_supports_defensive_contribution(self):
        """Increment 2's replay oracle needs the DefCon components."""
        self.assertTrue(has_defcon(load_archive_season("2526")))

    def test_older_season_lacks_defcon_and_says_so(self):
        """2024-25 predates the mechanic; it must not silently imply support."""
        frame = load_archive_season("2425")
        self.assertFalse(has_defcon(frame))
        for column in DEFCON_COLUMNS:
            self.assertNotIn(column, frame.columns)

    def test_archive_carries_fpl_own_expected_points_baseline(self):
        """`xP` makes the "beat ep_next" baseline reproducible historically."""
        self.assertIn("xP", load_archive_season("2526").columns)

    def test_team_names_are_canonicalised_on_load(self):
        frame = load_archive_season("2526")
        self.assertNotIn("Spurs", set(frame["team_canonical"]))
        self.assertIn("Tottenham", set(frame["team_canonical"]))

    def test_link_attaches_current_identity_and_reports_causes(self):
        from pipeline.data.priors.snapshot import load_player_priors

        frame = load_archive_season("2526")
        linked, report = link_archive_to_priors(frame, load_player_priors())

        # Position must come from the current bootstrap: FPL reclassifies
        # players between seasons, and a stale position corrupts both the
        # scoring rules applied and the position priors fitted.
        self.assertIn("position_current", linked.columns)
        self.assertIn("code", linked.columns)

        # Most minutes must link, or the minutes model has little to fit.
        self.assertGreater(report["minutes_match_rate"], 0.75)

        # Relegated clubs are reported separately from same-club misses so an
        # expected turnover is never mistaken for a matching defect.
        self.assertTrue(report["departed_clubs"])
        self.assertIn("match_stages", report)

    def test_link_never_invents_a_position(self):
        """An unmatched row must carry no identity rather than a guess."""
        from pipeline.data.priors.snapshot import load_player_priors

        frame = load_archive_season("2526")
        linked, _ = link_archive_to_priors(frame, load_player_priors())
        unmatched = linked[linked["code"].isna()]
        if len(unmatched):
            self.assertTrue(unmatched["position_current"].isna().all())


if __name__ == "__main__":
    unittest.main()
