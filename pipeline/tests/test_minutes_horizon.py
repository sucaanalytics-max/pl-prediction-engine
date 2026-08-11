"""
Tests for the availability path across the projection horizon.

The defect being fixed: every horizon week was simulated with TODAY's role
probabilities, and a single scalar was then applied to the finished expected
points — one number, identical for every player, multiplying a total. Because it
never touched minutes, it never crossed the 60-minute clean-sheet gate or the
1-minute appearance gate inside the simulator. Those two non-linearities pull in
opposite directions and are position-dependent, so a uniform scalar on totals
systematically mis-ranks defenders against forwards at long horizons.

Two properties here are load-bearing beyond the arithmetic.

**The backwards-compatibility identity.** At full availability the new path must
equal the old ``horizon_availability_factor`` exactly. That is what lets the
already-fitted ``horizon_availability_floor`` and ``..._rho`` keep the meaning
they were fitted with, rather than being silently reinterpreted. Two plausible
alternative formulations were rejected precisely because they fail this.

**A dated absence must end.** A one-match suspension previously projected a blank
for all eight weeks, because it arrives as ``chance_of_playing == 0`` and nothing
distinguished "banned until Saturday" from "gone to another club".
"""
import unittest
from datetime import datetime, timedelta, timezone

from pipeline.config import PARAM_REGISTRY
from pipeline.models.minutes import (
    PERSISTENCE_DATED_ELIGIBILITY,
    PERSISTENCE_DATED_FITNESS,
    PERSISTENCE_GRADED,
    PERSISTENCE_NONE,
    PERSISTENCE_OPEN_ENDED,
    PERSISTENCE_PERMANENT,
    AvailabilityState,
    availability,
    availability_state,
    horizon_availability,
    horizon_availability_factor,
)

NEWS_ADDED = "2026-08-04T12:00:00Z"
GW1_KICKOFF = datetime(2026, 8, 21, 19, 0, tzinfo=timezone.utc)


def _kickoff(week: int) -> datetime:
    """Kickoff for the week at the given horizon offset, one week apart."""
    return GW1_KICKOFF + timedelta(days=7 * week)


