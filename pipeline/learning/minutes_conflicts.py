"""
Where the minutes model and the scanned evidence disagree about a player.

## The case this was built from

GW1 2026-27. Our own `xp_gw01.json` gave Joško Gvardiol `e_minutes` **14.3**,
`p_60` **0.06**, `xp` **0.78** — the model's way of saying "will not play". Its
prior is last season: 1,370 minutes across 16 starts, a rotated and injured year,
mean-reverted forward.

At the same time `predictions/fpl/x_inbox.csv` held this, scanned, timestamped and
attributed:

    "Man City summary from the Atlético friendly. Foden, Dias and Gvardiol played
     full 90 - Gvardiol started LB and moved inside second half with Rico Lewis
     coming on."   — @robtFPL, 2026-08-09, tier 3

Both of those are in this repository, and nothing connected them. A user reading
the projection would bench a nailed-on starter on the strength of a stale prior,
while the evidence against it sat two directories away. On the measured squad that
was a ~3-point GW1 swing from one sentence — an order of magnitude more than the
0.04 points that separates the "optimal" transfer plans this category argues over.

## What this does, and what it refuses to do

It **reports the disagreement**. It does not correct the projection.

That restraint is the entire design, not timidity. Turning "played full 90 in a
friendly" into an `e_minutes` of 85 requires a model of how pre-season minutes
predict competitive minutes, fitted and validated — and `availability_news.py`
earns its parsed claims against a hand-labelled corpus with zero false positives
precisely because a wrong number here moves real decisions. A regex that reads
"90" out of a sentence and writes it into a projection would be a fabricated
number wearing a citation.

So the output is a reading list, ranked by how much the two sides disagree, with
the verbatim quote and its URL. A human resolves it in seconds; nothing is filed
on their behalf. That is the same bar `/evidence` already holds — show every claim
and the rule that beat it, rather than a conclusion.

## Why a mention is evidence at all

Not because the text says anything parseable, but because of who wrote it and what
they write about. The scan's sources are curated FPL accounts whose posts are
per-club minutes summaries. A player the model expects to play 14 minutes has no
business appearing in one. The mention is the signal; the sentence is for the
human.

The inverse matters as much and is checked too: a player the model has nailed on
(`e_minutes` high) appearing in a post alongside injury language is the shape of a
projection that is about to be wrong.

## Ambiguity

Surname resolution reuses `news_extract.PlayerIndex`, where **441 of 663 surname
keys are ambiguous** — six Wilsons, six Phillipses. Ambiguous mentions are
reported as ambiguous and never resolved to a guess, because the whole value of
this file is that a human can trust what it points at.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from pipeline.data.news_extract import build_player_index, fold

#: Below this many expected minutes the model is saying "fringe or out".
#:
#: 45 rather than 60: a genuine substitute is not a contradiction — plenty of real
#: players are projected 30-50 minutes and belong in a per-club summary. The claim
#: this makes is narrower, that a player under 45 expected minutes should not be
#: the subject of somebody's team-news post.
FRINGE_MINUTES = 45.0

#: Above this, the model has the player nailed on.
NAILED_MINUTES = 75.0

#: Words that make a mention of a nailed-on player worth a second look. Only used
#: to RANK a report line, never to derive a value, so the bar is deliberately
#: lower than the parsed-claim vocabulary in `availability_news.py`.
DOUBT_WORDS = (
    "injury", "injured", "knock", "doubt", "strain", "surgery", "out for",
    "ruled out", "limped", "suspended", "rested", "assessed", "scan",
)


@dataclass(frozen=True)
class Conflict:
    """One disagreement, carrying enough to act on without opening anything else."""

    element_id: int
    player: str
    club: str
    kind: str                 # "fringe-but-discussed" | "nailed-but-doubted"
    e_minutes: float
    # How many of the player's OWN fixtures stand behind that number. 0 means the
    # estimate is entirely prior-driven.
    #
    # This is the difference between the two sentences a fringe row can be saying.
    # "The model has thirty fixtures saying he is fringe" is a disagreement between
    # two pieces of evidence; "the model has never seen him play" is a disagreement
    # between evidence and an assumption, and only the second is likely to be
    # resolved by reading the quote. The opening case of this module is the second
    # kind — Gvardiol's 14.3 was last season mean-reverted forward — and the report
    # could not say so, because `e_minutes` was the only thing it looked at.
    evidence_fixtures: int
    xp: float
    gap: float                # how far from the threshold, for ranking
    source: str
    url: str
    claimed_at: str
    quote: str


def _rows(inbox_csv: str) -> List[Dict[str, str]]:
    """Inbox rows, parsed by the same reader the poller uses."""
    from pipeline.data.grok_feed import parse_sheet

    parsed = parse_sheet(inbox_csv) if inbox_csv.strip() else {"items": []}
    return [r for r in (parsed.get("items") or []) if isinstance(r, Mapping)]


def find_conflicts(
    xp_artifact: Mapping[str, Any],
    inbox_csv: str,
    bootstrap: Mapping[str, Any],
    *,
    fringe_minutes: float = FRINGE_MINUTES,
    nailed_minutes: float = NAILED_MINUTES,
) -> Tuple[List[Conflict], Dict[str, Tuple[int, ...]]]:
    """
    Disagreements between the projection and the scanned evidence.

    Returns the conflicts, ranked by how far apart the two sides are, and the
    ambiguous surnames that were refused rather than guessed.
    """
    index = build_player_index(bootstrap)
    projections = {
        int(p["element_id"]): p
        for p in (xp_artifact.get("players") or [])
        if isinstance(p, Mapping) and p.get("element_id") is not None
    }

    conflicts: List[Conflict] = []
    ambiguous: Dict[str, Tuple[int, ...]] = {}

    for row in _rows(inbox_csv):
        text = str(row.get("value") or "")
        if not text:
            continue
        ambiguous.update(index.ambiguous_in(text))
        low = fold(text)
        doubted = any(word in low for word in DOUBT_WORDS)

        for element_id in sorted(index.find(text)):
            projection = projections.get(element_id)
            if projection is None:
                continue
            e_minutes = float(projection.get("e_minutes") or 0.0)
            # Absent on an artifact written before this was published. `-1` rather
            # than `0`, because 0 is a real answer meaning "no evidence" and must not
            # be indistinguishable from "this file cannot tell you".
            raw_evidence = projection.get("evidence_fixtures")
            evidence_fixtures = -1 if raw_evidence is None else int(raw_evidence)

            if e_minutes < fringe_minutes:
                kind, gap = "fringe-but-discussed", fringe_minutes - e_minutes
            elif e_minutes > nailed_minutes and doubted:
                kind, gap = "nailed-but-doubted", e_minutes - nailed_minutes
            else:
                continue

            conflicts.append(Conflict(
                element_id=element_id,
                player=index.name_of.get(element_id, str(element_id)),
                club=index.club_of.get(element_id, ""),
                kind=kind,
                e_minutes=round(e_minutes, 1),
                evidence_fixtures=evidence_fixtures,
                xp=round(float(projection.get("xp") or 0.0), 2),
                gap=round(gap, 1),
                source=str(row.get("source") or ""),
                url=str(row.get("url") or ""),
                claimed_at=str(row.get("claimed_at") or ""),
                # The verbatim sentence, trimmed for a report line rather than
                # summarised — a paraphrase is not evidence.
                quote=" ".join(text.split())[:400],
            ))

    # Prior-only fringe rows first, then widest disagreement.
    #
    # Both orderings are "where a human's attention is worth most", and evidence
    # count is the stronger of the two: a fringe projection with no fixtures behind
    # it is an assumption being contradicted, which reading one quote can settle. A
    # fringe projection with thirty is two pieces of evidence disagreeing, which
    # reading a quote usually cannot. `-1` (an artifact that does not publish the
    # count) sorts with the evidence-backed rows: unknown must not be promoted as
    # though it were known to be zero.
    def attention(c: Conflict) -> tuple:
        prior_only = c.kind == "fringe-but-discussed" and c.evidence_fixtures == 0
        return (0 if prior_only else 1, -c.gap, c.player)

    conflicts.sort(key=attention)
    return conflicts, ambiguous


def to_artifact(conflicts: Sequence[Conflict],
                ambiguous: Mapping[str, Tuple[int, ...]],
                *, generated_at: str) -> Dict[str, Any]:
    """The publishable shape. Aggregates and quotes only — no derived values."""
    return {
        "schema_version": 1,
        "generated_at": generated_at,
        "thresholds": {
            "fringe_minutes": FRINGE_MINUTES,
            "nailed_minutes": NAILED_MINUTES,
        },
        # A reader needs to know that -1 is not a count.
        "evidence_fixtures_note": (
            "Fixtures of the player's own history behind the minutes estimate. "
            "0 means prior-driven; -1 means the projection artifact predates the "
            "field and the count is unknown."
        ),
        # Spelled out so a reader of the file does not have to infer the contract.
        "note": (
            "Disagreements between the minutes model and scanned evidence. "
            "Reported, never applied: correcting a projection from a quote needs "
            "a fitted model of pre-season minutes, not a regex."
        ),
        "conflicts": [asdict(c) for c in conflicts],
        "ambiguous_surnames": {k: list(v) for k, v in sorted(ambiguous.items())},
    }


def write_artifact(payload: Mapping[str, Any], path: Path) -> Path:
    """Publish atomically; the poller may read this on its tick."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_suffix(".json.tmp")
    scratch.write_text(json.dumps(payload, indent=1, ensure_ascii=False),
                       encoding="utf-8")
    scratch.replace(target)
    return target


