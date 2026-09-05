"""
Reading a manager's own team: squad, bank, free transfers, purchase prices.

All four endpoints are unauthenticated GETs, so nothing here needs or stores a
credential. The agent never writes to FPL — it proposes, a human submits — and
this module is the read half of that arrangement.

**Purchase price is the reason this exists.** Selling price is purchase plus half
the rise rounded down, and nothing in the API reports what you paid. It has to be
reconstructed by replaying ``entry/{id}/transfers/``, where ``element_in_cost``
is authoritative, back to the opening squad. Using ``now_cost`` instead
overstates the bank on every sale, and the error compounds across a season into
a squad FPL would reject.

The replay is exact where the history is complete and honestly flagged where it
is not: a player whose purchase cannot be traced is priced at ``now_cost`` and
marked, rather than being silently guessed at. Refusing to solve is not safer
than solving with a declared uncertainty — it just means no decision at all.
"""
from __future__ import annotations

import json
import logging
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set

from pipeline.config import (
    FPL_ENTRY,
    FPL_ENTRY_HISTORY,
    FPL_ENTRY_PICKS,
    FPL_ENTRY_TRANSFERS,
)

logger = logging.getLogger(__name__)

USER_AGENT = "pl-prediction-engine/1.0"
TIMEOUT_SECONDS = 30


class EntryError(RuntimeError):
    """The entry could not be read. Never fall back to a guessed squad."""


@dataclass
class EntryState:
    """A manager's actual position, as the API reports it."""

    entry_id: int
    gameweek: int
    squad: List[int] = field(default_factory=list)
    bank: int = 0
    free_transfers: int = 1
    purchase_prices: Dict[int, int] = field(default_factory=dict)
    # Players whose purchase price could not be traced. Their selling price
    # falls back to now_cost, which may overstate the bank.
    untraced: List[int] = field(default_factory=list)
    chips_used: List[str] = field(default_factory=list)

    @property
    def price_uncertain(self) -> bool:
        return bool(self.untraced)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "entry_id": self.entry_id,
            "gameweek": self.gameweek,
            "squad": sorted(self.squad),
            "bank": self.bank,
            "free_transfers": self.free_transfers,
            "purchase_prices": dict(sorted(self.purchase_prices.items())),
            "untraced": sorted(self.untraced),
            "price_uncertain": self.price_uncertain,
            "chips_used": list(self.chips_used),
        }


def _get(url: str) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 — re-raised as a typed error
        raise EntryError(f"could not read {url}: {exc}") from exc


def fetch_entry(entry_id: int) -> Dict[str, Any]:
    """Basic entry metadata: name, manager, current gameweek."""
    return _get(FPL_ENTRY.format(entry_id=entry_id))


def fetch_history(entry_id: int) -> Dict[str, Any]:
    """Per-gameweek history, including bank and squad value."""
    return _get(FPL_ENTRY_HISTORY.format(entry_id=entry_id))


def fetch_transfers(entry_id: int) -> List[Dict[str, Any]]:
    """
    Every transfer ever made, newest first as the API returns them.

    ``element_in_cost`` and ``element_out_cost`` are the prices AT THE TIME of
    the transfer, which is exactly what a purchase-price replay needs and what
    no other endpoint provides.
    """
    payload = _get(FPL_ENTRY_TRANSFERS.format(entry_id=entry_id))
    return payload if isinstance(payload, list) else []


def fetch_picks(entry_id: int, gameweek: int) -> Dict[str, Any]:
    """The squad actually fielded in a gameweek."""
    return _get(FPL_ENTRY_PICKS.format(entry_id=entry_id, gameweek=gameweek))


def banked_free_transfers(
    history: Mapping[str, Any],
    gameweek: int,
    cap: int,
    *,
    transfer_chips: Sequence[str],
) -> int:
    """
    How many free transfers are available for ``gameweek``.

    **The API does not publish this number, and the obvious substitutes are
    wrong.** ``read_entry_state`` used to return a hardcoded 1, with a comment
    saying the caller derived the real figure from the previous decision's
    ``free_transfers_after``. No caller did — and that derivation would have been
    wrong regardless, because a decision records what the agent PROPOSED. Decline
    a five-transfer proposal and the bank it predicted never existed.

    What is published is the observation this needs: ``history.current`` carries
    ``event_transfers`` per gameweek. So the count is replayed forward from the
    rule — one granted per gameweek, unspent ones banked to ``cap`` — over
    transfers that actually happened rather than ones that were advised.

    Starts at 1 for GW2 because GW1's transfers are unlimited: nothing before the
    opening deadline can be banked, whatever ``event_transfers`` says about it.
    Overspending cannot go negative — the excess was paid for in hits, and the
    next gameweek still gets its own.

    ``transfer_chips`` names the chips whose transfers do NOT come out of the
    bank. It is `rules.transfer_chips`, read from bootstrap's ``chip_type``, and
    it is a parameter rather than a constant here because this module had a
    hand-kept ``{"wildcard", "freehit"}`` — a second answer to a question the API
    publishes, and one that fails silently: a new transfer chip would have had
    its transfers counted against a bank they never touched.

    An empty list means no classification was available, and then every chip week
    spends the bank. That under-claims rather than over-claims, which is the same
    direction the missing-gameweek guard errs in and for the same reason.
    """
    if int(gameweek) <= 2:
        return 1

    granted = {str(name).lower() for name in transfer_chips}
    chip_events = {
        int(chip["event"])
        for chip in history.get("chips") or []
        if chip.get("event") is not None
        and str(chip.get("name", "")).lower() in granted
    }
    spent = {
        int(week["event"]): int(week.get("event_transfers", 0))
        for week in history.get("current") or []
        if week.get("event") is not None
    }

    # A week with no row is UNKNOWN, not zero. Banking one for it invents
    # transfers out of gameweeks that were never played, and the caller cannot
    # tell an invented bank from a real one. Falls back to the single transfer
    # every gameweek grants, which errs toward seeing a hit that is not there —
    # that costs a plan some expected points, where the other direction
    # recommends moves that silently cost -8.
    needed = range(2, int(gameweek))
    missing = [week for week in needed if week not in spent]
    if missing:
        logger.warning(
            "no history row for gameweek(s) %s, so the banked free-transfer "
            "count cannot be replayed; falling back to 1. A plan built on this "
            "will treat a free transfer as a hit rather than the reverse.",
            ", ".join(str(week) for week in missing),
        )
        return 1

    available = 1
    for week in needed:
        used = 0 if week in chip_events else spent[week]
        available = min(int(cap), max(0, available - used) + 1)
    return available


