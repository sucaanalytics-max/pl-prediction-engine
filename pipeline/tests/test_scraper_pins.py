"""
The two pins that stopped a scraped source dead, and why they are pins.

`player_events.json` went fifteen days without refreshing — 24 August to 8
September — while every other artifact refreshed daily. Nothing was broken in the
frontend, nothing was red in CI, and the workflow reported success every morning,
because the step catches its own failure by design and the run carries on.

The chain, measured on 2026-09-08:

    fbrefdata==0.4.1   depends on rich >=13,<14
    soccerdata>=1.9    depends on rich >=14,<16
                       -> incompatible

    soccerdata 1.8.3-1.8.7  want lxml <5.0.0   -> also excluded
    soccerdata 1.8.8        wants rich >=14    -> also excluded

So `soccerdata>=1.8` left exactly ONE version the resolver could take alongside
fbrefdata: 1.8.2. Its Understat parser raises `KeyError: 'statData'` because
Understat changed the page shape; 1.9.1 reads 387 Premier League rows from the
same call. The resolver was not wrong — it was asked for a version range whose
only satisfiable member was broken, and it said nothing.

Holding fbrefdata cost more than the passing table it was there for. Both the
player-events artifact AND the team-level xG features that feed the model come
from Understat through soccerdata, because `fetch_fbref_team_stats` reads
Understat despite its name.

These tests are cheap and they are the only thing standing between that chain and
a future `pip install -U`. They assert the DECISION, not the resolution — a real
resolution needs a network and CI's interpreter.
"""
import re
import unittest
from pathlib import Path

REQUIREMENTS = Path(__file__).resolve().parents[1] / "requirements.txt"


def requirement(name: str) -> str | None:
    """The declared specifier for a package, or None when it is not declared."""
    for raw in REQUIREMENTS.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if re.match(rf"^{re.escape(name)}\b", line):
            return line
    return None


class SoccerdataFloor(unittest.TestCase):
    def test_the_floor_excludes_the_broken_understat_parser(self):
        spec = requirement("soccerdata")
        self.assertIsNotNone(spec, "soccerdata is not declared at all")
        match = re.search(r">=\s*(\d+)\.(\d+)", spec)
        self.assertIsNotNone(match, f"soccerdata has no lower bound: {spec}")
        major, minor = int(match.group(1)), int(match.group(2))
        # 1.8.x cannot parse Understat. A floor at or below it lets the resolver
        # choose one that raises, which is what happened.
        self.assertGreaterEqual(
            (major, minor), (1, 9),
            f"soccerdata floor {major}.{minor} admits 1.8.x, whose Understat "
            "parser raises KeyError('statData')",
        )


class FbrefdataStaysOut(unittest.TestCase):
    def test_it_is_not_declared(self):
        # Not a style preference: it caps rich<14 and no soccerdata that can read
        # Understat fits under that cap. Re-adding it silently reintroduces 1.8.2.
        self.assertIsNone(
            requirement("fbrefdata"),
            "fbrefdata caps rich<14, which forces soccerdata down to 1.8.2 and "
            "breaks Understat. Restoring passing stats needs a source that does "
            "not cap rich — see the comment in requirements.txt.",
        )

    def test_nothing_in_the_pipeline_imports_it_outside_a_guarded_path(self):
        """
        One import survives, in `fbref.py`, inside a try/except ImportError that
        now always fires. That is deliberate — the tested column mapping below it
        is the half worth keeping. Any OTHER import would be an unguarded crash.
        """
        root = REQUIREMENTS.parent
        offenders = []
        for path in root.rglob("*.py"):
            if "tests" in path.parts:
                continue
            text = path.read_text()
            if "fbrefdata" not in text:
                continue
            for number, line in enumerate(text.splitlines(), 1):
                if re.match(r"\s*(from fbrefdata|import fbrefdata)", line):
                    if path.name != "fbref.py":
                        offenders.append(f"{path.relative_to(root)}:{number}")
        self.assertEqual(offenders, [], f"unguarded fbrefdata imports: {offenders}")


if __name__ == "__main__":
    unittest.main()
