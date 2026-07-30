"""
Auto-substitution, captaincy resolution and squad scoring. Pure.

Three downstream consumers need this and none of them can be correct without it:

* the hypothetical weekly score of a *recommended* squad, which is how the agent
  is measured when a human did not submit it;
* every counterfactual in the ledger ("what would the alternative captain have
  scored");
* the bench slot values used by the optimiser, which are derived from simulated
  autosub frequencies rather than guessed.

The rule that trips people up: **appearing is not the same as playing minutes.**
FPL defines playing in a Gameweek as making an appearance on the pitch *or*
receiving a card, so a booked zero-minute player is not substituted and does not
hand the armband to the vice-captain.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from pipeline.fpl.rules import Rules, load_rules

# Chips that change how a squad is scored. Wildcard and Free Hit change which
# players you own, not how their points are counted, so they never appear here.
CHIP_BENCH_BOOST = "bboost"
CHIP_TRIPLE_CAPTAIN = "3xc"
SCORING_CHIPS = (CHIP_BENCH_BOOST, CHIP_TRIPLE_CAPTAIN)


@dataclass(frozen=True)
class Substitution:
    """One automatic substitution."""

    out_id: int
    in_id: int


@dataclass(frozen=True)
class Resolution:
    """The settled lineup after auto-substitution and captaincy fallback."""

    counted: Tuple[int, ...]
    substitutions: Tuple[Substitution, ...]
    captain: int
    captain_multiplier: int
    vice_used: bool
    chip: Optional[str] = None

    @property
    def formation(self) -> str:
        return ",".join(str(len(self.counted)) for _ in (0,))


@dataclass(frozen=True)
class SquadScore:
    """Total points and the resolution that produced them."""

    total: int
    resolution: Resolution
    per_player: Dict[int, int] = field(default_factory=dict)


def appeared(minutes: int, yellow_cards: int = 0, red_cards: int = 0) -> bool:
    """
    Whether a player counts as having played.

    "Playing in a Gameweek means making an appearance on the pitch or receiving
    a yellow / red card." A zero-minute booking therefore counts — verified by
    the replay oracle, which found exactly such a row scoring -1.
    """
    return minutes >= 1 or yellow_cards > 0 or red_cards > 0


def formation_is_legal(
    positions: Sequence[str], rules: Optional[Rules] = None
) -> bool:
    """Whether a set of counted positions is a legal starting XI."""
    rules = rules or load_rules()
    if len(positions) != rules.lineup_size:
        return False
    counts = {p: 0 for p in rules.play_bounds}
    for position in positions:
        if position not in counts:
            return False
        counts[position] += 1
    for position, (low, high) in rules.play_bounds.items():
        if not low <= counts[position] <= high:
            return False
    return True


def resolve_lineup(
    xi: Sequence[int],
    bench: Sequence[int],
    captain: int,
    vice_captain: int,
    positions: Mapping[int, str],
    played: Mapping[int, bool],
    rules: Optional[Rules] = None,
    chip: Optional[str] = None,
) -> Resolution:
    """
    Apply auto-substitutions and the captaincy fallback.

    ``bench`` must be in FPL's priority order, goalkeeper first: slot 12 is the
    reserve keeper, then slots 13, 14, 15 outfield in the manager's chosen order.

    Substitution follows FPL: bench players are tried in priority order and each
    replaces the first non-appearing starter for whom the resulting XI is still a
    legal formation. A swap that would break the formation is skipped, not
    forced — so a 3-4-3 losing a defender cannot promote a forward, and that
    bench player simply stays out.

    Under Bench Boost all fifteen count and no substitutions occur, because
    nobody is on the bench to come on.
    """
    rules = rules or load_rules()

    counted: List[int] = list(xi)
    substitutions: List[Substitution] = []

    if chip == CHIP_BENCH_BOOST:
        counted = list(xi) + list(bench)
    else:
        bench_remaining = [p for p in bench if played.get(p, False)]

        for candidate in list(bench_remaining):
            failing = [p for p in counted if not played.get(p, False)]
            if not failing:
                break
            for out_id in failing:
                trial = [candidate if p == out_id else p for p in counted]
                if formation_is_legal(
                    [positions[p] for p in trial], rules=rules
                ):
                    counted = trial
                    substitutions.append(
                        Substitution(out_id=out_id, in_id=candidate)
                    )
                    bench_remaining.remove(candidate)
                    break

    # Captaincy: the armband moves to the vice only if the captain did not
    # appear at all. A one-minute cameo keeps it.
    effective_captain = captain
    vice_used = False
    if not played.get(captain, False) and played.get(vice_captain, False):
        effective_captain = vice_captain
        vice_used = True

    multiplier = 3 if chip == CHIP_TRIPLE_CAPTAIN else 2

    return Resolution(
        counted=tuple(counted),
        substitutions=tuple(substitutions),
        captain=effective_captain,
        captain_multiplier=multiplier,
        vice_used=vice_used,
        chip=chip,
    )


def score_squad(
    xi: Sequence[int],
    bench: Sequence[int],
    captain: int,
    vice_captain: int,
    positions: Mapping[int, str],
    points: Mapping[int, int],
    played: Mapping[int, bool],
    rules: Optional[Rules] = None,
    chip: Optional[str] = None,
    transfer_cost: int = 0,
) -> SquadScore:
    """
    Total gameweek points for a squad.

    ``transfer_cost`` is the points hit already incurred (a positive number, e.g.
    ``4`` for one extra transfer); it is subtracted. Passing it here keeps the
    hit out of the projection layer, where discounting it would be a category
    error — the cost is certain.
    """
    rules = rules or load_rules()
    resolution = resolve_lineup(
        xi, bench, captain, vice_captain, positions, played, rules=rules, chip=chip
    )

    per_player: Dict[int, int] = {}
    for element_id in resolution.counted:
        base = int(points.get(element_id, 0))
        if element_id == resolution.captain:
            base *= resolution.captain_multiplier
        per_player[element_id] = base

    return SquadScore(
        total=sum(per_player.values()) - int(transfer_cost),
        resolution=resolution,
        per_player=per_player,
    )