def replay_purchase_prices(
    opening_squad: Sequence[int],
    opening_prices: Mapping[int, int],
    transfers: Sequence[Mapping[str, Any]],
) -> Dict[int, int]:
    """
    Reconstruct what was paid for every currently-held player.

    Replays transfers OLDEST first — the API returns them newest first, and
    replaying in that order would apply a later sale before the purchase it
    depends on, quietly corrupting the basis of anyone transferred more than
    once.

    A player bought, sold and bought again correctly ends on his most recent
    purchase price, because each buy overwrites the previous basis.
    """
    prices = {int(p): int(opening_prices.get(p, 0)) for p in opening_squad}

    for move in sorted(transfers, key=lambda t: (t.get("event", 0), t.get("time", ""))):
        out_id = move.get("element_out")
        in_id = move.get("element_in")
        if out_id is not None:
            prices.pop(int(out_id), None)
        if in_id is not None:
            prices[int(in_id)] = int(move.get("element_in_cost", 0))
    return prices


def read_entry_state(
    entry_id: int,
    gameweek: int,
    now_costs: Optional[Mapping[int, int]] = None,
    *,
    max_banked_free_transfers: int,
    transfer_chips: Sequence[str],
) -> EntryState:
    """
    Everything the optimiser needs about a held team, for one gameweek.

    ``gameweek`` is the one being DECIDED, so picks come from the gameweek
    before it — the squad currently held is the one last fielded.

    Before the season starts there is nothing to read, and that is a valid
    state rather than an error: an entry with no picks yet is an opening build,
    which is exactly what GW1 is.
    """
    now_costs = {int(k): int(v) for k, v in (now_costs or {}).items()}

    last_played = int(gameweek) - 1
    if last_played < 1:
        logger.info("entry %s: no prior gameweek; treating as an opening build", entry_id)
        return EntryState(entry_id=int(entry_id), gameweek=int(gameweek))

    try:
        picks = fetch_picks(entry_id, last_played)
    except EntryError:
        logger.info(
            "entry %s has no picks for GW%s; treating as an opening build",
            entry_id, last_played,
        )
        return EntryState(entry_id=int(entry_id), gameweek=int(gameweek))

    squad = [int(p["element"]) for p in picks.get("picks", [])]
    if not squad:
        return EntryState(entry_id=int(entry_id), gameweek=int(gameweek))

    entry_history = picks.get("entry_history") or {}
    bank = int(entry_history.get("bank", 0))

    transfers = fetch_transfers(entry_id)
    # The opening squad is the current one with every transfer un-applied. Its
    # players were bought at GW1 prices, which the transfer log does not carry —
    # so anything still held from the opening squad is priced at now_cost and
    # flagged, rather than being invented.
    bought_later = {int(t["element_in"]) for t in transfers if t.get("element_in")}
    opening = [p for p in squad if p not in bought_later]

    prices = replay_purchase_prices(
        opening_squad=opening,
        opening_prices={p: now_costs.get(p, 0) for p in opening},
        transfers=transfers,
    )
    untraced = [p for p in opening if not now_costs.get(p)]

    history = fetch_history(entry_id)
    chips = [c.get("name", "") for c in history.get("chips", []) if c.get("name")]

    state = EntryState(
        entry_id=int(entry_id),
        gameweek=int(gameweek),
        squad=squad,
        bank=bank,
        # The API does not publish the banked count directly, so it is replayed
        # from the per-gameweek transfers it DOES publish. See
        # banked_free_transfers: this used to be a hardcoded 1 deferring to a
        # caller-side derivation that no caller performed.
        free_transfers=banked_free_transfers(
            history, int(gameweek), int(max_banked_free_transfers),
            transfer_chips=transfer_chips,
        ),
        purchase_prices={p: v for p, v in prices.items() if p in set(squad)},
        untraced=untraced,
        chips_used=chips,
    )
    if state.price_uncertain:
        logger.warning(
            "entry %s: %d held players have no traceable purchase price; their "
            "selling price falls back to now_cost and the bank may be overstated",
            entry_id, len(state.untraced),
        )
    return state