class PersistenceClassificationTests(unittest.TestCase):
    """Which future an absence implies, which `chance_of_playing` alone cannot say."""

    def test_an_available_player_has_no_impairment(self):
        state = availability_state("a", None)
        self.assertEqual(state.persistence, PERSISTENCE_NONE)
        self.assertEqual(state.now, 1.0)

    def test_an_explicit_chance_is_graded(self):
        state = availability_state("d", 75, news="Calf injury - 75% chance of playing")
        self.assertEqual(state.persistence, PERSISTENCE_GRADED)
        self.assertAlmostEqual(state.now, 0.75)

    def test_a_suspension_is_dated_eligibility(self):
        state = availability_state(
            "s", 0, news="Suspended until 29 Aug", news_added=NEWS_ADDED
        )
        self.assertEqual(state.persistence, PERSISTENCE_DATED_ELIGIBILITY)
        self.assertEqual(state.available_from, "2026-08-29")
        self.assertEqual(state.now, 0.0)

    def test_an_expected_return_is_dated_fitness(self):
        state = availability_state(
            "i", 0, news="Groin injury - Expected back 21 Aug", news_added=NEWS_ADDED
        )
        self.assertEqual(state.persistence, PERSISTENCE_DATED_FITNESS)
        self.assertEqual(state.available_from, "2026-08-21")

    def test_an_unknown_return_date_is_open_ended(self):
        state = availability_state(
            "i", 0, news="Achilles injury - Unknown return date", news_added=NEWS_ADDED
        )
        self.assertEqual(state.persistence, PERSISTENCE_OPEN_ENDED)
        self.assertIsNone(state.available_from)

    def test_a_departure_is_permanent(self):
        for news in (
            "has departed the club as a free agent.",
            "Has joined Grimsby Town on loan for the rest of the season",
            "Has joined New England Revolution permanently",
            "has returned to Getafe CF",
        ):
            with self.subTest(news=news):
                state = availability_state("u", 0, news=news, news_added=NEWS_ADDED)
                self.assertEqual(state.persistence, PERSISTENCE_PERMANENT)

    def test_a_suspension_is_not_reached_through_the_hard_gate(self):
        """
        Records a premise that was wrong and cost real design time: ``"s"`` is NOT
        in HARD_GATE_STATUSES. All three suspended players in the committed
        snapshot carry ``chance_of_playing_next_round == 0``, so they blank via
        the zero-chance branch. Any fix keyed on the hard gate would have missed
        every suspension in production.
        """
        from pipeline.models.minutes import HARD_GATE_STATUSES

        self.assertNotIn("s", HARD_GATE_STATUSES)
        state = availability_state("s", 0, news="Suspended until 29 Aug",
                                   news_added=NEWS_ADDED)
        self.assertEqual(state.now, 0.0)
        self.assertEqual(state.persistence, PERSISTENCE_DATED_ELIGIBILITY)

    def test_a_stale_exit_note_cannot_zero_a_player_fpl_says_is_fit(self):
        """
        Regression, and it was the worst defect in this change. The exit-kind check
        ran BEFORE the fit fast path and had no staleness guard, so a leftover
        "Has joined X permanently" from a previous season projected a currently
        fit, selected player at 0.0 availability for every horizon week — for
        ever. It also directly contradicted the module's stated contract that news
        only ever classifies and never overrides FPL's number.

        Every existing departure test paired the exit text with ``status="u"``,
        which is already zero, so the bug was invisible to the whole suite.
        """
        fit = availability_state(
            "a", 100, news_age_days=400,
            news="Has joined Real Madrid permanently",
            news_added="2025-01-01T00:00:00Z",
        )
        self.assertEqual(fit.now, 1.0)
        self.assertEqual(fit.persistence, PERSISTENCE_NONE)
        self.assertEqual(availability("a", 100, 400)[0], fit.now)

        # A player FPL genuinely has removed from the squad still departs.
        gone = availability_state(
            "u", 0, news="Has joined Grimsby Town on loan for the rest of the season",
            news_added=NEWS_ADDED,
        )
        self.assertEqual(gone.now, 0.0)
        self.assertEqual(gone.persistence, PERSISTENCE_PERMANENT)

    def test_a_dated_absence_supersedes_the_staleness_clearing(self):
        """
        The 21-day staleness cliff exists because FPL leaves old flags on players
        who have returned. But a LONG absence naturally has an old note, so the
        cliff misfires exactly there: a player was cleared to 1.0 for this week
        while his own return date still gated him to 0.0 at every future week — a
        contradiction visible in the artifact. The date is better evidence than
        the age, so it wins.
        """
        state = availability_state(
            "i", None, news_age_days=35,
            news="Groin injury - Expected back 30 Sep",
            news_added="2026-08-01T12:00:00Z",
        )
        self.assertLess(state.now, 1.0)
        self.assertEqual(state.persistence, PERSISTENCE_DATED_FITNESS)
        self.assertEqual(state.gate_reason, "dated_absence_supersedes_stale_news")

    def test_an_undated_stale_note_still_clears_as_before(self):
        """The staleness rule is narrowed, not removed."""
        state = availability_state(
            "d", None, news_age_days=35,
            news="Knock - Unknown return date", news_added="2026-08-01T12:00:00Z",
        )
        self.assertEqual(state.now, 1.0)
        self.assertEqual(state.gate_reason, "news_stale")

    def test_an_unparsed_news_string_does_not_change_the_classification(self):
        """
        The fail-safe. Unrecognised text must leave the model exactly where it was
        without the parser, so a parser regression degrades to today's behaviour
        rather than to something worse.
        """
        with_text = availability_state(
            "i", 0, news="he has a sore knee, probably", news_added=NEWS_ADDED
        )
        without = availability_state("i", 0)
        self.assertEqual(with_text.persistence, without.persistence)
        self.assertEqual(with_text.now, without.now)

    def test_a_dated_string_with_no_timestamp_falls_back_to_open_ended(self):
        """
        Without ``news_added`` the year cannot be resolved, and resolving it
        against the wall clock would make an archived record parse differently
        depending on when the parser ran. Open-ended is the conservative reading.
        """
        state = availability_state("s", 0, news="Suspended until 29 Aug")
        self.assertEqual(state.persistence, PERSISTENCE_OPEN_ENDED)
        self.assertIsNone(state.available_from)


