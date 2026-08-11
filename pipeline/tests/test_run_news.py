"""
The news poller's gating and reporting.

The window logic is the whole reason a 15-minute cron is defensible, so it is
tested directly rather than trusted. **No published press-conference schedule
exists anywhere**, so the window is derived from the fixture list — which means a
bug here is invisible: the job would run silently, on time, and fetch nothing at
the moment it mattered.

Verified against the real API on 2026-08-06: the window was correctly CLOSED,
because GW1's deadline is further out than 30 hours and no kickoff is within 72.
"""
from __future__ import annotations

import unittest
from pathlib import Path
import tempfile
from datetime import datetime, timedelta, timezone

from pipeline.config import NEWS_WINDOW
from pipeline.learning.run_news import (
    annotations_for, current_gameweek, in_news_window,
)

NOW = datetime(2026, 8, 6, 12, 0, 0, tzinfo=timezone.utc)


def _fixture(hours_from_now: float) -> dict:
    when = NOW + timedelta(hours=hours_from_now)
    return {"kickoff_time": when.isoformat().replace("+00:00", "Z")}


def _event(gameweek: int, hours_from_now: float) -> dict:
    when = NOW + timedelta(hours=hours_from_now)
    return {"id": gameweek, "deadline_time": when.isoformat().replace("+00:00", "Z")}


class WindowTests(unittest.TestCase):
    def test_closed_when_nothing_is_near(self):
        open_now, why = in_news_window([_fixture(200)], [_event(1, 190)], NOW,
                                       NEWS_WINDOW)
        self.assertFalse(open_now)
        self.assertIn("no kickoff or deadline", why)

    def test_open_two_days_before_a_kickoff(self):
        """Pressers are held a day or two out; the fixture list is the only
        schedule we have for them."""
        open_now, why = in_news_window([_fixture(48)], [], NOW, NEWS_WINDOW)
        self.assertTrue(open_now)
        self.assertIn("kickoff in", why)

    def test_closed_once_a_match_has_nearly_started(self):
        """
        Inside the close-off, team news is the line-up itself and the poller has
        nothing left to add — while the fixture is still 'upcoming' for hours.
        """
        open_now, _ = in_news_window([_fixture(0.5)], [], NOW, NEWS_WINDOW)
        self.assertFalse(open_now)

    def test_closed_for_a_kickoff_already_past(self):
        open_now, _ = in_news_window([_fixture(-3)], [], NOW, NEWS_WINDOW)
        self.assertFalse(open_now)

    def test_open_before_a_deadline_even_with_no_near_kickoff(self):
        """
        The two reasons are independent on purpose: late news lands in the hours
        before a deadline, and that is when it matters most, even if the first
        kickoff is further away.
        """
        open_now, why = in_news_window([_fixture(200)], [_event(3, 10)], NOW,
                                       NEWS_WINDOW)
        self.assertTrue(open_now)
        self.assertIn("GW3 deadline", why)

    def test_closed_for_a_deadline_already_passed(self):
        open_now, _ = in_news_window([], [_event(3, -1)], NOW, NEWS_WINDOW)
        self.assertFalse(open_now)

    def test_tolerates_a_fixture_with_no_kickoff_time(self):
        """Unscheduled fixtures carry a null kickoff_time all pre-season."""
        open_now, _ = in_news_window(
            [{"kickoff_time": None}, _fixture(48)], [], NOW, NEWS_WINDOW,
        )
        self.assertTrue(open_now)

    def test_tolerates_an_unparseable_timestamp(self):
        open_now, _ = in_news_window([{"kickoff_time": "soon"}], [], NOW, NEWS_WINDOW)
        self.assertFalse(open_now)

    def test_empty_inputs_are_closed_not_a_crash(self):
        open_now, _ = in_news_window([], [], NOW, NEWS_WINDOW)
        self.assertFalse(open_now)

    def test_the_reason_is_always_populated(self):
        """The run log has to say why it woke up, or a quiet job is inscrutable."""
        for fixtures, events in (([], []), ([_fixture(48)], []),
                                 ([], [_event(1, 10)])):
            _, why = in_news_window(fixtures, events, NOW, NEWS_WINDOW)
            self.assertTrue(why)


