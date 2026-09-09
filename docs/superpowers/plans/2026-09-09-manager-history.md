# Manager History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `manager_history.json` — a retrospective ledger of entry 20945's own gameweeks and transfers — and render it on `/review` as accounting.

**Architecture:** A standalone Python producer in the FPL agent workflow writes *facts* (per-gameweek picks, points, ranks; per-transfer points for both players in every settled gameweek since). The frontend narrows that at runtime and computes *verdicts* (effective vs raw deltas, 2/3/4-gameweek windows, pollution, withheld aggregates). Windows live in TypeScript so changing them costs no pipeline run.

**Tech Stack:** Python 3.11 (stdlib + existing `pipeline` modules), TypeScript, Next.js 14 App Router, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-09-manager-history-design.md`

## Global Constraints

- **Runtime narrowing, never `as T`.** Repo rule 4. All narrowing uses `lib/data/check.ts` helpers and returns `NarrowResult<T>`.
- **Absent ≠ null ≠ 0.** A gameweek absent from a by-gameweek map has not settled. Present-with-`null` multiplier means settled but the player had left the squad. Neither may render as zero.
- **Settled gameweeks only:** a gameweek counts only when `finished && data_checked` are both true.
- **The reconciliation identity is an assertion, not a field:** `Σ(multiplier × points) − event_transfers_cost == entry_history.points`. Violation raises and publishes nothing.
- **Ordering:** `pipeline/fpl/manager_history.py` (containing the literal string `manager_history.json`) must exist before the registry entry, or `paths.test.ts` fails. Task 4 precedes Task 5.
- **Do not add a gate to `pipeline/learning/schedule.py`.** Its order is load-bearing and pinned by tests.
- **Artifact path:** `frontend/public/predictions/fpl/manager_history.json`; registry `path` is `fpl/manager_history.json`.
- **Entry:** 20945, read from `FPL_ENTRIES["owner"]["entry_id"]`. Never hardcode.
- **Commit style:** end messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

### Deviation from the spec, deliberate

The spec's `transfers[].in_held_through` field is **dropped**. It is fully derivable from `in_multiplier_by_gw` (a `null` entry means the player had left the squad), and two encodings of one fact drift apart. Pollution is computed in the frontend from the multiplier map alone. Update the spec's artifact block when Task 4 lands.

---

### Task 1: A cached fetcher for `event/{gw}/live/`

`entry_api._get` is plain `urllib` with no cache, and this producer reads one live endpoint per settled gameweek on every hourly agent tick. `pipeline/data/fpl_api.py` already owns the cached-fetch pattern; add a public fetcher there beside the existing two.

**Files:**
- Modify: `pipeline/data/fpl_api.py` (add after `fetch_fixtures`, ~line 145)
- Test: `pipeline/tests/test_fpl_api_event_live.py`

**Interfaces:**
- Consumes: `_fetch_cached_json(url, cache_path, ttl_hours, force, allow_stale, label)`, `FPL_EVENT_LIVE`, `DATA_RAW` — all already in the module.
- Produces: `fetch_event_live(gameweek: int, force: bool = False, allow_stale: bool = True) -> dict`

- [ ] **Step 1: Write the failing test**

```python
"""A settled gameweek's live payload is cached per gameweek, not shared."""
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/dev/pl-prediction-engine && python -m pytest pipeline/tests/test_fpl_api_event_live.py -v`
Expected: FAIL — `AttributeError: module 'pipeline.data.fpl_api' has no attribute 'fetch_event_live'`

- [ ] **Step 3: Write the implementation**

Add to `pipeline/data/fpl_api.py` immediately after `fetch_fixtures`:

```python
def fetch_event_live(
    gameweek: int, force: bool = False, allow_stale: bool = True
) -> dict:
    """
    Realised per-element points for one gameweek.

    Cached per gameweek and for a long TTL on purpose: once a gameweek is
    `finished` and `data_checked` its points do not change, so the hourly agent
    tick must not re-fetch thirty-eight endpoints to learn nothing. The producer
    only ever asks for settled gameweeks, so a stale read here is a correct read.
    """
    data, _ = _fetch_cached_json(
        FPL_EVENT_LIVE.format(gameweek=int(gameweek)),
        DATA_RAW / "fpl" / f"event_live_{int(gameweek):02d}.json",
        ttl_hours=24 * 7,
        force=force,
        allow_stale=allow_stale,
        label=f"FPL event/{gameweek}/live",
    )
    return data
```

Add `FPL_EVENT_LIVE` to the module's existing `from pipeline.config import (...)` block.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest pipeline/tests/test_fpl_api_event_live.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add pipeline/data/fpl_api.py pipeline/tests/test_fpl_api_event_live.py
git commit -m "A settled gameweek's points do not change, so cache them

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Gameweek rows, and the identity that guards them

**Files:**
- Create: `pipeline/fpl/manager_history.py`
- Test: `pipeline/tests/test_manager_history.py`

**Interfaces:**
- Consumes: `fetch_event_live` (Task 1); `outcomes.parse_event_live`; `entry_api.fetch_history` / `fetch_picks`.
- Produces:
  - `ARTIFACT_NAME: str = "manager_history.json"`
  - `SCHEMA_VERSION: int = 1`
  - `class ManagerHistoryError(RuntimeError)`
  - `settled_gameweeks(bootstrap: dict) -> list[int]`
  - `points_by_element(live_payload: dict) -> dict[int, int]`
  - `minutes_by_element(live_payload: dict) -> dict[int, int]`
  - `build_gameweek_row(event, picks, history_row, points, minutes, average, highest) -> dict`

- [ ] **Step 1: Write the failing test**

```python
"""
Per-gameweek rows, and the identity that makes them trustworthy.

The identity is the whole guard: sum(multiplier x points) - transfer_cost equals
the points FPL credited. Verified exact for GW1-3 of 2026/27 against the live
API on 2026-09-09. It holds because `picks[].multiplier` is POST-auto-sub — GW1
auto-subbed Thomas in for Palestra and Palestra already carried multiplier 0.
"""
import pytest

from pipeline.fpl import manager_history as mh


def _picks(rows, cost=0, points=0, bench=0):
    return {
        "active_chip": None,
        "automatic_subs": [],
        "picks": [
            {"element": e, "position": i + 1, "multiplier": m,
             "is_captain": m >= 2, "is_vice_captain": False, "element_type": 3}
            for i, (e, m) in enumerate(rows)
        ],
        "entry_history": {
            "event": 3, "points": points, "total_points": points, "rank": 1,
            "overall_rank": 1, "bank": 0, "value": 1000, "event_transfers": 0,
            "event_transfers_cost": cost, "points_on_bench": bench,
        },
    }


def test_settled_means_finished_and_checked():
    bootstrap = {"events": [
        {"id": 1, "finished": True, "data_checked": True},
        {"id": 2, "finished": True, "data_checked": False},   # still settling
        {"id": 3, "finished": False, "data_checked": False},
    ]}
    assert mh.settled_gameweeks(bootstrap) == [1]


def test_a_row_carries_gross_and_net_separately():
    picks = _picks([(10, 2), (11, 1), (12, 0)], cost=4, points=(2 * 6 + 5) - 4)
    row = mh.build_gameweek_row(
        event=3, picks=picks, history_row=picks["entry_history"],
        points={10: 6, 11: 5, 12: 9}, minutes={10: 90, 11: 90, 12: 90},
        average=50, highest=131,
    )
    assert row["gross_points"] == 17      # 2*6 + 5 + 0*9
    assert row["transfer_cost"] == 4
    assert row["points"] == 13
    assert row["captain"] == {"element": 10, "multiplier": 2, "points": 6}


def test_a_broken_identity_raises_rather_than_publishing():
    """A plausible wrong number here is inherited by every derived metric."""
    picks = _picks([(10, 1)], cost=0, points=99)   # 99 != 1*6
    with pytest.raises(mh.ManagerHistoryError, match="does not reconcile"):
        mh.build_gameweek_row(
            event=3, picks=picks, history_row=picks["entry_history"],
            points={10: 6}, minutes={10: 90}, average=50, highest=131,
        )


def test_a_benched_player_who_played_still_scores_nothing_for_you():
    picks = _picks([(10, 1), (12, 0)], points=6, bench=9)
    row = mh.build_gameweek_row(
        event=3, picks=picks, history_row=picks["entry_history"],
        points={10: 6, 12: 9}, minutes={10: 90, 12: 90}, average=50, highest=131,
    )
    assert row["gross_points"] == 6
    assert row["bench_points"] == 9


