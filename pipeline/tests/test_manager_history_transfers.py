"""
The transfer ledger, and the difference between absent and null.

Absent from a by-gameweek map = that gameweek has not settled.
Present with multiplier null = it settled, but the player had left the squad.
Collapsing the two makes "not yet played" read as "scored nothing", which are
opposite conclusions for the reader.
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
        points_by_gw={3: {1: -1, 2: 2}, 4: {1: 5, 2: 1},
                      5: {1: 0, 2: 0, 3: 7, 4: 1}},
        picks_by_gw={3: {1: 1}, 4: {1: 1}, 5: {3: 1}},
    )
    assert [r["event"] for r in rows] == [3, 5]


def test_a_window_only_covers_gameweeks_that_settled():
    rows = mh.build_transfer_rows(
        transfers=[{"event": 3, "time": "t", "element_in": 1,
                    "element_in_cost": 50, "element_out": 2,
                    "element_out_cost": 50, "entry": 1}],
        settled=[3],
        points_by_gw={3: {1: -1, 2: 2}},
        picks_by_gw={3: {1: 1}},
    )
    row = rows[0]
    assert row["in_points_by_gw"] == {"3": -1}
    assert row["out_points_by_gw"] == {"3": 2}
    assert row["in_multiplier_by_gw"] == {"3": 1}
    assert "4" not in row["in_points_by_gw"], "GW4 has not settled; must be absent"


def test_a_player_who_left_the_squad_is_null_not_missing():
    rows = mh.build_transfer_rows(
        transfers=[{"event": 3, "time": "t", "element_in": 1,
                    "element_in_cost": 50, "element_out": 2,
                    "element_out_cost": 50, "entry": 1}],
        settled=[3, 4],
        points_by_gw={3: {1: 6, 2: 2}, 4: {1: 12, 2: 1}},
        picks_by_gw={3: {1: 1}, 4: {}},        # sold before GW4
    )
    row = rows[0]
    assert row["in_multiplier_by_gw"] == {"3": 1, "4": None}
    # His points are still recorded — the frontend needs them to price what the
    # sale cost — but the null multiplier marks GW4 onwards as polluted.
    assert row["in_points_by_gw"]["4"] == 12


def test_gameweeks_before_the_transfer_are_not_attributed_to_it():
    rows = mh.build_transfer_rows(
        transfers=[{"event": 3, "time": "t", "element_in": 1,
                    "element_in_cost": 50, "element_out": 2,
                    "element_out_cost": 50, "entry": 1}],
        settled=[1, 2, 3],
        points_by_gw={1: {1: 9, 2: 9}, 2: {1: 9, 2: 9}, 3: {1: 1, 2: 1}},
        picks_by_gw={1: {}, 2: {}, 3: {1: 1}},
    )
    assert list(rows[0]["in_points_by_gw"].keys()) == ["3"]


def test_the_transfer_keeps_the_prices_it_was_made_at():
    rows = mh.build_transfer_rows(
        transfers=[{"event": 3, "time": "t", "element_in": 1,
                    "element_in_cost": 51, "element_out": 2,
                    "element_out_cost": 49, "entry": 1}],
        settled=[3],
        points_by_gw={3: {1: 1, 2: 1}},
        picks_by_gw={3: {1: 1}},
    )
    assert rows[0]["element_in_cost"] == 51
    assert rows[0]["element_out_cost"] == 49