class GameweekTests(unittest.TestCase):
    def test_picks_the_next_undeadlined_gameweek(self):
        events = [_event(1, -100), _event(2, 10), _event(3, 200)]
        self.assertEqual(current_gameweek(events, NOW), 2)

    def test_falls_back_to_the_last_event_when_the_season_is_over(self):
        """
        Never 0: a claim filed against gameweek 0 is unfindable, and the store is
        append-only so it cannot be corrected in place.
        """
        events = [_event(37, -200), _event(38, -100)]
        self.assertEqual(current_gameweek(events, NOW), 38)

    def test_defaults_to_one_with_no_events_at_all(self):
        self.assertEqual(current_gameweek([], NOW), 1)

    def test_ignores_events_with_no_deadline(self):
        events = [{"id": 5}, _event(6, 10)]
        self.assertEqual(current_gameweek(events, NOW), 6)


class AnnotationTests(unittest.TestCase):
    def test_a_normal_poll_produces_one_notice(self):
        lines = annotations_for({"status": "polled", "reason": "kickoff in 40.0h"})
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("::notice::"))

    def test_a_persistently_failing_feed_warns(self):
        """
        The distinction that matters: the news layer stopping while the app still
        shows a healthy agent.
        """
        lines = annotations_for({
            "status": "polled", "reason": "x", "escalated_feeds": ["bbc_football"],
        })
        warnings = [line for line in lines if line.startswith("::warning::")]
        self.assertEqual(len(warnings), 1)
        self.assertIn("bbc_football", warnings[0])

    def test_a_broken_matcher_warns(self):
        lines = annotations_for({
            "status": "polled", "reason": "x",
            "suspicious": "all 94 entries yielded nothing",
        })
        self.assertTrue(any("looks broken" in line for line in lines))

    def test_a_failed_poll_warns_rather_than_erroring(self):
        """
        The poller exits 0 on upstream failure by design — the feeds degrade
        gracefully and a red run every fifteen minutes would train the human to
        ignore it. An `::error::` on a green run would be equally confusing.
        """
        lines = annotations_for({"status": "failed", "error": "connection reset"})
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("::warning::"))
        self.assertIn("connection reset", lines[0])

    def test_a_quiet_closed_tick_says_so_without_warning(self):
        lines = annotations_for({"status": "closed", "reason": "nothing near"})
        self.assertEqual(len(lines), 1)
        self.assertNotIn("::warning::", lines[0])


class WindowConfigTests(unittest.TestCase):
    def test_the_window_opens_before_it_closes(self):
        self.assertGreater(
            NEWS_WINDOW["hours_before_kickoff_open"],
            NEWS_WINDOW["hours_before_kickoff_close"],
        )

    def test_the_kickoff_window_is_wide_enough_for_a_presser(self):
        # Pressers are typically 24-48h out. A window narrower than that would
        # miss them entirely while looking like it was working.
        self.assertGreaterEqual(NEWS_WINDOW["hours_before_kickoff_open"], 48)

    def test_the_deadline_window_covers_the_night_before(self):
        self.assertGreaterEqual(NEWS_WINDOW["hours_before_deadline_open"], 24)


if __name__ == "__main__":
    unittest.main()


class PublishedFeedExistsTests(unittest.TestCase):
    """
    The published delta feed must exist after any real poll.

    ## The measured defect

    `publish` writes an empty file rather than no file, and says why in its own
    docstring: absent means "nothing has ever run", empty means "nothing recent
    happened", and the app renders those differently.

    But the call sat inside `if changes:`. With no availability change since the
    poller first ran — the normal state, and exactly what the first live run
    produced — nothing was ever written, and `/now` reported "Nothing has been
    published at this path yet".

    That is the `absent` card, and it understates what we know. The poller ran,
    it read 119 entries across six feeds, and it found no change. That is a
    result, not a silence.
    """

    def _dirs(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "fpl").mkdir(parents=True, exist_ok=True)
        public = root / "public" / "fpl"
        public.mkdir(parents=True, exist_ok=True)
        return root, public

    def test_publish_writes_an_empty_file_rather_than_none(self):
        from pipeline.learning import deltas as deltas_store

        root, public = self._dirs()
        written = deltas_store.publish(
            root, public, current_gameweek=1, keep_gameweeks=4,
        )
        assert written is not None
        self.assertTrue(written.exists())
        # Empty, not missing. This is the whole distinction.
        self.assertEqual(written.read_text(encoding="utf-8"), "")

    def test_a_dry_run_writes_nothing(self):
        from pipeline.learning import deltas as deltas_store

        root, public = self._dirs()
        self.assertIsNone(
            deltas_store.publish(
                root, public, current_gameweek=1, keep_gameweeks=4, dry_run=True,
            )
        )

    def test_the_publish_call_is_not_guarded_on_changes(self):
        """
        Pins the fix at the call site.

        A unit test on `publish` cannot catch this: `publish` was always correct.
        What was wrong was that nothing called it on a quiet tick, so the guard
        has to be asserted where it lived.
        """
        source = (
            Path(__file__).resolve().parents[1]
            / "learning" / "run_news.py"
        ).read_text(encoding="utf-8")
        publish_at = source.index("deltas_store.publish(")
        # The 400 characters before the call must not reintroduce the guard.
        preceding = source[max(0, publish_at - 400):publish_at]
        self.assertNotIn("if changes:", preceding)