def test_an_auto_sub_records_what_it_recovered():
    """
    GW1 2026/27: Thomas came on for Palestra.

    `points_gained` is the substitute's own contribution, NOT a difference
    between the two players — the man subbed out scored nothing, by definition
    of having been subbed out. The identity reconciling here is also the proof
    that `multiplier` is post-auto-sub: the substitute already carries 1 and the
    player replaced already carries 0.
    """
    picks = _picks([(10, 1), (11, 1), (12, 0)], points=10)
    picks["automatic_subs"] = [{"element_in": 11, "element_out": 99}]
    row = mh.build_gameweek_row(
        event=1, picks=picks, history_row=picks["entry_history"],
        points={10: 6, 11: 4, 12: 0}, minutes={10: 90, 11: 20, 12: 0},
        average=50, highest=131,
    )
    assert row["auto_subs"] == [
        {"element_in": 11, "element_out": 99, "points_gained": 4}
    ]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest pipeline/tests/test_manager_history.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.fpl.manager_history'`

- [ ] **Step 3: Write the implementation**

Create `pipeline/fpl/manager_history.py`:

```python
"""
A ledger of the manager's own season: what each gameweek returned, and what each
transfer did.

## Why this depends on no seal

`decision_review` scores decisions against `predictions/fpl/ledger/`, which only
exists for gameweeks the agent sealed before the deadline — two of three so far.
This producer answers a different question ("what happened") that needs no
forecast, so it deliberately reads only the public API and settles independently.
A gameweek the agent never sealed still has a history.

## Why it is not a gate in schedule.py

That gate order is load-bearing: `MISSED_SEAL` must stay last and
`PROJECTION_WINDOW` after it, both pinned by tests, and a new gate has already
once caused a livelock where one miss preempted every later gameweek. This runs
as its own workflow step instead, and cannot interfere.
"""
from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from pipeline.config import FPL_ENTRIES, FPL_PUBLIC_DIR
from pipeline.data.fpl_api import fetch_bootstrap_static, fetch_event_live
from pipeline.fpl.entry_api import fetch_history, fetch_picks, fetch_transfers

logger = logging.getLogger(__name__)

ARTIFACT_NAME = "manager_history.json"
SCHEMA_VERSION = 1


class ManagerHistoryError(RuntimeError):
    """The ledger could not be built. Never publish a plausible wrong number."""


def settled_gameweeks(bootstrap: Dict[str, Any]) -> List[int]:
    """
    Gameweeks whose points are final.

    Both flags are required. `finished` goes true when the last match ends;
    `data_checked` goes true when bonus and any corrections have landed. Reading
    a finished-but-unchecked gameweek would bake provisional bonus points into a
    permanent ledger.
    """
    return [
        int(event["id"])
        for event in bootstrap.get("events", [])
        if event.get("finished") and event.get("data_checked")
    ]


def points_by_element(live_payload: Dict[str, Any]) -> Dict[int, int]:
    """Realised total points per element for one gameweek."""
    return {
        int(element["id"]): int(element.get("stats", {}).get("total_points") or 0)
        for element in live_payload.get("elements", [])
        if element.get("id") is not None
    }


def minutes_by_element(live_payload: Dict[str, Any]) -> Dict[int, int]:
    """Realised minutes per element for one gameweek."""
    return {
        int(element["id"]): int(element.get("stats", {}).get("minutes") or 0)
        for element in live_payload.get("elements", [])
        if element.get("id") is not None
    }


def build_gameweek_row(
    *,
    event: int,
    picks: Dict[str, Any],
    history_row: Dict[str, Any],
    points: Dict[int, int],
    minutes: Dict[int, int],
    average: Optional[int],
    highest: Optional[int],
) -> Dict[str, Any]:
    """
    One settled gameweek, with the identity asserted.

    `multiplier` is post-auto-sub, so `sum(multiplier * points)` is the gross the
    manager actually scored, and subtracting `event_transfers_cost` must equal
    what FPL credited. Verified exact for GW1-3 of 2026/27. The subtraction term
    is NOT yet observed — every settled gameweek so far took no hit — so the
    first hit taken will confirm or refute it here, loudly.
    """
    rows = picks.get("picks") or []
    gross = sum(int(p.get("multiplier") or 0) * points.get(int(p["element"]), 0)
                for p in rows)
    cost = int(history_row.get("event_transfers_cost") or 0)
    credited = int(history_row.get("points") or 0)
    if gross - cost != credited:
        raise ManagerHistoryError(
            f"GW{event} does not reconcile: sum(multiplier x points) = {gross}, "
            f"transfer cost = {cost}, but FPL credited {credited}. Either the "
            f"multiplier is not post-auto-sub, or the hit is not a flat "
            f"subtraction. Publishing would inherit the error into every "
            f"derived metric."
        )

    captain = next((p for p in rows if int(p.get("multiplier") or 0) >= 2), None)
    subs = []
    for sub in picks.get("automatic_subs") or []:
        came_in = int(sub["element_in"])
        multiplier = next(
            (int(p.get("multiplier") or 0) for p in rows
             if int(p["element"]) == came_in), 0,
        )
        subs.append({
            "element_in": came_in,
            "element_out": int(sub["element_out"]),
            # What the auto-sub recovered. Not a difference: the player subbed
            # out scored nothing, by definition of being subbed out.
            "points_gained": multiplier * points.get(came_in, 0),
        })

    return {
        "event": int(event),
        "points": credited,
        "gross_points": gross,
        "transfer_cost": cost,
        "transfers_made": int(history_row.get("event_transfers") or 0),
        "bench_points": int(history_row.get("points_on_bench") or 0),
        "average_entry_score": average,
        "highest_score": highest,
        "rank": history_row.get("rank"),
        "overall_rank": history_row.get("overall_rank"),
        "value": history_row.get("value"),
        "bank": history_row.get("bank"),
        "chip": picks.get("active_chip"),
        "captain": None if captain is None else {
            "element": int(captain["element"]),
            "multiplier": int(captain.get("multiplier") or 0),
            "points": points.get(int(captain["element"]), 0),
        },
        "auto_subs": subs,
        "picks": [
            {
                "element": int(p["element"]),
                "multiplier": int(p.get("multiplier") or 0),
                "points": points.get(int(p["element"]), 0),
                "minutes": minutes.get(int(p["element"]), 0),
            }
            for p in rows
        ],
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest pipeline/tests/test_manager_history.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add pipeline/fpl/manager_history.py pipeline/tests/test_manager_history.py
git commit -m "Gameweek rows, guarded by an identity that must hold

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The transfer ledger

**Files:**
- Modify: `pipeline/fpl/manager_history.py` (append)
- Test: `pipeline/tests/test_manager_history_transfers.py`

**Interfaces:**
- Consumes: Task 2's module.
- Produces: `build_transfer_rows(transfers, settled, points_by_gw, picks_by_gw) -> list[dict]`
  - `transfers`: raw list from `fetch_transfers` (newest first as the API returns it)
  - `settled`: `list[int]`
  - `points_by_gw`: `dict[int, dict[int, int]]` — gameweek → element → points
  - `picks_by_gw`: `dict[int, dict[int, int]]` — gameweek → element → multiplier

- [ ] **Step 1: Write the failing test**

```python
"""
The transfer ledger, and the difference between absent and null.

Absent from a by-gameweek map = that gameweek has not settled.
Present with multiplier null = it settled, but the player had left the squad.
Collapsing the two makes "not yet played" read as "scored nothing".
"""
from pipeline.fpl import manager_history as mh


def test_transfers_come_back_oldest_first_whatever_the_api_did():
    """fetch_transfers returns newest first; a ledger reads forwards."""
    rows = mh.build_transfer_rows(
        transfers=[
            {"event": 5, "time": "t5", "element_in": 3, "element_in_cost": 50,
             "element_out": 4, "element_out_cost": 50, "entry": 1},
            {"event": 3, "time": "t3", "element_in": 1, "element_in_cost": 50,
             "element_out": 2, "element_out_cost": 50, "entry": 1},
        ],
        settled=[3, 4, 5],
        points_by_gw={3: {1: -1, 2: 2}, 4: {1: 5, 2: 1}, 5: {1: 0, 2: 0, 3: 7, 4: 1}},
        picks_by_gw={3: {1: 1}, 4: {1: 1}, 5: {3: 1}},
    )
    assert [r["event"] for r in rows] == [3, 5]


def test_a_window_only_covers_gameweeks_that_settled():
    rows = mh.build_transfer_rows(
        transfers=[{"event": 3, "time": "t", "element_in": 1, "element_in_cost": 50,
                    "element_out": 2, "element_out_cost": 50, "entry": 1}],
        settled=[3],
        points_by_gw={3: {1: -1, 2: 2}},
        picks_by_gw={3: {1: 1}},
    )
    row = rows[0]
    assert row["in_points_by_gw"] == {"3": -1}
    assert row["out_points_by_gw"] == {"3": 2}
    assert row["in_multiplier_by_gw"] == {"3": 1}
    assert "4" not in row["in_points_by_gw"], "GW4 has not settled; it must be absent"