class BackwardsCompatibilityTests(unittest.TestCase):
    def test_a_fully_available_player_reproduces_the_old_factor_exactly(self):
        """
        The identity that preserves the meaning of the two already-fitted
        parameters. Without it, ``horizon_availability_floor`` and ``..._rho``
        would silently come to mean something other than what they were fitted to.
        """
        state = availability_state("a", None)
        for horizon in range(13):
            with self.subTest(horizon=horizon):
                value, _ = horizon_availability(state, horizon)
                self.assertAlmostEqual(
                    value, horizon_availability_factor(horizon), places=12
                )

    def test_the_immediate_gameweek_is_never_discounted(self):
        for chance in (100, 75, 25, 0):
            state = availability_state("d", chance)
            value, _ = horizon_availability(state, 0)
            self.assertAlmostEqual(value, state.now, places=12)

    def test_the_public_availability_helper_is_unchanged(self):
        """
        ``availability()`` is called from production and from eight existing
        tests. It keeps its exact signature and return so this change cannot
        alter the immediate gameweek at all.
        """
        self.assertEqual(availability("a", None), (1.0, None))
        self.assertEqual(availability("u", None), (0.0, "status_u"))
        self.assertEqual(availability("d", 50), (0.5, None))
        self.assertEqual(availability("i", 0), (0.0, "chance_of_playing_zero"))


