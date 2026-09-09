"""The assembled payload, and the early exit that keeps the hourly tick cheap."""
import json
from pathlib import Path

from pipeline.fpl import manager_history as mh


def test_the_payload_names_how_far_it_has_settled():
    payload = mh.build(
        entry_id=20945,
        settled=[1, 2],
        gameweeks=[{"event": 1}, {"event": 2}],
        transfers=[],
        generated_at="2026-09-09T00:00:00+00:00",
    )
    assert payload["schema_version"] == mh.SCHEMA_VERSION
    assert payload["entry_id"] == 20945
    assert payload["settled_through"] == 2
    assert payload["generated_at"] == "2026-09-09T00:00:00+00:00"


def test_a_season_with_nothing_settled_says_so_rather_than_guessing():
    payload = mh.build(
        entry_id=20945, settled=[], gameweeks=[], transfers=[],
        generated_at="2026-09-09T00:00:00+00:00",
    )
    assert payload["settled_through"] is None
    assert payload["gameweeks"] == []


def test_writing_is_skipped_when_nothing_new_has_settled(tmp_path: Path):
    """The agent ticks hourly; rewriting an unchanged file churns git for nothing."""
    target = tmp_path / mh.ARTIFACT_NAME
    target.write_text(json.dumps({
        "schema_version": mh.SCHEMA_VERSION, "settled_through": 3,
    }) + "\n")
    assert mh.already_current(target, settled_through=3) is True
    assert mh.already_current(target, settled_through=4) is False


def test_a_missing_file_is_never_current(tmp_path: Path):
    assert mh.already_current(tmp_path / "absent.json", settled_through=3) is False


def test_a_file_from_an_older_schema_is_never_current(tmp_path: Path):
    """A schema bump must republish even when the same gameweeks have settled."""
    target = tmp_path / mh.ARTIFACT_NAME
    target.write_text(json.dumps({
        "schema_version": mh.SCHEMA_VERSION - 1, "settled_through": 3,
    }) + "\n")
    assert mh.already_current(target, settled_through=3) is False


def test_an_unreadable_file_is_never_current(tmp_path: Path):
    target = tmp_path / mh.ARTIFACT_NAME
    target.write_text("{ this is not json")
    assert mh.already_current(target, settled_through=3) is False


def test_only_the_elements_actually_shown_get_names():
    """
    600 bootstrap names would be most of this file's bytes, and the 45 picks
    would add names nothing renders. Only what the page prints.
    """
    wanted = mh.named_elements(
        gameweeks=[{
            "captain": {"element": 426, "multiplier": 2, "points": 2},
            "auto_subs": [{"element_in": 173, "element_out": 152}],
            "picks": [{"element": 999, "multiplier": 1}],
        }],
        transfers=[{"element_in": 445, "element_out": 418}],
    )
    assert wanted == {426, 173, 152, 445, 418}
    assert 999 not in wanted, "a pick nothing renders by name must not be carried"


def test_the_payload_carries_a_names_map_even_when_empty():
    payload = mh.build(
        entry_id=20945, settled=[], gameweeks=[], transfers=[],
        generated_at="2026-09-09T00:00:00+00:00",
    )
    assert payload["names"] == {}
