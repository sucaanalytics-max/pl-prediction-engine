"""
`matchweek_N.json` must actually hold gameweek N.

## What went wrong

The archive write was an unconditional overwrite keyed on `get_current_gameweek()`, and both
halves of that were wrong together. FPL keeps an event `is_current` from its own deadline
until the NEXT one, so between a gameweek's last match and the following deadline the key did
not advance — and every daily run rewrote the same file.

`matchweek_1.json` was overwritten 36 times. By the time it was noticed it held GW2's fixture
slate (Crystal Palace v Man City, 28 Aug) stamped `fixture.gameweek: 1`, GW1's own predictions
were gone from HEAD, and no `matchweek_2.json` had ever been created. Nothing reads this
directory, which is exactly why 36 silent overwrites went unnoticed.

The write is seal-once now and keyed on the planning week, and GW1's file has been restored
from `fe8214d` — the last daily run before GW1 locked. This is the assertion that would have
caught it on day two.

## Why the filename is the subject

A record whose NAME disagrees with its CONTENT is worse than a missing one, because it will be
trusted. The filename is the only thing a future reader has to go on when deciding which week
they are looking at, so the filename is what this checks — not that the content is internally
consistent, which it was throughout.
"""
import json
import re
import unittest
from pathlib import Path

ARCHIVE = Path("predictions/archive")
NAME = re.compile(r"^matchweek_(\d+)\.json$")


def archived():
    """Every archive file, as `(gameweek_from_filename, parsed)`."""
    if not ARCHIVE.is_dir():
        return []
    out = []
    for path in sorted(ARCHIVE.glob("matchweek_*.json")):
        m = NAME.match(path.name)
        if not m:
            continue
        try:
            out.append((int(m.group(1)), path, json.loads(path.read_text())))
        except ValueError as error:
            raise AssertionError(f"{path.name} is not readable JSON: {error}") from error
    return out


class TestArchiveNamesMatchContent(unittest.TestCase):
    def setUp(self):
        self.files = archived()
        if not self.files:
            self.skipTest("no archive in this checkout")

    def test_every_fixture_belongs_to_the_gameweek_in_the_filename(self):
        wrong = []
        for gameweek, path, payload in self.files:
            for record in payload.get("predictions") or []:
                stamped = (record.get("fixture") or {}).get("gameweek")
                if stamped is not None and int(stamped) != gameweek:
                    wrong.append(f"{path.name}: {record.get('match_id')} is gw{stamped}")
        self.assertEqual(wrong, [], "an archive file holds another gameweek's fixtures")

    def test_the_metadata_gameweek_agrees_with_the_filename(self):
        wrong = []
        for gameweek, path, payload in self.files:
            stamped = (payload.get("metadata") or {}).get("gameweek")
            if stamped is not None and int(stamped) != gameweek:
                wrong.append(f"{path.name}: metadata says gw{stamped}")
        self.assertEqual(wrong, [], "an archive file's metadata names another gameweek")

    def test_no_archive_file_is_empty(self):
        # An empty archive is indistinguishable from a week nobody predicted, and the
        # write is seal-once now — so an empty file can never be replaced by a real one.
        empty = [
            path.name for _, path, payload in self.files
            if not (payload.get("predictions") or [])
        ]
        self.assertEqual(empty, [], "a sealed archive file holds no predictions")

    def test_gw1_holds_the_slate_that_was_actually_played(self):
        # The specific repair, pinned. GW1 2026-27 ran 21-24 August; the restored file is
        # the last daily run before the 21 Aug 17:30Z deadline. If this file is ever
        # overwritten with a later week again, this is the assertion that says so.
        match = [p for gw, p, _ in self.files if gw == 1]
        if not match:
            self.skipTest("no matchweek_1.json in this checkout")
        payload = json.loads(match[0].read_text())
        dates = sorted({
            (r.get("fixture") or {}).get("date", "")[:10]
            for r in payload.get("predictions") or []
        })
        self.assertTrue(dates, "matchweek_1.json holds no dated fixtures")
        for date in dates:
            self.assertTrue(
                "2026-08-21" <= date <= "2026-08-24",
                f"matchweek_1.json holds a fixture dated {date}, outside GW1's window",
            )


if __name__ == "__main__":
    unittest.main()
