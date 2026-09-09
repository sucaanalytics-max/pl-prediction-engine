"""
Per-gameweek rows, and the identity that makes them trustworthy.

The identity is the whole guard: sum(multiplier x points) - transfer_cost equals
the points FPL credited. Verified exact for GW1-3 of 2026/27 against the live
API on 2026-09-09. It holds because ``picks[].multiplier`` is POST-auto-sub —
GW1 auto-subbed Thomas in for Palestra and Palestra already carried multiplier
0, so no pick with a positive multiplier had zero minutes.

The subtraction term is NOT yet observed: every settled gameweek so far took no
hit. The first hit taken will confirm or refute it, loudly, here.
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

    ``points_gained`` is the substitute's own contribution, NOT a difference
    between the two players — the man subbed out scored nothing, by definition
    of having been subbed out. The identity reconciling here is also the proof
    that ``multiplier`` is post-auto-sub: the substitute already carries 1 and
    the player replaced already carries 0.
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