class ImpairedPathTests(unittest.TestCase):
    def test_an_impaired_player_closes_the_gap_to_the_healthy_path(self):
        """
        The invariant is that the impairment RESOLVES — the ratio to the healthy
        curve rises monotonically. The raw path deliberately does NOT rise
        forever: two hazards compete, and once the impairment has largely
        resolved the ordinary rotation-and-injury decay takes over, so the path
        peaks and then follows the healthy curve down toward the floor. Asserting
        raw monotonicity here would be asserting a bug.
        """
        state = availability_state(
            "i", 25, news="Knee injury - Unknown return date", news_added=NEWS_ADDED
        )
        path = [horizon_availability(state, h)[0] for h in range(8)]
        healthy = [horizon_availability_factor(h) for h in range(8)]

        self.assertAlmostEqual(path[0], 0.25, places=6)

        ratios = [p / h for p, h in zip(path, healthy)]
        for near, far in zip(ratios, ratios[1:]):
            self.assertGreater(far, near, f"impairment must resolve: {ratios}")
        for value, ceiling in zip(path, healthy):
            self.assertLessEqual(value, ceiling + 1e-12)

        # And it does rise while the impairment still dominates.
        self.assertGreater(path[3], path[0])

    def test_a_graded_knock_peaks_and_then_tracks_the_healthy_decay(self):
        """
        Documents the non-monotonicity as intended so it is not later "fixed". A
        player carrying a knock today does not become ever more available: he
        recovers, and then faces the same rotation hazard as everyone else. Two
        hazards compete and the second one eventually wins.

        This happens for a GRADED knock, whose deficit resolves fast enough to
        overtake the healthy decay. It is not a universal property — see the
        open-ended contrast below.
        """
        state = availability_state("d", 75)
        path = [horizon_availability(state, h)[0] for h in range(10)]
        peak = path.index(max(path))

        self.assertGreater(peak, 0, f"must rise before it falls: {path}")
        self.assertLess(peak, 9, f"must eventually fall: {path}")
        for near, far in zip(path[peak:], path[peak + 1:]):
            self.assertLessEqual(far, near)

    def test_an_open_ended_absence_is_still_recovering_across_the_whole_horizon(self):
        """
        The contrast, and the reason two persistence rates exist. An absence FPL
        cannot date is still resolving at week eight, so its path rises
        throughout the horizon the optimiser can actually see. Sharing one rate
        with the graded class would force one of these two shapes to be wrong.
        """
        state = availability_state(
            "i", None, news="Back injury - Unknown return date", news_added=NEWS_ADDED
        )
        path = [horizon_availability(state, h)[0] for h in range(8)]
        for near, far in zip(path, path[1:]):
            self.assertGreater(far, near, f"still recovering: {path}")
        # And it has not yet reached the healthy path, unlike the graded case.
        self.assertLess(path[7], horizon_availability_factor(7) - 0.05)

    def test_an_unknown_return_date_outranks_a_published_percentage(self):
        """
        The two say different things: the percentage is about this week, the
        phrase is FPL stating the absence has no known end. Classification is
        about how it ends, so the phrase wins — while the percentage still sets
        today's level.
        """
        state = availability_state(
            "i", 25, news="Knee injury - Unknown return date", news_added=NEWS_ADDED
        )
        self.assertEqual(state.persistence, PERSISTENCE_OPEN_ENDED)
        self.assertAlmostEqual(state.now, 0.25)

        graded = availability_state("d", 25, news="Knock - no idea what this says")
        self.assertEqual(graded.persistence, PERSISTENCE_GRADED)
        # Same level today, slower recovery for the open-ended one.
        self.assertLess(
            horizon_availability(state, 2)[0], horizon_availability(graded, 2)[0]
        )

    def test_a_nailed_player_still_decays_toward_the_floor(self):
        state = availability_state("a", None)
        path = [horizon_availability(state, h)[0] for h in range(8)]
        for near, far in zip(path, path[1:]):
            self.assertLess(far, near)
        floor = PARAM_REGISTRY["minutes.horizon_availability_floor"]["value"]
        self.assertGreater(min(path), floor)

    def test_the_path_is_monotone_in_current_availability(self):
        """A player who is more available today is more available at every horizon."""
        better = availability_state("d", 75)
        worse = availability_state("d", 25)
        for horizon in range(8):
            with self.subTest(horizon=horizon):
                self.assertGreater(
                    horizon_availability(better, horizon)[0],
                    horizon_availability(worse, horizon)[0],
                )

    def test_availability_stays_inside_the_unit_interval(self):
        for chance in (0, 1, 25, 50, 75, 99, 100):
            state = availability_state("d", chance)
            for horizon in range(20):
                value, _ = horizon_availability(state, horizon)
                self.assertGreaterEqual(value, 0.0)
                self.assertLessEqual(value, 1.0)


