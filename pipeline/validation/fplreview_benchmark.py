"""Measure projection parity against a user-owned FPLReview export.

FPLReview is a comparator here, never training data.  The purpose of this
module is to make a temporary shadow period measurable while the independent
model is validated.  Similarity to another model is not accuracy, so this
report deliberately does not emit a pass/fail "cancel subscription" verdict.

The reference JSON is the output of
``frontend/scripts/import-fplreview-projections.mjs``.  Owned projections are
the normal ``xp_gwNN.json`` artifacts produced by this repository.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _average_ranks(values: Sequence[float]) -> List[float]:
    """One-based average ranks, including ties."""
    order = sorted(range(len(values)), key=lambda index: values[index])
    ranks = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = (start + 1 + end) / 2.0
        for position in range(start, end):
            ranks[order[position]] = rank
        start = end
    return ranks


def _pearson(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right):
        raise ValueError("correlation inputs have different lengths")
    if len(left) < 2:
        return 0.0
    left_mean, right_mean = _mean(left), _mean(right)
    numerator = sum(
        (a - left_mean) * (b - right_mean) for a, b in zip(left, right)
    )
    left_ss = sum((value - left_mean) ** 2 for value in left)
    right_ss = sum((value - right_mean) ** 2 for value in right)
    denominator = math.sqrt(left_ss * right_ss)
    return numerator / denominator if denominator else 0.0


def _spearman(left: Sequence[float], right: Sequence[float]) -> float:
    return _pearson(_average_ranks(left), _average_ranks(right))


def _round(value: float) -> float:
    return round(float(value), 6)


def _top_ids(rows: Sequence[Mapping[str, Any]], key: str, count: int) -> set[int]:
    ordered = sorted(
        rows,
        key=lambda row: (-float(row[key]), int(row["element_id"])),
    )
    return {int(row["element_id"]) for row in ordered[:count]}


def _metrics(rows: Sequence[Mapping[str, Any]], top_n: int) -> Dict[str, Any]:
    if not rows:
        return {
            "paired_players": 0,
            "xp_mae": None,
            "xp_rmse": None,
            "xp_bias_owned_minus_reference": None,
            "xp_pearson": None,
            "xp_spearman": None,
            "top_n": 0,
            "top_n_overlap": None,
            "top_n_jaccard": None,
            "minutes_paired": 0,
            "minutes_mae": None,
        }
    owned = [float(row["owned_xp"]) for row in rows]
    reference = [float(row["reference_xp"]) for row in rows]
    errors = [a - b for a, b in zip(owned, reference)]
    minutes_pairs = [
        (float(row["owned_minutes"]), float(row["reference_minutes"]))
        for row in rows
        if row.get("owned_minutes") is not None
        and row.get("reference_minutes") is not None
    ]

    effective_top_n = min(top_n, len(rows))
    owned_top = _top_ids(rows, "owned_xp", effective_top_n)
    reference_top = _top_ids(rows, "reference_xp", effective_top_n)
    union = owned_top | reference_top
    overlap = owned_top & reference_top

    return {
        "paired_players": len(rows),
        "xp_mae": _round(_mean([abs(error) for error in errors])),
        "xp_rmse": _round(math.sqrt(_mean([error * error for error in errors]))),
        "xp_bias_owned_minus_reference": _round(_mean(errors)),
        "xp_pearson": _round(_pearson(owned, reference)),
        "xp_spearman": _round(_spearman(owned, reference)),
        "top_n": effective_top_n,
        "top_n_overlap": _round(len(overlap) / effective_top_n)
        if effective_top_n
        else 0.0,
        "top_n_jaccard": _round(len(overlap) / len(union)) if union else 0.0,
        "minutes_paired": len(minutes_pairs),
        "minutes_mae": _round(
            _mean([abs(owned_value - reference_value) for owned_value, reference_value in minutes_pairs])
        ) if minutes_pairs else None,
    }


def load_reference(path: Path) -> Dict[int, Dict[int, Dict[str, float]]]:
    """Return ``gameweek -> element id -> reference values``."""
    payload = json.loads(Path(path).read_text())
    gameweeks = [int(value) for value in payload.get("gameweeks", [])]
    if not gameweeks:
        raise ValueError("reference snapshot has no gameweeks")

    result: Dict[int, Dict[int, Dict[str, float]]] = {gw: {} for gw in gameweeks}
    for player in payload.get("players", []):
        element_id = int(player["elementId"])
        points = player.get("projectedPoints", [])
        minutes = player.get("expectedMinutes", [])
        if len(points) != len(gameweeks) or len(minutes) != len(gameweeks):
            raise ValueError(
                f"reference player {element_id} does not cover every gameweek"
            )
        for index, gameweek in enumerate(gameweeks):
            result[gameweek][element_id] = {
                "xp": float(points[index]),
                "minutes": float(minutes[index]),
            }
    return result


def load_owned(paths: Iterable[Path]) -> Dict[int, Dict[int, Dict[str, float]]]:
    """Return ``gameweek -> element id -> owned model values``."""
    result: Dict[int, Dict[int, Dict[str, float]]] = {}
    for path in paths:
        payload = json.loads(Path(path).read_text())
        gameweek = int(payload.get("metadata", {}).get("gameweek"))
        if gameweek in result:
            raise ValueError(f"duplicate owned artifact for gameweek {gameweek}")
        result[gameweek] = {
            int(player["element_id"]): {
                "xp": float(player.get("xp", 0.0)),
                "minutes": float(player.get("e_minutes", 0.0)),
            }
            for player in payload.get("players", [])
        }
    return result


def compare(
    reference: Mapping[int, Mapping[int, Mapping[str, float]]],
    owned: Mapping[int, Mapping[int, Mapping[str, float]]],
    top_n: int = 20,
) -> Dict[str, Any]:
    """Compare overlapping gameweeks and official FPL element IDs."""
    if top_n <= 0:
        raise ValueError("top_n must be positive")

    gameweeks: List[Dict[str, Any]] = []
    all_rows: List[Dict[str, Any]] = []
    for gameweek in sorted(set(reference) & set(owned)):
        rows: List[Dict[str, Any]] = []
        common_ids = sorted(set(reference[gameweek]) & set(owned[gameweek]))
        for element_id in common_ids:
            row = {
                "element_id": element_id,
                "owned_xp": float(owned[gameweek][element_id]["xp"]),
                "reference_xp": float(reference[gameweek][element_id]["xp"]),
                "owned_minutes": owned[gameweek][element_id].get("minutes"),
                "reference_minutes": reference[gameweek][element_id].get("minutes"),
            }
            rows.append(row)
            all_rows.append(row)
        gameweeks.append({"gameweek": gameweek, **_metrics(rows, top_n)})

    return {
        "comparator": "FPLReview user export",
        "interpretation": (
            "Parity measures similarity to a comparator, not forecast accuracy. "
            "Do not train the owned model on these values or use this report alone "
            "to decide whether the subscription is replaceable."
        ),
        "overlapping_gameweeks": [row["gameweek"] for row in gameweeks],
        "per_gameweek": gameweeks,
        "aggregate": _metrics(all_rows, top_n),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path, help="Imported FPLReview JSON")
    parser.add_argument("owned", type=Path, nargs="+", help="xp_gwNN.json files")
    parser.add_argument("--top-n", type=int, default=20)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)

    report = compare(
        load_reference(args.reference), load_owned(args.owned), top_n=args.top_n
    )
    serialised = json.dumps(report, indent=2, allow_nan=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialised)
    else:
        print(serialised, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