class UnboundNameTests(unittest.TestCase):
    """
    Every name a function reads must be bound somewhere it can reach.

    ## The measured defect

    `poll()` was edited to pass `deadline=deadline` to `grok_feed.poll`, but
    `deadline` was only ever assigned inside `in_news_window` — a different
    function. `import pipeline.learning.run_news` still succeeded, because a
    function body is not executed at import, so every check that had ever been
    run on this module passed. It would have raised `NameError` on the first
    real poll inside the news window, in a workflow nobody watches, and the
    Grok lane would simply have stayed empty.

    A linter would catch this; there is no linter on the Python side. This is
    that check, scoped to the module where it bit.
    """

    def test_no_function_reads_a_name_it_never_binds(self):
        import ast
        from pathlib import Path

        source = (Path(__file__).resolve().parents[1]
                  / "learning" / "run_news.py").read_text(encoding="utf-8")
        tree = ast.parse(source)

        # Module scope: imports, constants, and the functions themselves.
        module_names = {"__file__", "__name__"}
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    module_names.add((alias.asname or alias.name).split(".")[0])
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                module_names.add(node.name)
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        module_names.add(target.id)
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                module_names.add(node.target.id)

        import builtins

        builtin_names = set(dir(builtins))
        unbound = []

        for fn in [n for n in ast.walk(tree)
                   if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            bound = set(module_names)
            args = fn.args
            for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs):
                bound.add(arg.arg)
            if args.vararg:
                bound.add(args.vararg.arg)
            if args.kwarg:
                bound.add(args.kwarg.arg)
            # Anything assigned anywhere in the function is in scope for the
            # whole function, which is exactly Python's own rule.
            for node in ast.walk(fn):
                if isinstance(node, ast.Assign):
                    for target in node.targets:
                        for name in ast.walk(target):
                            if isinstance(name, ast.Name):
                                bound.add(name.id)
                elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                    if isinstance(node.target, ast.Name):
                        bound.add(node.target.id)
                elif isinstance(node, (ast.For, ast.AsyncFor)):
                    for name in ast.walk(node.target):
                        if isinstance(name, ast.Name):
                            bound.add(name.id)
                elif isinstance(node, ast.comprehension):
                    for name in ast.walk(node.target):
                        if isinstance(name, ast.Name):
                            bound.add(name.id)
                elif isinstance(node, (ast.With, ast.AsyncWith)):
                    for item in node.items:
                        if item.optional_vars is not None:
                            for name in ast.walk(item.optional_vars):
                                if isinstance(name, ast.Name):
                                    bound.add(name.id)
                elif isinstance(node, ast.ExceptHandler) and node.name:
                    bound.add(node.name)
                elif isinstance(node, ast.Lambda):
                    for arg in (*node.args.posonlyargs, *node.args.args,
                                *node.args.kwonlyargs):
                        bound.add(arg.arg)
                elif isinstance(node, (ast.Import, ast.ImportFrom)):
                    for alias in node.names:
                        bound.add((alias.asname or alias.name).split(".")[0])
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                                       ast.ClassDef)) and node is not fn:
                    bound.add(node.name)
                elif isinstance(node, ast.Global):
                    bound.update(node.names)
                elif isinstance(node, ast.NamedExpr):
                    # A walrus binds too. Omitting it made this check report
                    # `current_gameweek`'s `(deadline := ...)` as unbound — a
                    # false positive on correct code, which is the failure mode
                    # that teaches people to delete a test rather than read it.
                    for name in ast.walk(node.target):
                        if isinstance(name, ast.Name):
                            bound.add(name.id)

            for node in ast.walk(fn):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                    if node.id not in bound and node.id not in builtin_names:
                        unbound.append(f"{fn.name}() reads '{node.id}' "
                                       f"(line {node.lineno}) but never binds it")

        self.assertEqual(unbound, [], "\n".join(unbound))