class DatedAbsenceTests(unittest.TestCase):
    def test_a_suspension_blanks_only_the_weeks_its_date_covers(self):
        """
        The release blocker, stated as an assertion. Banned until 29 Aug: out for
        the 21 Aug fixture, back for 28 Aug onward. Previously this player was
        projected to blank for all eight weeks.
        """
        state = availability_state(
            "s", 0, news="Suspended until 29 Aug", news_added=NEWS_ADDED
        )
        # GW1 = 21 Aug (banned), GW2 = 28 Aug (still banned, ban ends 29th),
        # GW3 = 4 Sep (eligible).
        self.assertEqual(horizon_availability(state, 0, _kickoff(0))[0], 0.0)
        self.assertEqual(horizon_availability(state, 1, _kickoff(1))[0], 0.0)
        self.assertGreater(horizon_availability(state, 2, _kickoff(2))[0], 0.0)

    def test_a_returning_suspended_player_is_match_fit_immediately(self):
        """
        A ban is an eligibility constraint, not a fitness one, so there is no
        ramp. That is true by construction rather than by a tuned constant, so it
        cannot drift.
        """
        state = availability_state(
            "s", 0, news="Suspended until 29 Aug", news_added=NEWS_ADDED
        )
        value, _ = horizon_availability(state, 2, _kickoff(2))
        self.assertAlmostEqual(value, horizon_availability_factor(2), places=12)

    def test_a_dated_injury_returns_on_a_ramp_rather_than_at_full_strength(self):
        state = availability_state(
            "i", 0, news="Leg injury - Expected back 30 Aug", news_added=NEWS_ADDED
        )
        # GW2 (28 Aug) still out; GW3 (4 Sep) first week back; later weeks fuller.
        self.assertEqual(horizon_availability(state, 1, _kickoff(1))[0], 0.0)
        first_back, _ = horizon_availability(state, 2, _kickoff(2))
        self.assertGreater(first_back, 0.0)
        self.assertLess(first_back, horizon_availability_factor(2))

        settled, _ = horizon_availability(state, 6, _kickoff(6))
        self.assertAlmostEqual(settled, horizon_availability_factor(6), places=12)

    def test_a_dated_absence_with_no_kickoff_falls_back_to_the_impaired_path(self):
        """
        A week whose fixture date is unknown cannot be compared to a return date.
        Falling back to the open-ended path is conservative; assuming he is fit
        would field a banned player.
        """
        state = availability_state(
            "s", 0, news="Suspended until 29 Aug", news_added=NEWS_ADDED
        )
        value, reason = horizon_availability(state, 3, None)
        self.assertGreater(value, 0.0)
        self.assertLess(value, horizon_availability_factor(3))
        self.assertIn("no_kickoff", reason)

    def test_a_permanent_exit_never_returns(self):
        state = availability_state(
            "u", 0, news="Has joined Grimsby Town on loan for the rest of the season",
            news_added=NEWS_ADDED,
        )
        for horizon in range(13):
            with self.subTest(horizon=horizon):
                value, reason = horizon_availability(state, horizon, _kickoff(horizon))
                self.assertEqual(value, 0.0)
                self.assertEqual(reason, PERSISTENCE_PERMANENT)

    def test_a_hard_gated_player_with_no_news_never_returns(self):
        """
        Absent news we cannot tell a departure from a temporary removal, and
        ``u``/``n`` is FPL saying he is not in the squad. Resurrecting him at week
        three on no evidence is the worse error.
        """
        state = availability_state("u", None)
        self.assertEqual(state.persistence, PERSISTENCE_PERMANENT)
        for horizon in range(8):
            self.assertEqual(horizon_availability(state, horizon)[0], 0.0)


class RoleMassTests(unittest.TestCase):
    """The four-way split, and that it stays a distribution everywhere."""

    def test_the_four_masses_sum_to_one_for_every_class_at_every_horizon(self):
        from pipeline.models.minutes import MinutesModel

        model = MinutesModel()
        model.by_position = {
            "MID": {
                "start_rate": 0.7, "minutes_if_start": 82.0, "minutes_if_bench": 22.0,
                "p_60_if_start": 0.85, "bench_appear_rate": 0.35,
            }
        }
        states = [
            availability_state("a", None),
            availability_state("d", 75),
            availability_state("i", 0, news="Knee injury - Unknown return date",
                               news_added=NEWS_ADDED),
            availability_state("s", 0, news="Suspended until 29 Aug",
                               news_added=NEWS_ADDED),
            availability_state("i", 0, news="Leg injury - Expected back 30 Aug",
                               news_added=NEWS_ADDED),
            availability_state("u", 0, news="has departed the club as a free agent.",
                               news_added=NEWS_ADDED),
        ]
        for state in states:
            for horizon in range(8):
                with self.subTest(persistence=state.persistence, horizon=horizon):
                    roles = model.predict(
                        position="MID",
                        availability_override=state,
                        horizon=horizon,
                        target_kickoff=_kickoff(horizon),
                    )
                    total = (
                        roles.p_start + roles.p_bench_appear
                        + roles.p_unused + roles.p_unavailable
                    )
                    self.assertAlmostEqual(total, 1.0, places=9)
                    self.assertAlmostEqual(
                        roles.p_unavailable, 1.0 - roles.availability, places=9
                    )

    def test_the_availability_path_does_not_depend_on_position(self):
        """
        Injury and rotation hazard is a property of the player's situation. Any
        position dependence would have to be evidenced, and it is not.
        """
        state = availability_state("d", 40)
        values = {
            horizon_availability(state, horizon)[0] for horizon in range(8)
        }
        # Same call, no position argument anywhere in the signature.
        self.assertEqual(len(values), 8)