def test_a_player_who_left_the_squad_is_null_not_missing():
    rows = mh.build_transfer_rows(
        transfers=[{"event": 3, "time": "t", "element_in": 1, "element_in_cost": 50,
                    "element_out": 2, "element_out_cost": 50, "entry": 1}],
        settled=[3, 4],
        points_by_gw={3: {1: 6, 2: 2}, 4: {1: 12, 2: 1}},
        picks_by_gw={3: {1: 1}, 4: {}},        # sold before GW4
    )
    row = rows[0]
    assert row["in_multiplier_by_gw"] == {"3": 1, "4": None}
    # His points are still recorded — the frontend needs them to show what the
    # sale cost — but the null multiplier marks GW4 onwards as polluted.
    assert row["in_points_by_gw"]["4"] == 12


def test_a_hit_is_recorded_at_the_gameweek_it_was_charged():
    rows = mh.build_transfer_rows(
        transfers=[{"event": 3, "time": "t", "element_in": 1, "element_in_cost": 50,
                    "element_out": 2, "element_out_cost": 50, "entry": 1}],
        settled=[3],
        points_by_gw={3: {1: 1, 2: 1}},
        picks_by_gw={3: {1: 1}},
    )
    assert rows[0]["event"] == 3
    assert rows[0]["element_in"] == 1 and rows[0]["element_out"] == 2
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest pipeline/tests/test_manager_history_transfers.py -v`
Expected: FAIL — `AttributeError: module has no attribute 'build_transfer_rows'`

- [ ] **Step 3: Write the implementation**

Append to `pipeline/fpl/manager_history.py`:

```python
def build_transfer_rows(
    *,
    transfers: List[Dict[str, Any]],
    settled: List[int],
    points_by_gw: Dict[int, Dict[int, int]],
    picks_by_gw: Dict[int, Dict[int, int]],
) -> List[Dict[str, Any]]:
    """
    One row per transfer, carrying both players' points for every settled
    gameweek from the transfer onwards.

    JSON object keys are strings, so the by-gameweek maps are keyed by `str(gw)`.

    Two absences that must not be confused, and are not:

    * A gameweek **missing** from a map has not settled. The frontend renders it
      as "not yet measurable" and excludes it from every window.
    * A gameweek present with `in_multiplier_by_gw[gw] is None` settled, but the
      incoming player was no longer in the squad. That is the pollution signal,
      and his points are still recorded so the sale can be priced.

    Windows, deltas and pollution are NOT computed here on purpose: they are
    presentation choices, and baking them into a committed artifact means a
    pipeline run to change 2/3/4 to 1/3/6.
    """
    forward = sorted(transfers, key=lambda t: (int(t["event"]), str(t.get("time") or "")))
    horizon = sorted(settled)

    rows: List[Dict[str, Any]] = []
    for transfer in forward:
        event = int(transfer["event"])
        came_in = int(transfer["element_in"])
        went_out = int(transfer["element_out"])
        covered = [gw for gw in horizon if gw >= event]

        rows.append({
            "event": event,
            "time": transfer.get("time"),
            "element_in": came_in,
            "element_in_cost": transfer.get("element_in_cost"),
            "element_out": went_out,
            "element_out_cost": transfer.get("element_out_cost"),
            "in_points_by_gw": {
                str(gw): points_by_gw.get(gw, {}).get(came_in, 0) for gw in covered
            },
            "out_points_by_gw": {
                str(gw): points_by_gw.get(gw, {}).get(went_out, 0) for gw in covered
            },
            "in_multiplier_by_gw": {
                str(gw): picks_by_gw.get(gw, {}).get(came_in) for gw in covered
            },
        })
    return rows
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest pipeline/tests/test_manager_history_transfers.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add pipeline/fpl/manager_history.py pipeline/tests/test_manager_history_transfers.py
git commit -m "The transfer ledger, where absent and null mean different things

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The producer, and the workflow step that publishes it

**Files:**
- Modify: `pipeline/fpl/manager_history.py` (append `build`, `run`, `main`)
- Modify: `.github/workflows/fpl_agent.yml` (new step after `run_agent`, before the commit step at ~line 199)
- Modify: `docs/superpowers/specs/2026-09-09-manager-history-design.md` (drop `in_held_through` from the artifact block, per Global Constraints)
- Test: `pipeline/tests/test_manager_history_build.py`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `build(...) -> dict`, `run(*, entry="owner", public_dir=FPL_PUBLIC_DIR, write=True) -> dict`, `main(argv=None) -> int`

- [ ] **Step 1: Write the failing test**

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest pipeline/tests/test_manager_history_build.py -v`
Expected: FAIL — `AttributeError: module has no attribute 'build'`

- [ ] **Step 3: Write the implementation**

Append to `pipeline/fpl/manager_history.py`:

```python
def build(
    *,
    entry_id: int,
    settled: List[int],
    gameweeks: List[Dict[str, Any]],
    transfers: List[Dict[str, Any]],
    generated_at: str,
) -> Dict[str, Any]:
    """Assemble the artifact. `settled_through` is null when nothing has."""
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "entry_id": int(entry_id),
        "settled_through": max(settled) if settled else None,
        "gameweeks": gameweeks,
        "transfers": transfers,
    }


