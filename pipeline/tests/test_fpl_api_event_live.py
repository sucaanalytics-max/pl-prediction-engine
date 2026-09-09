"""
A settled gameweek's live payload is cached per gameweek, not shared.

`manager_history` reads one `event/{gw}/live/` endpoint per settled gameweek on
every hourly agent tick. Uncached that is thirty-eight requests an hour to learn
nothing, since a gameweek that is `finished` and `data_checked` cannot change.
"""
from pathlib import Path
from unittest.mock import patch

from pipeline.data import fpl_api


def test_each_gameweek_caches_to_its_own_file():
    seen = {}

    def fake(url, cache_path, ttl_hours, force, allow_stale, label):
        seen[url] = Path(cache_path)
        return ({"elements": []}, {"source": "network"})

    with patch.object(fpl_api, "_fetch_cached_json", side_effect=fake):
        fpl_api.fetch_event_live(3)
        fpl_api.fetch_event_live(4)

    paths = list(seen.values())
    assert len(set(paths)) == 2, "two gameweeks shared one cache file"
    assert paths[0].name == "event_live_03.json"
    assert paths[1].name == "event_live_04.json"


def test_a_settled_gameweek_is_cached_for_a_long_time():
    """A finished gameweek's points do not change, so re-fetching is waste."""
    captured = {}

    def fake(url, cache_path, ttl_hours, force, allow_stale, label):
        captured["ttl"] = ttl_hours
        return ({"elements": []}, {"source": "cache"})

    with patch.object(fpl_api, "_fetch_cached_json", side_effect=fake):
        fpl_api.fetch_event_live(3)

    assert captured["ttl"] >= 24


def test_the_url_names_the_gameweek_asked_for():
    seen = {}

    def fake(url, cache_path, ttl_hours, force, allow_stale, label):
        seen["url"] = url
        return ({"elements": []}, {"source": "network"})

    with patch.object(fpl_api, "_fetch_cached_json", side_effect=fake):
        fpl_api.fetch_event_live(7)

    assert seen["url"].endswith("/event/7/live/")