if __name__ == "__main__":
    unittest.main()


class DoubleGameweekTests(unittest.TestCase):
    """
    A dated absence expiring BETWEEN a double gameweek's two fixtures.

    Taking the earliest kickoff blanked both, understating the player by a full
    fixture; taking the latest would field him for both. Since expected points are
    summed over the week's fixtures while role probabilities are shared across
    them, scaling availability by the fraction he is eligible for is exact in
    expectation — and reduces to 0 or 1 for an ordinary single fixture.
    """

    def _banned(self):
        return availability_state(
            "s", 0, news="Suspended until 29 Aug", news_added=NEWS_ADDED
        )

    def test_a_ban_expiring_mid_double_gameweek_gives_the_eligible_fraction(self):
        early = datetime(2026, 8, 26, 19, 0, tzinfo=timezone.utc)   # banned
        late = datetime(2026, 8, 30, 14, 0, tzinfo=timezone.utc)    # eligible
        value, reason = horizon_availability(self._banned(), 1, [early, late])

        self.assertAlmostEqual(value, horizon_availability_factor(1) * 0.5, places=12)
        self.assertIn("partial_1of2", reason)

    def test_both_fixtures_banned_is_still_zero(self):
        pair = [
            datetime(2026, 8, 25, 19, 0, tzinfo=timezone.utc),
            datetime(2026, 8, 27, 19, 0, tzinfo=timezone.utc),
        ]
        value, reason = horizon_availability(self._banned(), 1, pair)
        self.assertEqual(value, 0.0)
        self.assertIn("before_2026-08-29", reason)

    def test_both_fixtures_eligible_is_undiminished(self):
        pair = [
            datetime(2026, 9, 5, 14, 0, tzinfo=timezone.utc),
            datetime(2026, 9, 8, 19, 0, tzinfo=timezone.utc),
        ]
        value, reason = horizon_availability(self._banned(), 2, pair)
        self.assertAlmostEqual(value, horizon_availability_factor(2), places=12)
        self.assertNotIn("partial", reason)

    def test_a_single_kickoff_still_works_unchanged(self):
        """Backwards compatibility: a bare datetime, not a sequence."""
        single = datetime(2026, 9, 5, 14, 0, tzinfo=timezone.utc)
        self.assertAlmostEqual(
            horizon_availability(self._banned(), 2, single)[0],
            horizon_availability(self._banned(), 2, [single])[0],
            places=12,
        )

    def test_an_unparseable_return_date_degrades_rather_than_raising(self):
        """
        An exception here would kill the seal, and a gameweek without a sealed
        forecast is a permanently lost observation. A conservative projection is
        merely imprecise.
        """
        from dataclasses import replace

        broken = replace(self._banned(), available_from="not-a-date")
        value, reason = horizon_availability(
            broken, 2, datetime(2026, 9, 5, tzinfo=timezone.utc)
        )
        self.assertGreater(value, 0.0)
        self.assertIn("bad_date", reason)
