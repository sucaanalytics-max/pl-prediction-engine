"""
The public projections view: distributions, not point estimates.

## Why a separate artifact rather than publishing `xp_gw{NN}.json`

The private artifact carries everything a re-solve needs — every tail
probability, the Monte Carlo standard error, the full diagnostics block — and
runs to hundreds of kilobytes. Most of that is input to the optimiser and
meaningless on a screen.

This is the display projection: one row per player, only the fields a reader
acts on, plus the name and team so the page does not have to join against
`bootstrap` to render a table. It is roughly a quarter of the size and, more
importantly, it is a **stable contract** — the private artifact's shape is free
to change with the model, and the two are decoupled deliberately.

## What it leads with

Not the mean. FPL points are wildly right-skewed and the published benchmark
puts the best models within 0.08 RMSE of each other and all near the theoretical
ceiling, so competing on the mean is competing on nothing. A player at
``xp 6.4`` most often returns **2**; that gap is the decision-relevant fact and
every product in the category hides it.

So each row leads with ``mode``, ``xp`` and ``p_ge_10`` together, and carries the
decomposition so a reader can see whether a 6.4 is built from appearance points
and a clean sheet or from a one-in-six chance of a haul. Those are different
holdings and no competitor distinguishes them.

## The prune

Written per gameweek, and every gameweek before the current one is deleted on
each run. Without that the directory grows by a file a week for a season and the
frontend has no way to tell which is current — the same failure mode as a stale
`decision_latest.json`, arrived at by accumulation rather than by naming.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

FILENAME = re.compile(r"^xp_public_gw(\d{2})\.json$")

#: Fields copied straight through from the simulation summary.
CARRIED = (
    "element_id", "xp", "xp_sd", "mode", "p_appears", "p_60", "e_minutes",
    "e_goals", "e_assists", "p_goal", "p_clean_sheet",
    "p_ge_2", "p_ge_5", "p_ge_10", "q10", "q50", "q90",
    "n_fixtures", "blank", "decomposition",
)


def build(
    artifact: Mapping[str, Any],
    names: Mapping[int, Any],
    *,
    generated_at: str,
) -> Dict[str, Any]:
    """
    Reduce the private xp artifact to the display view.

    ``names`` maps element id to ``(web_name, team, position)``. A player absent
    from it is still emitted, with nulls for the missing labels: dropping him
    would make the published universe depend on how complete the bootstrap
    happened to be, and a player silently missing from a projection table is
    indistinguishable from one nobody projected.
    """
    metadata = dict(artifact.get("metadata") or {})
    rows: List[Dict[str, Any]] = []

    for raw in artifact.get("players") or []:
        if not isinstance(raw, Mapping):
            continue
        element_id = raw.get("element_id")
        if not isinstance(element_id, int):
            # No id, no way to join it to anything. Emitting it would put an
            # unattributable row in a table people make transfers from.
            continue
        label = names.get(element_id) or (None, None, None)
        row: Dict[str, Any] = {
            "name": label[0],
            "team": label[1],
            "position": label[2],
        }
        for field in CARRIED:
            if field in raw:
                row[field] = raw[field]
        rows.append(row)

    return {
        "schema_version": SCHEMA_VERSION,
        "gameweek": metadata.get("gameweek"),
        "season": metadata.get("season"),
        "generated_at": generated_at,
        # Carried so the page can say how many draws are behind a tail
        # probability. `p_ge_10 = 0.15` from 2,000 draws and from 10,000 are
        # different statements about precision.
        "n_draws": metadata.get("n_draws"),
        "producer_version": metadata.get("schema_version"),
        "players": rows,
    }


def write(view: Mapping[str, Any], public_dir: Path) -> Optional[Path]:
    """Write the view for its gameweek, then prune older ones."""
    from pipeline.fpl.artifacts import write_json_atomically

    gameweek = view.get("gameweek")
    if not isinstance(gameweek, int):
        # Without a gameweek there is no filename and no way to prune. Refusing
        # is better than writing a file nothing can supersede.
        logger.warning("public xp view has no gameweek; not writing it")
        return None

    directory = Path(public_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = write_json_atomically(dict(view), directory / f"xp_public_gw{gameweek:02d}.json")
    prune(directory, keep=gameweek)
    return path


def prune(public_dir: Path, keep: int) -> List[Path]:
    """
    Delete every published projection for a gameweek before ``keep``.

    Strictly before, so a rerun of the current gameweek never deletes its own
    output. Later gameweeks are left alone too: a lookahead published on purpose
    is not this function's to remove.
    """
    removed: List[Path] = []
    directory = Path(public_dir)
    if not directory.is_dir():
        return removed
    for candidate in sorted(directory.glob("xp_public_gw*.json")):
        match = FILENAME.match(candidate.name)
        if not match:
            continue
        if int(match.group(1)) >= keep:
            continue
        try:
            candidate.unlink()
            removed.append(candidate)
        except OSError as error:
            # A file we cannot delete is a stale projection left visible, which
            # is worth a warning rather than a crash: the current gameweek's
            # file was written before this ran.
            logger.warning("could not prune %s: %s", candidate, error)
    if removed:
        logger.info("pruned %d superseded projection file(s)", len(removed))
    return removed


def notable(
    rows: Sequence[Mapping[str, Any]], limit: int = 60,
) -> List[Mapping[str, Any]]:
    """
    The rows worth showing first, by upside rather than by mean.

    Sorted on ``p_ge_10`` — the probability of a hauling week — because that is
    what a weekly-win entry is buying and what a mean ranking buries. Ties break
    on ``xp`` so the order is total and a rerun does not reshuffle the table.
    """
    def key(row: Mapping[str, Any]):
        return (
            -float(row.get("p_ge_10") or 0.0),
            -float(row.get("xp") or 0.0),
            int(row.get("element_id") or 0),
        )

    return sorted(rows, key=key)[:limit]