def already_current(target: Path, *, settled_through: Optional[int]) -> bool:
    """
    Whether the published file already covers this much of the season.

    The agent runs hourly and a gameweek settles weekly, so without this the
    producer would rewrite an identical file 167 times between gameweeks and
    commit the churn.
    """
    if not target.exists():
        return False
    try:
        existing = json.loads(target.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    if int(existing.get("schema_version") or 0) != SCHEMA_VERSION:
        return False
    return existing.get("settled_through") == settled_through


def run(
    *,
    entry: str = "owner",
    public_dir: Path = FPL_PUBLIC_DIR,
    write: bool = True,
    force: bool = False,
) -> Dict[str, Any]:
    """Read the settled season and, by default, publish the ledger."""
    config = FPL_ENTRIES.get(entry)
    if config is None:
        raise KeyError(f"no FPL entry configured under {entry!r}")
    entry_id = int(config["entry_id"])

    bootstrap = fetch_bootstrap_static(allow_stale=True)
    settled = settled_gameweeks(bootstrap)
    target = Path(public_dir) / ARTIFACT_NAME
    settled_through = max(settled) if settled else None

    if not force and already_current(target, settled_through=settled_through):
        logger.info("%s already covers GW%s; nothing to do", ARTIFACT_NAME, settled_through)
        return json.loads(target.read_text())

    events = {int(e["id"]): e for e in bootstrap.get("events", [])}
    history = fetch_history(entry_id)
    history_rows = {int(r["event"]): r for r in history.get("current") or []}

    gameweeks: List[Dict[str, Any]] = []
    points_by_gw: Dict[int, Dict[int, int]] = {}
    picks_by_gw: Dict[int, Dict[int, int]] = {}

    for gameweek in settled:
        history_row = history_rows.get(gameweek)
        if history_row is None:
            raise ManagerHistoryError(
                f"GW{gameweek} is settled but absent from the entry's history. "
                f"The entry may not have existed yet; that is a real state, not "
                f"a default to paper over."
            )
        live = fetch_event_live(gameweek)
        picks = fetch_picks(entry_id, gameweek)
        points = points_by_element(live)
        minutes = minutes_by_element(live)
        points_by_gw[gameweek] = points
        picks_by_gw[gameweek] = {
            int(p["element"]): int(p.get("multiplier") or 0)
            for p in picks.get("picks") or []
        }
        event = events.get(gameweek, {})
        gameweeks.append(build_gameweek_row(
            event=gameweek, picks=picks, history_row=history_row,
            points=points, minutes=minutes,
            average=event.get("average_entry_score"),
            highest=event.get("highest_score"),
        ))

    payload = build(
        entry_id=entry_id,
        settled=settled,
        gameweeks=gameweeks,
        transfers=build_transfer_rows(
            transfers=fetch_transfers(entry_id),
            settled=settled,
            points_by_gw=points_by_gw,
            picks_by_gw=picks_by_gw,
        ),
        generated_at=datetime.now(timezone.utc).isoformat(),
    )

    if write:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=2) + "\n")
        logger.info(
            "wrote %s — %d gameweek(s), %d transfer(s)",
            target, len(payload["gameweeks"]), len(payload["transfers"]),
        )
    return payload


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", default="owner")
    parser.add_argument("--no-write", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )
    payload = run(entry=args.entry, write=not args.no_write, force=args.force)
    print(json.dumps(
        {k: v for k, v in payload.items() if k not in ("gameweeks", "transfers")},
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m pytest pipeline/tests/test_manager_history_build.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Run it against the live API and check the identity holds**

Run: `python -m pipeline.fpl.manager_history --verbose --force`
Expected: writes `frontend/public/predictions/fpl/manager_history.json`; prints `settled_through: 3`; **no `ManagerHistoryError`**. Then confirm the one known transfer:

```bash
python3 -c "
import json; d=json.load(open('frontend/public/predictions/fpl/manager_history.json'))
t=d['transfers'][0]
print('GW', t['event'], 'in', t['element_in'], 'out', t['element_out'])
print('in pts', t['in_points_by_gw'], 'out pts', t['out_points_by_gw'])
print('bench', [g['bench_points'] for g in d['gameweeks']])
"
```
Expected: `GW 3 in 445 out 418`, `in pts {'3': -1}`, `out pts {'3': 2}`, `bench [2, 13, 12]`.

- [ ] **Step 6: Add the workflow step**

In `.github/workflows/fpl_agent.yml`, after the `run: python -m pipeline.learning.run_agent` step and **before** the commit step:

```yaml
      # Deliberately its own step and not a gate in schedule.py, whose order is
      # load-bearing (MISSED_SEAL last, PROJECTION_WINDOW after it, both pinned
      # by tests). This reads only settled gameweeks off the public API, depends
      # on no seal, and exits early when nothing new has settled — so on the
      # hourly tick it costs a cached bootstrap read and nothing else.
      - name: Publish the manager's own history
        id: manager_history
        continue-on-error: true
        run: python -m pipeline.fpl.manager_history --verbose

      - name: Say so when the manager history is red
        if: always() && steps.manager_history.outcome == 'failure'
        run: |
          echo "::warning::manager_history did not publish; /review will show the last good copy or state its absence. If the reconciliation identity failed, the model of FPL scoring is wrong and the message says how."
```

`continue-on-error` because a failure here must never cost a seal — the same reasoning as the existing gates — and the annotation is keyed on `outcome`, not `conclusion`, because `continue-on-error` turns a failed step's conclusion into `success`.

- [ ] **Step 7: Update the spec**

In `docs/superpowers/specs/2026-09-09-manager-history-design.md`, delete the `in_held_through` line from the artifact block and note that pollution derives from `in_multiplier_by_gw` being `null`.

- [ ] **Step 8: Commit**

```bash
git add pipeline/fpl/manager_history.py pipeline/tests/test_manager_history_build.py \
        .github/workflows/fpl_agent.yml docs/superpowers/specs/2026-09-09-manager-history-design.md \
        frontend/public/predictions/fpl/manager_history.json
git commit -m "Publish the manager's own history, hourly but only when it changed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The narrower and the registry entry

Task 4 must be committed first: `paths.test.ts` greps `pipeline/**/*.py` for the literal `manager_history.json` and fails a registry path no module writes.

**Files:**
- Create: `frontend/lib/data/narrow-manager-history.ts`
- Modify: `frontend/lib/data/narrow.ts` (import + REGISTRY entry after `messages`, ~line 1312)
- Test: `frontend/lib/data/narrow-manager-history.test.ts`

**Interfaces:**
- Consumes: `check.ts` — `Problems`, `reqRecord`, `reqArray`, `reqNumber`, `optNumber`, `optString`, `mapKept`; `artifact.ts` — `narrowed`, `malformed`, `NarrowResult`.
- Produces:
  - `interface ManagerGameweek`, `interface ManagerTransfer`, `interface ManagerHistory`
  - `narrowManagerHistory(raw: unknown): NarrowResult<ManagerHistory>`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Narrowing the manager ledger.
 *
 * The load-bearing case is the by-gameweek maps: a `null` multiplier must
 * survive as `null` and never become 0, because null is the pollution signal
 * and 0 means "benched, earned you nothing" — opposite conclusions.
 */
import { describe, expect, it } from "vitest";
import { narrowManagerHistory } from "@/lib/data/narrow-manager-history";

const MINIMAL = {
  schema_version: 1,
  generated_at: "2026-09-09T00:00:00+00:00",
  entry_id: 20945,
  settled_through: 3,
  gameweeks: [{
    event: 3, points: 38, gross_points: 38, transfer_cost: 0, transfers_made: 1,
    bench_points: 12, average_entry_score: 51, highest_score: 119,
    rank: 9427920, overall_rank: 3427838, value: 999, bank: 0, chip: null,
    captain: { element: 5, multiplier: 2, points: 2 },
    auto_subs: [], picks: [{ element: 445, multiplier: 1, points: -1, minutes: 90 }],
  }],
  transfers: [{
    event: 3, time: "2026-09-04T16:59:34Z",
    element_in: 445, element_in_cost: 50, element_out: 418, element_out_cost: 50,
    in_points_by_gw: { "3": -1 }, out_points_by_gw: { "3": 2 },
    in_multiplier_by_gw: { "3": 1 },
  }],
};

describe("narrowManagerHistory", () => {
  it("carries the ledger through", () => {
    const result = narrowManagerHistory(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settledThrough).toBe(3);
    expect(result.value.gameweeks[0].benchPoints).toBe(12);
    expect(result.value.transfers[0].inPointsByGw.get(3)).toBe(-1);
  });

  it("keeps a null multiplier null, because null is not zero here", () => {
    const polluted = structuredClone(MINIMAL);
    polluted.transfers[0].in_multiplier_by_gw = { "3": 1, "4": null } as never;
    polluted.transfers[0].in_points_by_gw = { "3": -1, "4": 12 } as never;
    const result = narrowManagerHistory(polluted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const multipliers = result.value.transfers[0].inMultiplierByGw;
    expect(multipliers.get(4)).toBeNull();
    expect(multipliers.has(4)).toBe(true);
    expect(multipliers.has(5)).toBe(false); // absent: GW5 has not settled
  });

  it("reports a season with nothing settled rather than inventing one", () => {
    const result = narrowManagerHistory({
      ...MINIMAL, settled_through: null, gameweeks: [], transfers: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settledThrough).toBeNull();
    expect(result.value.gameweeks).toEqual([]);
  });

  it("is malformed, not empty, when the envelope is wrong", () => {
    const result = narrowManagerHistory({ gameweeks: "not an array" });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run lib/data/narrow-manager-history.test.ts`
Expected: FAIL — cannot resolve `@/lib/data/narrow-manager-history`

- [ ] **Step 3: Write the implementation**

Create `frontend/lib/data/narrow-manager-history.ts`:

```ts
/**
 * Runtime narrowing for `fpl/manager_history.json`.
 *
 * ## Why the by-gameweek maps become `Map<number, number | null>`
 *
 * JSON object keys are strings, and three states have to survive the boundary:
 * a key that is **absent** (that gameweek has not settled), a key present with
 * **null** (it settled, but the player had left the squad — the pollution
 * signal), and a key present with a **number**. A `Record<string, number>` with
 * `?? 0` applied anywhere collapses the first two into "scored nothing", which
 * is the opposite conclusion from "not yet played" and from "no longer yours".
 */
import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  Problems, mapKept, optNumber, optString, reqArray, reqNumber, reqRecord,
} from "@/lib/data/check";

export interface ManagerPick {
  readonly element: number;
  readonly multiplier: number;
  readonly points: number;
  readonly minutes: number;
}

export interface ManagerGameweek {
  readonly event: number;
  readonly points: number;
  readonly grossPoints: number;
  readonly transferCost: number;
  readonly transfersMade: number;
  readonly benchPoints: number;
  readonly averageEntryScore: number | null;
  readonly highestScore: number | null;
  readonly rank: number | null;
  readonly overallRank: number | null;
  readonly value: number | null;
  readonly bank: number | null;
  readonly chip: string | null;
  readonly captain: { readonly element: number; readonly multiplier: number; readonly points: number } | null;
  readonly autoSubs: readonly { readonly elementIn: number; readonly elementOut: number; readonly pointsGained: number }[];
  readonly picks: readonly ManagerPick[];
}

export interface ManagerTransfer {
  readonly event: number;
  readonly time: string | null;
  readonly elementIn: number;
  readonly elementInCost: number | null;
  readonly elementOut: number;
  readonly elementOutCost: number | null;
  readonly inPointsByGw: ReadonlyMap<number, number>;
  readonly outPointsByGw: ReadonlyMap<number, number>;
  readonly inMultiplierByGw: ReadonlyMap<number, number | null>;
}

export interface ManagerHistory {
  readonly generatedAt: string | null;
  readonly entryId: number | null;
  readonly settledThrough: number | null;
  readonly gameweeks: readonly ManagerGameweek[];
  readonly transfers: readonly ManagerTransfer[];
}

/** A by-gameweek map. Absent stays absent; null stays null. */
function gwMap(raw: unknown, label: string, problems: Problems): Map<number, number | null> {
  const out = new Map<number, number | null>();
  const record = reqRecord(raw, label, problems);
  if (!record) return out;
  for (const [key, value] of Object.entries(record)) {
    const gameweek = Number(key);
    if (!Number.isFinite(gameweek)) {
      problems.add(`${label} has a non-numeric gameweek key ${key}`);
      continue;
    }
    out.set(gameweek, value === null ? null : optNumber(value));
  }
  return out;
}

/** As {@link gwMap}, for maps where null is not a legal value. */
function gwPoints(raw: unknown, label: string, problems: Problems): Map<number, number> {
  const out = new Map<number, number>();
  for (const [gameweek, value] of gwMap(raw, label, problems)) {
    if (value === null) {
      problems.add(`${label} has a null at GW${gameweek}; points are never null`);
      continue;
    }
    out.set(gameweek, value);
  }
  return out;
}

export function narrowManagerHistory(raw: unknown): NarrowResult<ManagerHistory> {
  const problems = new Problems();
  const file = reqRecord(raw, "manager_history", problems);
  if (!file) return malformed(problems.all);

  const gameweekList = reqArray(file.gameweeks, "gameweeks", problems);
  const transferList = reqArray(file.transfers, "transfers", problems);
  if (!gameweekList || !transferList) return malformed(problems.all);

  const gameweeks = mapKept(gameweekList, "gameweeks", problems, (item, i) => {
    const row = reqRecord(item, `gameweeks[${i}]`, problems);
    if (!row) return null;
    const event = reqNumber(row.event, `gameweeks[${i}].event`, problems);
    const points = reqNumber(row.points, `gameweeks[${i}].points`, problems);
    if (event === null || points === null) return null;

    const captainRow = row.captain === null ? null : reqRecord(row.captain, `gameweeks[${i}].captain`, problems);
    const subs = mapKept(row.auto_subs ?? [], `gameweeks[${i}].auto_subs`, problems, (s, j) => {
      const sub = reqRecord(s, `gameweeks[${i}].auto_subs[${j}]`, problems);
      if (!sub) return null;
      return {
        elementIn: optNumber(sub.element_in) ?? 0,
        elementOut: optNumber(sub.element_out) ?? 0,
        pointsGained: optNumber(sub.points_gained) ?? 0,
      };
    });
    const picks = mapKept(row.picks ?? [], `gameweeks[${i}].picks`, problems, (p, j) => {
      const pick = reqRecord(p, `gameweeks[${i}].picks[${j}]`, problems);
      if (!pick) return null;
      const element = reqNumber(pick.element, `gameweeks[${i}].picks[${j}].element`, problems);
      if (element === null) return null;
      return {
        element,
        multiplier: optNumber(pick.multiplier) ?? 0,
        points: optNumber(pick.points) ?? 0,
        minutes: optNumber(pick.minutes) ?? 0,
      };
    });

    return {
      event, points,
      grossPoints: optNumber(row.gross_points) ?? points,
      transferCost: optNumber(row.transfer_cost) ?? 0,
      transfersMade: optNumber(row.transfers_made) ?? 0,
      benchPoints: optNumber(row.bench_points) ?? 0,
      averageEntryScore: optNumber(row.average_entry_score),
      highestScore: optNumber(row.highest_score),
      rank: optNumber(row.rank),
      overallRank: optNumber(row.overall_rank),
      value: optNumber(row.value),
      bank: optNumber(row.bank),
      chip: optString(row.chip),
      captain: captainRow === null || captainRow === undefined ? null : {
        element: optNumber(captainRow.element) ?? 0,
        multiplier: optNumber(captainRow.multiplier) ?? 0,
        points: optNumber(captainRow.points) ?? 0,
      },
      autoSubs: subs,
      picks,
    } satisfies ManagerGameweek;
  });

  const transfers = mapKept(transferList, "transfers", problems, (item, i) => {
    const row = reqRecord(item, `transfers[${i}]`, problems);
    if (!row) return null;
    const event = reqNumber(row.event, `transfers[${i}].event`, problems);
    const elementIn = reqNumber(row.element_in, `transfers[${i}].element_in`, problems);
    const elementOut = reqNumber(row.element_out, `transfers[${i}].element_out`, problems);
    if (event === null || elementIn === null || elementOut === null) return null;
    return {
      event,
      time: optString(row.time),
      elementIn,
      elementInCost: optNumber(row.element_in_cost),
      elementOut,
      elementOutCost: optNumber(row.element_out_cost),
      inPointsByGw: gwPoints(row.in_points_by_gw, `transfers[${i}].in_points_by_gw`, problems),
      outPointsByGw: gwPoints(row.out_points_by_gw, `transfers[${i}].out_points_by_gw`, problems),
      inMultiplierByGw: gwMap(row.in_multiplier_by_gw, `transfers[${i}].in_multiplier_by_gw`, problems),
    } satisfies ManagerTransfer;
  });

  return narrowed({
    generatedAt: optString(file.generated_at),
    entryId: optNumber(file.entry_id),
    settledThrough: optNumber(file.settled_through),
    gameweeks,
    transfers,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run lib/data/narrow-manager-history.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: Add the registry entry**

In `frontend/lib/data/narrow.ts`, import the narrower at the top, then add to `REGISTRY` after the `messages` entry:

```ts
  managerHistory: ({
    key: "managerHistory",
    path: "fpl/manager_history.json",
    owner: "agent",
    describes: "your own gameweeks, and what each transfer returned",
    // Eight days, not hours. The file only changes when a gameweek settles and
    // gameweeks are ~7 days apart, so an hourly-tuned budget would mark it
    // stale six days in seven while it was perfectly correct — which trains the
    // reader to ignore the chip, and then it fails to warn when it matters.
    // The GW5 -> GW6 international break (2026-09-18 to 2026-10-10) will trip
    // it legitimately, and that reading is correct: the file really is a month old.
    freshnessBudgetMs: 8 * DAY,
    narrow: narrowManagerHistory,
    producedAtOf: (v) => v.generatedAt,
    // Empty means nothing has settled at all. Three gameweeks with an empty
    // transfer list is NOT empty — it is a manager who has made no transfers,
    // and the page has something true to say about that.
    isEmpty: (v) => v.gameweeks.length === 0,
  }) satisfies Descriptor<ManagerHistory>,
```

- [ ] **Step 6: Run the guard tests**

Run: `cd frontend && npx vitest run lib/data/paths.test.ts lib/data/dead-reads.test.ts lib/data/real-artifacts.test.ts lib/data/descriptor-identity.test.ts`
Expected: PASS. If `paths.test.ts` fails with "nothing publishes this", Task 4 was not committed first.

- [ ] **Step 7: Commit**

```bash
git add frontend/lib/data/narrow-manager-history.ts frontend/lib/data/narrow-manager-history.test.ts frontend/lib/data/narrow.ts
git commit -m "Narrow the manager ledger, keeping null distinct from zero

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Window arithmetic, pollution, and withheld aggregates

**Files:**
- Create: `frontend/lib/data/manager-history.ts`
- Test: `frontend/lib/data/manager-history.test.ts`

**Interfaces:**
- Consumes: `ManagerHistory`, `ManagerTransfer` (Task 5).
- Produces:
  - `const SPANS: readonly [1, 2, 3, 4]`
  - `const MINIMUM_CLEAN_WINDOWS = 5`
  - `interface TransferWindow { span; settled; polluted; effective; raw; gap }`
  - `windowFor(transfer: ManagerTransfer, span: number): TransferWindow`
  - `interface SeasonTotals { benchPoints; vsAverage; hitSpend; autoSubRescue }`
  - `seasonTotals(history: ManagerHistory): SeasonTotals`
  - `interface TransferAggregate { span; n; effective; raw; withheldReason }`
  - `transferAggregate(history: ManagerHistory, span: number): TransferAggregate`
  - `basketFor(history: ManagerHistory, event: number): { event; transfers; hit; effective; settled }`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Windows, pollution, and what must be withheld.
 *
 * The case that separates the two definitions is a good buy left on the bench:
 * raw says you picked well, effective says it earned you nothing, and both are
 * true. Their difference is the third metric.
 */
import { describe, expect, it } from "vitest";
import {
  MINIMUM_CLEAN_WINDOWS, basketFor, seasonTotals, transferAggregate, windowFor,
} from "@/lib/data/manager-history";
import type { ManagerHistory, ManagerTransfer } from "@/lib/data/narrow-manager-history";

function transfer(over: Partial<ManagerTransfer> = {}): ManagerTransfer {
  return {
    event: 3, time: null, elementIn: 1, elementInCost: 50,
    elementOut: 2, elementOutCost: 50,
    inPointsByGw: new Map([[3, -1]]),
    outPointsByGw: new Map([[3, 2]]),
    inMultiplierByGw: new Map([[3, 1]]),
    ...over,
  } as ManagerTransfer;
}

describe("windowFor", () => {
  it("scores the gameweek the transfer was made", () => {
    const w = windowFor(transfer(), 1);
    expect(w.settled).toBe(true);
    expect(w.raw).toBe(-3);        // -1 - 2
    expect(w.effective).toBe(-3);  // x1, he started
    expect(w.polluted).toBe(false);
  });

  it("withholds a window whose gameweeks have not all settled", () => {
    const w = windowFor(transfer(), 2);
    expect(w.settled).toBe(false);
    expect(w.effective).toBeNull();
    expect(w.raw).toBeNull();
  });

  it("says a benched buy earned nothing while still crediting the pick", () => {
    const w = windowFor(transfer({
      inPointsByGw: new Map([[3, 12]]),
      outPointsByGw: new Map([[3, 2]]),
      inMultiplierByGw: new Map([[3, 0]]),   // benched
    }), 1);
    expect(w.raw).toBe(10);
    expect(w.effective).toBe(0);
    expect(w.gap).toBe(10);   // value given back by the lineup decision
  });

  it("doubles a captained buy", () => {
    const w = windowFor(transfer({
      inPointsByGw: new Map([[3, 12]]),
      outPointsByGw: new Map([[3, 2]]),
      inMultiplierByGw: new Map([[3, 2]]),
    }), 1);
    expect(w.effective).toBe(20);
  });

  it("marks a window polluted once the player leaves the squad", () => {
    const w = windowFor(transfer({
      inPointsByGw: new Map([[3, 5], [4, 9]]),
      outPointsByGw: new Map([[3, 2], [4, 1]]),
      inMultiplierByGw: new Map([[3, 1], [4, null]]),
    }), 2);
    expect(w.settled).toBe(true);
    expect(w.polluted).toBe(true);
  });
});

describe("transferAggregate", () => {
  const history = (transfers: ManagerTransfer[]): ManagerHistory => ({
    generatedAt: null, entryId: 20945, settledThrough: 3,
    gameweeks: [], transfers,
  });

  it("withholds until there are enough clean windows, and says why", () => {
    const a = transferAggregate(history([transfer()]), 1);
    expect(a.n).toBe(1);
    expect(a.effective).toBeNull();
    expect(a.withheldReason).toContain(String(MINIMUM_CLEAN_WINDOWS));
  });

  it("excludes polluted windows from the count rather than blending them", () => {
    const polluted = transfer({
      inPointsByGw: new Map([[3, 5]]),
      outPointsByGw: new Map([[3, 2]]),
      inMultiplierByGw: new Map([[3, null]]),
    });
    const a = transferAggregate(history([transfer(), polluted]), 1);
    expect(a.n).toBe(1);
  });
});

describe("seasonTotals", () => {
  const week = (over: Record<string, unknown>) => ({
    benchPoints: 0, averageEntryScore: 50, transferCost: 0,
    autoSubs: [], captain: null, picks: [], ...over,
  });

  it("totals the bench and the margin over the field", () => {
    const totals = seasonTotals({
      generatedAt: null, entryId: 20945, settledThrough: 3, transfers: [],
      gameweeks: [
        week({ event: 1, points: 44, benchPoints: 2, averageEntryScore: 50 }),
        week({ event: 2, points: 109, benchPoints: 13, averageEntryScore: 81 }),
        week({ event: 3, points: 38, benchPoints: 12, averageEntryScore: 51 }),
      ] as never,
    });
    expect(totals.benchPoints).toBe(27);
    expect(totals.vsAverage).toBe(9);    // 191 - 182
    expect(totals.hitSpend).toBe(0);
  });

  it("prices the armband against the best player you already owned", () => {
    const totals = seasonTotals({
      generatedAt: null, entryId: 20945, settledThrough: 1, transfers: [],
      gameweeks: [week({
        event: 1, points: 15,
        captain: { element: 1, multiplier: 2, points: 2 },
        picks: [
          { element: 1, multiplier: 2, points: 2, minutes: 90 },
          { element: 2, multiplier: 1, points: 13, minutes: 90 },
        ],
      })] as never,
    });
    expect(totals.captainPoints).toBe(4);        // 2 x 2
    expect(totals.bestCaptainPoints).toBe(26);   // 13 x 2, hindsight, from the 15
    expect(totals.captaincyCost).toBe(22);
  });

  it("says the margin is unknown rather than wrong when a average is missing", () => {
    const totals = seasonTotals({
      generatedAt: null, entryId: 20945, settledThrough: 1, transfers: [],
      gameweeks: [week({ event: 1, points: 44, averageEntryScore: null })] as never,
    });
    expect(totals.vsAverage).toBeNull();
  });
});

describe("basketFor", () => {
  const history = (transfers: ManagerTransfer[]): ManagerHistory => ({
    generatedAt: null, entryId: 20945, settledThrough: 3,
    gameweeks: [], transfers,
  });

  it("takes a gameweek's transfers together, because the pairing is arbitrary", () => {
    const second = transfer({
      elementIn: 3, elementOut: 4,
      inPointsByGw: new Map([[3, 8]]),
      outPointsByGw: new Map([[3, 1]]),
      inMultiplierByGw: new Map([[3, 1]]),
    });
    const basket = basketFor(history([transfer(), second]), 3);
    expect(basket.transfers).toBe(2);
    expect(basket.settled).toBe(true);
    expect(basket.effective).toBe(4);   // (-1 - 2) + (8 - 1)
  });

  it("is unsettled, not zero, when the gameweek has not finished", () => {
    const unsettled = transfer({
      event: 9, inPointsByGw: new Map(), outPointsByGw: new Map(),
      inMultiplierByGw: new Map(),
    });
    const basket = basketFor(history([unsettled]), 9);
    expect(basket.settled).toBe(false);
    expect(basket.effective).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run lib/data/manager-history.test.ts`
Expected: FAIL — cannot resolve `@/lib/data/manager-history`

- [ ] **Step 3: Write the implementation**

Create `frontend/lib/data/manager-history.ts`:

```ts
/**
 * Verdicts computed from the manager ledger's facts.
 *
 * These live here rather than in the producer because windows are a
 * presentation choice: changing 2/3/4 to 1/3/6, or adding a clean-only toggle,
 * must not need a pipeline run and a commit.
 */
import type { ManagerHistory, ManagerTransfer } from "@/lib/data/narrow-manager-history";

/** Same-gameweek, then the following two, three and four. */
export const SPANS = [1, 2, 3, 4] as const;

/**
 * Clean windows required before a season rate is reported.
 *
 * One transfer is an anecdote and a rate rendered off it is indistinguishable
 * from a finding — the same reasoning as `decision-review.ts`'s
 * `minimumObservations`. Five is the point at which a single outlier stops
 * setting the sign.
 */
export const MINIMUM_CLEAN_WINDOWS = 5;

export interface TransferWindow {
  readonly span: number;
  /** Every gameweek in the window has settled. */
  readonly settled: boolean;
  /** The incoming player left the squad inside the window. */
  readonly polluted: boolean;
  /** Points that actually reached the score. Null when unsettled. */
  readonly effective: number | null;
  /** The scouting call, ignoring lineup. Null when unsettled. */
  readonly raw: number | null;
  /** raw − effective: value given back through lineup decisions. */
  readonly gap: number | null;
}

export function windowFor(transfer: ManagerTransfer, span: number): TransferWindow {
  const gameweeks: number[] = [];
  for (let gw = transfer.event; gw < transfer.event + span; gw += 1) gameweeks.push(gw);

  const settled = gameweeks.every((gw) => transfer.inPointsByGw.has(gw));
  if (!settled) {
    return { span, settled: false, polluted: false, effective: null, raw: null, gap: null };
  }

  let raw = 0;
  let effective = 0;
  let polluted = false;
  for (const gw of gameweeks) {
    const delta = (transfer.inPointsByGw.get(gw) ?? 0) - (transfer.outPointsByGw.get(gw) ?? 0);
    raw += delta;
    const multiplier = transfer.inMultiplierByGw.get(gw) ?? null;
    // Null is "no longer in the squad", which is the pollution signal and earns
    // nothing. It is NOT the same as 0, which is "benched and earned nothing".
    if (multiplier === null) polluted = true;
    effective += delta * (multiplier ?? 0);
  }
  return { span, settled: true, polluted, effective, raw, gap: raw - effective };
}

export interface TransferAggregate {
  readonly span: number;
  readonly n: number;
  readonly effective: number | null;
  readonly raw: number | null;
  readonly withheldReason: string | null;
}

export function transferAggregate(
  history: ManagerHistory, span: number,
): TransferAggregate {
  const clean = history.transfers
    .map((t) => windowFor(t, span))
    .filter((w) => w.settled && !w.polluted);

  if (clean.length < MINIMUM_CLEAN_WINDOWS) {
    return {
      span, n: clean.length, effective: null, raw: null,
      withheldReason:
        `${clean.length} clean ${clean.length === 1 ? "window" : "windows"} at this span; ` +
        `a rate needs ${MINIMUM_CLEAN_WINDOWS} before it says more than the last transfer did`,
    };
  }
  return {
    span,
    n: clean.length,
    effective: clean.reduce((sum, w) => sum + (w.effective ?? 0), 0),
    raw: clean.reduce((sum, w) => sum + (w.raw ?? 0), 0),
    withheldReason: null,
  };
}

export interface SeasonTotals {
  readonly benchPoints: number;
  readonly vsAverage: number | null;
  readonly hitSpend: number;
  readonly autoSubRescue: number;
  readonly captainPoints: number;
  /** What the armband would have returned on the best of the fifteen. */
  readonly bestCaptainPoints: number;
  readonly captaincyCost: number;
}

export function seasonTotals(history: ManagerHistory): SeasonTotals {
  let benchPoints = 0;
  let hitSpend = 0;
  let autoSubRescue = 0;
  let captainPoints = 0;
  let bestCaptainPoints = 0;
  let mine = 0;
  let field = 0;
  let fieldKnown = true;

  for (const gameweek of history.gameweeks) {
    benchPoints += gameweek.benchPoints;
    hitSpend += gameweek.transferCost;
    for (const sub of gameweek.autoSubs) autoSubRescue += sub.pointsGained;
    mine += gameweek.points;
    if (gameweek.averageEntryScore === null) fieldKnown = false;
    else field += gameweek.averageEntryScore;

    // The armband, against the best of the fifteen in hindsight. Measured at
    // the multiplier actually used, so a triple-captain week is compared with a
    // triple-captain alternative rather than against a doubled one.
    const armband = gameweek.captain?.multiplier ?? 2;
    if (gameweek.captain) captainPoints += gameweek.captain.points * armband;
    const best = gameweek.picks.reduce(
      (most, pick) => Math.max(most, pick.points), Number.NEGATIVE_INFINITY,
    );
    if (Number.isFinite(best)) bestCaptainPoints += best * armband;
  }
  return {
    benchPoints, hitSpend, autoSubRescue, captainPoints, bestCaptainPoints,
    captaincyCost: bestCaptainPoints - captainPoints,
    vsAverage: fieldKnown ? mine - field : null,
  };
}

export interface Basket {
  readonly event: number;
  readonly transfers: number;
  readonly hit: number;
  readonly effective: number | null;
  readonly settled: boolean;
}

/**
 * One gameweek's transfers taken together, against that gameweek's total hit.
 *
 * Pairing each `element_in` with each `element_out` is a fiction FPL's list
 * implies but does not mean: with three transfers the pairing is arbitrary, and
 * so is any per-transfer share of the hit. With one transfer this equals that
 * transfer; from three onwards it is the only honest number.
 */
export function basketFor(history: ManagerHistory, event: number): Basket {
  const made = history.transfers.filter((t) => t.event === event);
  const windows = made.map((t) => windowFor(t, 1));
  const settled = windows.length > 0 && windows.every((w) => w.settled);
  const gameweek = history.gameweeks.find((g) => g.event === event);
  return {
    event,
    transfers: made.length,
    hit: gameweek?.transferCost ?? 0,
    settled,
    effective: settled ? windows.reduce((s, w) => s + (w.effective ?? 0), 0) : null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run lib/data/manager-history.test.ts`
Expected: PASS (12 passed)

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/data/manager-history.ts frontend/lib/data/manager-history.test.ts
git commit -m "Windows, pollution, and the rate that stays withheld

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The `/review` surface

**Files:**
- Create: `frontend/components/review/ManagerHistory.tsx`
- Modify: `frontend/app/review/page.tsx` (mount below `DecisionReview`)
- Test: `frontend/components/review/ManagerHistory.test.tsx`

**Interfaces:**
- Consumes: `useArtifact` keyed `managerHistory`; Task 6's `seasonTotals`, `windowFor`, `transferAggregate`, `SPANS`.
- Produces: `export default function ManagerHistory()`

- [ ] **Step 1: Write the failing test**

```tsx
/**
 * The outcome ledger on /review.
 *
 * It sits under DecisionReview, which judges FORESEEABILITY against the sealed
 * forecast and is careful never to manufacture blame. This judges OUTCOME. The
 * two must not read as one verdict, so nothing here is coloured good or bad —
 * a -3 is a number, not a reproach.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const HISTORY = {
  generatedAt: "2026-09-09T00:00:00+00:00", entryId: 20945, settledThrough: 3,
  gameweeks: [
    { event: 1, points: 44, grossPoints: 44, transferCost: 0, transfersMade: 0, benchPoints: 2, averageEntryScore: 50, highestScore: 131, rank: 1, overallRank: 6124832, value: 1000, bank: 0, chip: null, captain: null, autoSubs: [{ elementIn: 1, elementOut: 2, pointsGained: 4 }], picks: [] },
    { event: 2, points: 109, grossPoints: 109, transferCost: 0, transfersMade: 0, benchPoints: 13, averageEntryScore: 81, highestScore: 161, rank: 1, overallRank: 1667220, value: 1001, bank: 0, chip: null, captain: null, autoSubs: [], picks: [] },
    { event: 3, points: 38, grossPoints: 38, transferCost: 0, transfersMade: 1, benchPoints: 12, averageEntryScore: 51, highestScore: 119, rank: 1, overallRank: 3427838, value: 999, bank: 0, chip: null, captain: null, autoSubs: [], picks: [] },
  ],
  transfers: [{
    event: 3, time: null, elementIn: 445, elementInCost: 50, elementOut: 418, elementOutCost: 50,
    inPointsByGw: new Map([[3, -1]]), outPointsByGw: new Map([[3, 2]]),
    inMultiplierByGw: new Map([[3, 1]]),
  }],
};

/**
 * `proven` reads the value off a private Symbol key, so a hand-built artifact
 * cannot carry one. Mocking `proven` is how every other suite in this repo
 * mounts an artifact consumer — see `app/players/page.test.tsx`.
 */
async function mount(value: unknown = HISTORY) {
  vi.resetModules();
  vi.doMock("@/lib/data/useArtifact", () => ({
    useArtifact: () => ({
      artifact: {
        state: value === null ? "absent" : "ok",
        provenance: { path: "fpl/manager_history.json", source: "local", producedAt: null, ageMs: null },
        reason: value === null ? "nothing is published at this path" : null,
        value,
      },
    }),
  }));
  vi.doMock("@/lib/data/artifact", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/data/artifact")>();
    return { ...actual, proven: (a: { value?: unknown }) => a?.value ?? null };
  });
  const { default: ManagerHistory } = await import("@/components/review/ManagerHistory");
  return render(<ManagerHistory />);
}

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/data/useArtifact");
  vi.doUnmock("@/lib/data/artifact");
});

describe("ManagerHistory", () => {
  it("leads with the largest cost, which is the bench", async () => {
    await mount();
    expect(screen.getByTestId("bench-waste").textContent).toContain("27");
  });

  it("reports the margin over the field", async () => {
    await mount();
    expect(screen.getByTestId("vs-average").textContent).toContain("9");
  });

  it("shows the one transfer with its settled window", async () => {
    await mount();
    const row = screen.getByTestId("transfer-row-3");
    expect(row.textContent).toContain("-3");
  });

  it("says a window is not yet measurable rather than showing zero", async () => {
    await mount();
    const row = screen.getByTestId("transfer-row-3");
    // Spans 2, 3 and 4 cannot have settled with settledThrough = 3.
    expect(row.textContent).not.toMatch(/\b0\b/);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("withholds the season rate and states why", async () => {
    await mount();
    expect(screen.getByTestId("transfer-aggregate").textContent)
      .toMatch(/clean window/i);
  });

  it("prices the armband against the best of the fifteen", async () => {
    await mount();
    expect(screen.getByTestId("captaincy-cost")).toBeInTheDocument();
  });

  it("states its own absence in one line when nothing is published", async () => {
    await mount(null);
    // StateCard composes its own sentence around `what`; assert on the subject
    // rather than on copy this component does not own.
    expect(screen.getByText(/manager history/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run components/review/ManagerHistory.test.tsx`
Expected: FAIL — cannot resolve `@/components/review/ManagerHistory`

- [ ] **Step 3: Write the implementation**

Create `frontend/components/review/ManagerHistory.tsx`:

```tsx
"use client";

/**
 * What your season has actually cost you.
 *
 * ## Why nothing here is coloured
 *
 * `DecisionReview` sits directly above this and judges FORESEEABILITY against
 * the sealed forecast — it goes to real lengths not to manufacture blame, which
 * is why `indistinguishable` exists as a third verdict. This judges OUTCOME.
 * Rendered alike, the two collapse, and "was the call wrong or merely unlucky"
 * — the question that page was built to keep open — silently closes. So every
 * number here is `S.ink`: a −3 is a fact, not a reproach.
 *
 * ## Why the bench is first
 *
 * Measured 2026-09-09: the bench had cost 27 points across three gameweeks and
 * the single transfer had cost 3. Ordering these by interest rather than by
 * magnitude would lead with the −3 and leave the 27 unmentioned.
 */
import { useArtifact } from "@/lib/data/useArtifact";
import { Section, StateCard, ProvenanceStrip } from "@/components/data/Artifact";
import { proven } from "@/lib/data/artifact";
import { REGISTRY } from "@/lib/data/narrow";
import { SIGNAL as S } from "@/lib/margin/tokens";
import {
  SPANS, basketFor, seasonTotals, transferAggregate, windowFor,
} from "@/lib/data/manager-history";

/** An em-dash, never a zero: "not yet played" is not "scored nothing". */
const NOT_YET = "—";

function Figure(
  { label, value, note, testId }:
  { label: string; value: string; note?: string; testId?: string },
) {
  return (
    <div data-testid={testId}>
      <div
        className="text-[11px] font-semibold uppercase"
        style={{ color: "var(--text-3)", letterSpacing: ".15em" }}
      >
        {label}
      </div>
      <div className="font-mono text-xl mt-1" style={{ color: "var(--text-1)" }}>
        {value}
      </div>
      {note ? (
        <div className="text-[11px] mt-1" style={{ color: "var(--text-3)" }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export default function ManagerHistory() {
  const { artifact } = useArtifact(REGISTRY.managerHistory);
  const history = proven(artifact);

  if (!history) {
    return (
      <StateCard
        of={artifact}
        weight="line"
        what="your manager history — each gameweek, and what each transfer returned"
      />
    );
  }

  const totals = seasonTotals(history);
  const weeks = [...history.gameweeks].sort((a, b) => b.event - a.event);
  const moves = [...history.transfers].sort((a, b) => b.event - a.event);

  return (
    <Section
      title="What it cost"
      subtitle="What happened, not whether it was right — the judgement lives above this"
      aside={<ProvenanceStrip of={artifact} />}
    >
      <div className="glass-panel rounded-none p-4 grid gap-4 sm:grid-cols-4">
        <Figure
          testId="bench-waste"
          label="Left on the bench"
          value={String(totals.benchPoints)}
          note="the largest number on this page"
        />
        <Figure
          testId="vs-average"
          label="Against the field"
          value={totals.vsAverage === null ? NOT_YET : signed(totals.vsAverage)}
        />
        <Figure
          testId="captaincy-cost"
          label="Armband, vs your best"
          value={String(totals.captaincyCost)}
          note={`${totals.captainPoints} of a possible ${totals.bestCaptainPoints}`}
        />
        <Figure
          testId="hit-spend"
          label="Spent on hits"
          value={String(totals.hitSpend)}
          note={`auto-subs recovered ${totals.autoSubRescue}`}
        />
      </div>

      <table className="w-full mt-6 font-mono text-[11.5px]" style={{ color: S.ink }}>
        <thead>
          <tr style={{ color: S.ink3 }}>
            <th className="text-left">GW</th>
            <th className="text-right">Pts</th>
            <th className="text-right">Avg</th>
            <th className="text-right">Bench</th>
            <th className="text-right">Overall</th>
            <th className="text-right">Value</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.event} data-testid={`manager-week-${week.event}`}>
              <td className="text-left">{week.event}</td>
              <td className="text-right">{week.points}</td>
              <td className="text-right">
                {week.averageEntryScore ?? NOT_YET}
              </td>
              <td className="text-right">{week.benchPoints}</td>
              <td className="text-right">
                {week.overallRank === null
                  ? NOT_YET
                  : week.overallRank.toLocaleString()}
              </td>
              <td className="text-right">
                {week.value === null ? NOT_YET : (week.value / 10).toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-8 text-[11px] font-semibold uppercase"
          style={{ color: "var(--text-3)", letterSpacing: ".15em" }}>
        Transfers
      </h3>

      <table className="w-full mt-2 font-mono text-[11.5px]" style={{ color: S.ink }}>
        <thead>
          <tr style={{ color: S.ink3 }}>
            <th className="text-left">GW</th>
            <th className="text-left">In / out</th>
            {SPANS.map((span) => (
              <th key={span} className="text-right">
                {span === 1 ? "same" : `+${span - 1}`}
              </th>
            ))}
            <th className="text-right">raw</th>
          </tr>
        </thead>
        <tbody>
          {moves.map((move) => {
            const windows = SPANS.map((span) => windowFor(move, span));
            const same = windows[0];
            return (
              <tr key={`${move.event}-${move.elementIn}`}
                  data-testid={`transfer-row-${move.event}`}>
                <td className="text-left">{move.event}</td>
                <td className="text-left">
                  {move.elementIn} / {move.elementOut}
                </td>
                {windows.map((window) => (
                  <td
                    key={window.span}
                    className="text-right"
                    // Polluted is de-emphasised, never recoloured: it is a
                    // caveat about the counterfactual, not a bad outcome.
                    style={{ color: window.polluted ? S.ink3 : S.ink }}
                    title={window.polluted
                      ? "polluted — the player left the squad inside this window"
                      : undefined}
                  >
                    {window.effective === null ? NOT_YET : signed(window.effective)}
                    {window.polluted ? "*" : ""}
                  </td>
                ))}
                <td className="text-right" style={{ color: S.ink3 }}>
                  {same.raw === null ? NOT_YET : signed(same.raw)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {moves.length > 0 ? (
        <p className="text-[11px] mt-2" style={{ color: S.ink3 }}>
          {(() => {
            const basket = basketFor(history, moves[0].event);
            return basket.transfers > 1
              ? `GW${basket.event} as a basket: ${
                  basket.effective === null ? NOT_YET : signed(basket.effective)
                } across ${basket.transfers} transfers against a ${basket.hit}-point hit. ` +
                "Pairing each buy with a particular sale is arbitrary once there is more than one."
              : `GW${basket.event}: one transfer, ${basket.hit} points of hit.`;
          })()}
        </p>
      ) : null}

      <p className="text-[11px] mt-3" data-testid="transfer-aggregate"
         style={{ color: S.ink3 }}>
        {SPANS.map((span) => {
          const aggregate = transferAggregate(history, span);
          const label = span === 1 ? "same gameweek" : `over ${span} gameweeks`;
          return aggregate.withheldReason === null
            ? `${label}: ${signed(aggregate.effective ?? 0)} across ${aggregate.n}. `
            : `${label}: ${aggregate.withheldReason}. `;
        })}
      </p>
    </Section>
  );
}
```

Read `components/review/DecisionReview.tsx` first and match its spacing and
class idiom; the `Figure`, `Section`, `StateCard` and `ProvenanceStrip` usage
above is copied from it deliberately so the two halves of `/review` look like
one page.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run components/review/ManagerHistory.test.tsx`
Expected: PASS (7 passed)

- [ ] **Step 5: Mount it on `/review`**

In `frontend/app/review/page.tsx`, import `ManagerHistory` and render it after `<DecisionReview />`, separated by a horizontal rule and its own `<h2>`, so the foreseeability verdict and the outcome accounting cannot be read as one judgement.

- [ ] **Step 6: Run the full gate**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npx next lint && npx next build`
Expected: all pass; lint unchanged at 5 deliberate `no-console` warnings.

- [ ] **Step 7: Commit**

```bash
git add frontend/components/review/ManagerHistory.tsx frontend/components/review/ManagerHistory.test.tsx frontend/app/review/page.tsx
git commit -m "What the season cost, as accounting rather than as a verdict

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification after all tasks

- [ ] `python -m pipeline.fpl.manager_history --verbose --force` succeeds and the identity holds for every settled gameweek.
- [ ] `python -m pytest pipeline/tests/test_fpl_api_event_live.py pipeline/tests/test_manager_history.py pipeline/tests/test_manager_history_transfers.py pipeline/tests/test_manager_history_build.py -v` — 15 passed.
- [ ] `cd frontend && npx vitest run` — full suite green: 1266 before, 23 added, **1289**.
- [ ] `/review` renders: bench waste **27**, vs average **+9**, one transfer row at GW3 showing **−3** same-gameweek, em-dashes at spans 2/3/4, and the withheld-aggregate sentence.
- [ ] Push, confirm Vercel deploy Ready, `/review` returns 200 and the browser console is clean.
- [ ] After the GW4 deadline (2026-09-12) and settlement, re-run and confirm the +2 window populates for the GW3 transfer — the first real test that windows accrue.