def main(argv: Optional[Sequence[str]] = None) -> int:
    """`python -m pipeline.learning.minutes_conflicts --gameweek 1`"""
    import argparse
    from datetime import datetime, timezone

    parser = argparse.ArgumentParser(
        description="Report where the minutes model and scanned evidence disagree.")
    parser.add_argument("--gameweek", type=int, required=True)
    parser.add_argument("--predictions-dir", default="predictions")
    parser.add_argument("--bootstrap", default="data/raw/fpl/bootstrap_static.json")
    parser.add_argument("--write", action="store_true",
                        help="publish the artifact as well as printing it")
    args = parser.parse_args(argv)

    root = Path(args.predictions_dir)
    xp_path = root / "fpl" / f"xp_gw{args.gameweek:02d}.json"
    if not xp_path.is_file():
        print(f"no projection at {xp_path}; nothing to compare against")
        return 1
    inbox = root / "fpl" / "x_inbox.csv"

    conflicts, ambiguous = find_conflicts(
        json.loads(xp_path.read_text(encoding="utf-8")),
        inbox.read_text(encoding="utf-8") if inbox.is_file() else "",
        json.loads(Path(args.bootstrap).read_text(encoding="utf-8")),
    )

    if not conflicts:
        print("no disagreements: every mentioned player's minutes look consistent")
    for c in conflicts:
        print(f"\n{c.player} ({c.club})  {c.kind}")
        print(f"  model: {c.e_minutes:.0f} expected minutes, xP {c.xp:.2f}")
        print(f"  {c.source} {c.claimed_at}  {c.url}")
        print(f"  \"{c.quote[:180]}\"")
    if ambiguous:
        print(f"\nambiguous surnames, refused rather than guessed: "
              f"{', '.join(sorted(ambiguous))}")

    if args.write:
        stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        payload = to_artifact(conflicts, ambiguous, generated_at=stamp)
        name = f"minutes_conflicts_gw{args.gameweek:02d}.json"
        # Both copies, as the poller does. A local run that wrote only the private
        # artifact would leave the app showing something else, which is the shape
        # of every "the page has stale numbers" bug this repo has had.
        for target in (root / "fpl" / name,
                       Path("frontend/public/predictions/fpl") / name):
            print(f"\nwrote {write_artifact(payload, target)}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
