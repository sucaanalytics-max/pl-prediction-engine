# Single-Team Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a 28-route, three-team agent console into a five-route, single-team pre-deadline planner whose central projection is never blank.

**Architecture:** Three pipeline changes give the surviving screens data they currently lack — one entry instead of two, a horizon that survives a finished gameweek, and a projection published outside the 48-hour window. Then the frontend re-mounts four components that only deleted routes import, deletes 23 routes and ~4,700 lines of orphaned components in one commit, and gains a test that makes a 24th route a red build.

**Tech Stack:** Python 3 (unittest, PyMC, XGBoost, PuLP), Next.js 14.2 App Router + React 18.3 (vitest, testing-library), deployed to Vercel and Cloudflare.

**Spec:** `docs/superpowers/specs/2026-08-23-single-team-dashboard-design.md`

## Global Constraints

- **Python tests are unittest, not pytest.** `PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v`. Use the repo venv — bare `python3` is a Homebrew 3.14 without scipy and degrades to 56 import errors that read as a code regression.
- **Never pipe a test run to `tail` or `head`.** The pipe reports the pager's exit code, so a failing suite looks like a pass. Redirect to a file, then check `$?`.
- **Frontend gate is four commands:** `cd frontend && npm run test && npm run lint && npm run build`, plus `npm run build:cloudflare`. Both build targets ship.
- **Do not touch `_seal` or `_settle`.** `pipeline/learning/{schedule,ledger,outcomes}.py` and the seal paths are owned by the `seal-warden` agent. A seal is irrecoverable and there are 38 a season. Task 3 modifies one constant in `schedule.py` and nothing else in that file.
- **`predictions/fpl/ledger/` is append-only and must be byte-identical after every task.** Verify with `git status predictions/fpl/ledger/`.
- **Odds API is 500 requests/month** and the daily pipeline consumes it. No task here adds a fetch loop or shortens the 30-minute cache.
- **`middleware.ts`, not `proxy.ts`.** This frontend is Next.js 14.2; the `proxy.ts` rename is a Next.js 16 change.
- **`public/sw.js`: edit `SHELL_ROUTES` and bump `CACHE_NAME` in the same commit**, or `cache.addAll` rejects atomically and every installed PWA precaches nothing.
- **Branch first.** Three bots push to `main` every ~20 minutes. Work on `feat/single-team-dashboard` and rebase before pushing.
- **The entry label is `owner`.** The spec proposed dropping the label suffix entirely; this plan keeps the field and sets its single value, because `test_commit_and_push.py` already proves the staging glob `predictions/fpl/decision_gw*.json` handles both shapes, and keeping the field avoids churning the six test files that pass `entry_label=`.

---

### Task 1: One entry, not two

**Files:**
- Modify: `pipeline/config.py:453-477`
- Test: `pipeline/tests/test_config_entries.py` (create)
- Delete: `frontend/public/predictions/fpl/decision_public_gw01_season.json`, `decision_public_gw01_weekly.json`, `sensitivity_gw01_season.json`, `sensitivity_gw01_weekly.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `FPL_ENTRIES` with exactly one key, `"owner"`, whose `entry_id` is 20945 and `objective` is `"season"`. Task 7 relies on that label string.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_config_entries.py`:

```python
"""The dashboard serves one entry. The two bot entries moved to another project."""
import unittest

from pipeline.config import FPL_ENTRIES


class OneEntryOnly(unittest.TestCase):
    def test_exactly_one_entry(self):
        self.assertEqual(list(FPL_ENTRIES), ["owner"])

    def test_it_is_the_owner_s_team(self):
        self.assertEqual(FPL_ENTRIES["owner"]["entry_id"], 20945)

    def test_the_objective_is_season(self):
        # The weekly objective is gated on a calibrated field model that does not
        # exist, so it silently fell back to season on every run. One entry on the
        # season objective means the gate at run_decide.py:298 never fires.
        self.assertEqual(FPL_ENTRIES["owner"]["objective"], "season")

    def test_no_entry_carries_the_weekly_objective(self):
        self.assertNotIn(
            "weekly", [e["objective"] for e in FPL_ENTRIES.values()]
        )

    def test_the_bot_entries_are_gone(self):
        ids = {e["entry_id"] for e in FPL_ENTRIES.values()}
        self.assertNotIn(2561567, ids)  # Ronny
        self.assertNotIn(2561099, ids)  # Wazza
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/dev/pl-prediction-engine
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_config_entries -v > /tmp/t1.log 2>&1; echo "exit=$?"; cat /tmp/t1.log
```

Expected: FAIL — `['season', 'weekly'] != ['owner']`.

- [ ] **Step 3: Replace `FPL_ENTRIES`**

In `pipeline/config.py`, replace the whole dict at `:453-477` with:

```python
FPL_ENTRIES: Dict[str, Dict[str, Any]] = {
    # The owner's own team, and the only one this repo decides for.
    # https://fantasy.premierleague.com/en/entry/20945/
    #
    # Ronny (2561567) and Wazza (2561099) were removed on 2026-08-24 and moved to
    # a separate project that runs them on its own scheduled workflows. They read
    # this repo's published `xp_public_gw{NN}.json`; they must never write into
    # `predictions/fpl/ledger/` or any seal path here.
    #
    # The label is what names the artifact: `decision_gw{NN}_owner.json`.
    "owner": {
        "entry_id": int(os.environ.get("FPL_ENTRY_OWNER", "20945")),
        "team_name": "Jay's Team",
        # Maximise expected points; variance is a cost. The `weekly` objective is
        # deliberately absent: it is gated on `field_is_usable`, which reads a
        # calibration verdict store that nothing writes, so a weekly entry fell
        # back to this objective on every run while claiming to be different.
        "objective": "season",
        # Manual override and pre-season default only. `_read_entry` prefers the
        # committed capture, then FPL live, and only then these.
        "squad": [],
        "bank": None,
        "free_transfers": 1,
        "purchase_prices": None,
    },
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_config_entries -v > /tmp/t1.log 2>&1; echo "exit=$?"; tail -5 /tmp/t1.log
```

Expected: `OK`, 5 tests.

- [ ] **Step 5: Run the full pipeline suite and fix fallout**

```bash
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v > /tmp/pipe.log 2>&1; echo "exit=$?"; grep -E "^(FAIL|ERROR):" /tmp/pipe.log
```

Expected: any failure names a test that hardcodes `"season"`/`"weekly"` as an *entry label*. Fix each by using `"owner"`. Do **not** change tests that use `"season"` as an `objective` value — that value survives. `test_end_to_end.py:141` passes both (`entry_label="season", objective="season"`); only the first becomes `"owner"`.

- [ ] **Step 6: Delete the two bots' stale published artifacts**

```bash
cd ~/dev/pl-prediction-engine
git rm frontend/public/predictions/fpl/decision_public_gw01_season.json \
       frontend/public/predictions/fpl/decision_public_gw01_weekly.json \
       frontend/public/predictions/fpl/sensitivity_gw01_season.json \
       frontend/public/predictions/fpl/sensitivity_gw01_weekly.json
git rm predictions/fpl/decision_gw01_season.json predictions/fpl/decision_gw01_weekly.json
```

These describe entries this repo no longer decides for. Decision artifacts are not pruned by any run, so leaving them means the frontend could fetch a bot's plan forever.

- [ ] **Step 7: Verify the ledger is untouched**

```bash
git status --short predictions/fpl/ledger/
```

Expected: no output. If anything appears, stop — the seal path must not change in this task.

- [ ] **Step 8: Commit**

```bash
git add pipeline/config.py pipeline/tests/
git commit -m "Serve one entry: detach Ronny and Wazza to their own project

FPL_ENTRIES held two legacy bot entries and not the owner's 20945, so the
portal and the decision agent described different managers (red-team finding
1 in docs/fplreview-replacement.md). One entry on the season objective also
retires the field-model gate: it only ever blocked the weekly objective,
which silently fell back to season on every run."
```

---

### Task 2: The horizon survives a finished gameweek

**Files:**
- Modify: `pipeline/learning/run_agent.py:607-742` (`_project_horizon`)
- Test: `pipeline/tests/test_horizon_targets.py` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `horizon_targets(fixtures_raw, first_gameweek, eval_horizon) -> list[int]` in `pipeline/learning/run_agent.py`, returning the gameweek numbers that have at least one unplayed fixture, contiguous from the first such week, capped at `eval_horizon` entries. Task 3 asserts on its output.

**Why extract a helper:** `_project_horizon` needs `inputs`, `rules`, `exported`, `strengths`, a bootstrap and a Monte Carlo simulator, so it cannot be unit-tested cheaply. The defect is entirely in *which weeks it chooses*, which is pure logic over a fixture list. Extract that, test it exhaustively, and leave the simulation loop alone.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_horizon_targets.py`:

```python
"""Which gameweeks the horizon covers.

The shipped defect: the loop began at `offset 0` and `break`d when a target week
had no unplayed fixtures. Once the current gameweek's matches finished, `weeks`
came back empty, `len(weeks) < 2` returned None, and weeks 1-7 — which DID have
fixtures — were discarded with it. Between the last match of GW N and the deadline
of GW N+1, which is most of a week, the horizon was None by construction.
"""
import unittest

from pipeline.learning.run_agent import horizon_targets


def fixture(event, finished):
    return {"event": event, "finished": finished, "team_h": 1, "team_a": 2}


class HorizonTargets(unittest.TestCase):
    def test_all_weeks_unplayed_gives_the_full_horizon(self):
        raw = [fixture(gw, False) for gw in range(1, 12)]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2, 3, 4, 5, 6, 7, 8])

    def test_a_finished_current_week_is_skipped_not_fatal(self):
        # THE REGRESSION. GW1 played out; GW2-9 are still to come.
        raw = [fixture(1, True)] + [fixture(gw, False) for gw in range(2, 12)]
        self.assertEqual(horizon_targets(raw, 1, 8), [2, 3, 4, 5, 6, 7, 8, 9])

    def test_a_partly_finished_week_still_counts(self):
        raw = [fixture(1, True), fixture(1, False)] + [
            fixture(gw, False) for gw in range(2, 6)
        ]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2, 3, 4, 5])

    def test_it_stops_at_the_end_of_the_published_schedule(self):
        # Past GW3 nothing is scheduled. Padding with zeros would tell the
        # optimiser every player blanks, so stopping is correct.
        raw = [fixture(gw, False) for gw in (1, 2, 3)]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2, 3])

    def test_a_genuinely_blank_week_stops_the_horizon(self):
        # GW3 has no fixtures at all; GW4 does. The horizon stops rather than
        # jumping the gap, because a squad cannot be planned across a week the
        # optimiser has no view of.
        raw = [fixture(1, False), fixture(2, False), fixture(4, False)]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2])

    def test_eval_horizon_caps_the_length(self):
        raw = [fixture(gw, False) for gw in range(1, 20)]
        self.assertEqual(len(horizon_targets(raw, 1, 8)), 8)

    def test_every_week_finished_returns_empty(self):
        raw = [fixture(gw, True) for gw in range(1, 5)]
        self.assertEqual(horizon_targets(raw, 1, 8), [])

    def test_fixtures_with_no_event_are_ignored(self):
        # FPL leaves `event` null on unscheduled fixtures.
        raw = [fixture(None, False), fixture(1, False), fixture(2, False)]
        self.assertEqual(horizon_targets(raw, 1, 8), [1, 2])
```

- [ ] **Step 2: Run it to verify it fails**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_horizon_targets -v > /tmp/t2.log 2>&1; echo "exit=$?"; grep -E "ImportError|cannot import" /tmp/t2.log
```

Expected: FAIL — `cannot import name 'horizon_targets'`.

- [ ] **Step 3: Add the helper**

Insert into `pipeline/learning/run_agent.py`, immediately above `def _project_horizon`:

```python
def horizon_targets(
    fixtures_raw: Any, first_gameweek: int, eval_horizon: int
) -> List[int]:
    """
    The gameweeks the horizon should cover, in order.

    A week qualifies when it has at least one UNPLAYED fixture. Weeks whose
    matches are already finished are **skipped**, not fatal: between the last
    match of one gameweek and the deadline of the next — most of a week — the
    current week has nothing left to simulate while the next seven do.

    The walk still STOPS at the first week with no fixtures at all, which is
    either a genuinely blank gameweek or the end of the published schedule.
    Jumping that gap would plan a squad across a week the optimiser has no view
    of, and padding it with zeros would tell the optimiser every player blanks.
    So a gap ends the horizon; a finished week does not.
    """
    scheduled: Dict[int, bool] = {}
    for fixture in fixtures_raw:
        event = fixture.get("event")
        if not isinstance(event, int):
            continue  # FPL leaves `event` null until a fixture is scheduled.
        scheduled[event] = scheduled.get(event, False) or not fixture.get("finished")

    targets: List[int] = []
    week = int(first_gameweek)
    while len(targets) < int(eval_horizon):
        if week not in scheduled:
            break  # A blank week, or past the published schedule.
        if scheduled[week]:
            targets.append(week)
        week += 1
    return targets
```

- [ ] **Step 4: Run it to verify it passes**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_horizon_targets -v > /tmp/t2.log 2>&1; echo "exit=$?"; tail -5 /tmp/t2.log
```

Expected: `OK`, 8 tests.

- [ ] **Step 5: Rewire `_project_horizon` to use it**

In `_project_horizon`, replace the loop header and the `if not specs: break` block. The old code is:

```python
    for offset in range(EVAL_HORIZON):
        target = int(gameweek) + offset
        specs = []
```

Replace with:

```python
    targets = horizon_targets(fixtures_raw, int(gameweek), EVAL_HORIZON)
    for offset, target in enumerate(targets):
        specs = []
```

Then delete the now-unreachable `break` guard:

```python
        if not specs:
            # A genuinely empty gameweek (or one past the published schedule).
            # Stopping is right: padding with zeros would tell the optimiser
            # every player blanks, and it would plan around a fiction.
            break
```

and replace it with:

```python
        if not specs:
            # horizon_targets already excluded weeks with nothing unplayed, so
            # reaching here means a fixture named a team this bootstrap does not
            # carry. Skip the week rather than truncate the horizon.
            logger.warning("GW%s: no usable fixture specs; skipping", target)
            continue
```

**Note on `offset`:** it is still passed to `project_squads_at_horizon(inputs, horizon=offset, ...)` as the availability-decay distance, and `enumerate` keeps it 0-based over the weeks actually simulated. That is the correct semantics — decay is measured from the week being planned, not from a calendar gameweek number.

- [ ] **Step 6: Run the full suite**

```bash
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v > /tmp/pipe.log 2>&1; echo "exit=$?"; grep -E "^(FAIL|ERROR):" /tmp/pipe.log; tail -3 /tmp/pipe.log
```

Expected: `OK`, ~1789 tests. `test_decide_horizon.py` and `test_end_to_end.py` exercise the surrounding paths.

- [ ] **Step 7: Commit**

```bash
git add pipeline/learning/run_agent.py pipeline/tests/test_horizon_targets.py
git commit -m "Keep the horizon when the current gameweek has finished

_project_horizon began at offset 0 and broke out when a target week had no
unplayed fixtures, so once this week's matches ended the whole eight-week
horizon returned None and weeks 1-7 went with it. A gap in the schedule still
stops the walk; a finished week no longer does."
```

---

### Task 3: A projection exists every day, not only inside 48 hours

**Files:**
- Modify: `pipeline/learning/schedule.py:44`
- Modify: `pipeline/learning/run_agent.py:1457-1460` (the `Phase.REFRESH` branch)
- Test: `pipeline/tests/test_agent_schedule.py` (extend), `pipeline/tests/test_refresh_cadence.py` (create)

**Interfaces:**
- Consumes: nothing. **Task 2 was reverted** — its premise was a misdiagnosis: `refresh_expected_points` returns `{"status": "skipped"}` at `run_agent.py:509` before `_project_horizon` is reached, so the offset-0 break it "fixed" is unreachable, while skipping a week broke `build_horizon_block`'s positional gameweek labelling. This task carries the whole fix for the blank planner on its own.
- Produces: `projection_is_current(predictions_dir, gameweek, now, max_age) -> bool` in `run_agent.py`. Nothing later depends on it.

**Measure before choosing.** The cadence is a cost decision and the spec refuses to guess it.

**This task is now the entire fix for the blank planner.** The proven defect is that
`REFRESH_WINDOW` is 48 hours while the frontend resolves its gameweek from the next
deadline: outside the window the phase is `idle`, nothing is written, and the front page
fetches an `xp_public_gw{NN}.json` that has never existed. Verified on 2026-08-23 — GW2
deadline 126h out, `phase: idle`, and no `xp_public_gw02.json` anywhere in the tree.

- [ ] **Step 1: Time one horizon projection**

```bash
cd ~/dev/pl-prediction-engine
PYTHONPATH=. .venv/bin/python -c "
import logging, time
logging.basicConfig(level=logging.INFO)
from pathlib import Path
from pipeline.learning.schedule import resolve
from pipeline.learning.run_agent import refresh_expected_points

# resolve() first: refresh_expected_points does int(gameweek) internally and
# raises TypeError on None despite its Optional[int] annotation, so the gameweek
# must be a real number. This also tells you the phase before you touch anything.
state = resolve(Path('predictions'))
print('PHASE', state.phase.value, 'GW', state.gameweek)
assert state.phase.value != 'seal', 'SEAL phase — stop, do not run this by hand'

t = time.time()
out = refresh_expected_points(Path('predictions'), state.gameweek)
print('STATUS', out.get('status'), 'ELAPSED', round(time.time() - t, 1), 's')
print('HORIZON WEEKS', len(out.get('_xp_by_week') or []))
" 2>&1 | tail -25
```

This performs a real projection run and writes artifacts. That is intended — it is
the same work Step 10 verifies — but read the `PHASE` line before trusting the
timing: a `skipped` status means the gameweek had no unplayed fixtures and no
simulation was timed.

Record the elapsed seconds and the week count in the commit message. This is 8 × `simulate_gameweek` at `n_draws_horizon = 5_000` plus one decision-stream simulation.

**Decision rule:** if elapsed ≤ 120s, `PROJECTION_MAX_AGE = timedelta(hours=6)`. If 120s–600s, use `timedelta(hours=20)` (about one full run a day). If over 600s, use `timedelta(hours=20)` and open a follow-up issue to cut `n_draws_horizon`; do not raise the cadence to compensate.

- [ ] **Step 2: Write the failing schedule test**

Append to `pipeline/tests/test_agent_schedule.py`:

```python
    def test_refresh_reaches_a_deadline_a_week_out(self):
        """
        The window was 48h, so for ~4.5 days of every 7 the phase was IDLE, no
        projection was written, and the front page fetched a file that had never
        existed. The frontend resolves the gameweek from agent_status.gameweek —
        the NEXT deadline — so it asks for a week the producer had not reached.
        """
        from datetime import timedelta
        from pipeline.learning.schedule import REFRESH_WINDOW

        self.assertGreaterEqual(REFRESH_WINDOW, timedelta(days=7))
```

- [ ] **Step 3: Run it to verify it fails**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_agent_schedule -v > /tmp/t3.log 2>&1; echo "exit=$?"; grep -E "^(FAIL|ERROR):" /tmp/t3.log
```

Expected: FAIL — `datetime.timedelta(seconds=172800) < datetime.timedelta(days=7)`.

- [ ] **Step 4: Widen the window**

In `pipeline/learning/schedule.py`, replace lines 43-44:

```python
# Refresh projections from this far out.
REFRESH_WINDOW = timedelta(hours=48)
```

with:

```python
# Refresh projections from this far out.
#
# Was 48 hours, which left the dashboard with nothing for roughly 4.5 days of
# every 7: the phase resolver reports the NEXT deadline's gameweek, the frontend
# turns that number into `fpl/xp_public_gw{NN}.json`, and outside the window that
# file had never been written. Eight days covers a normal inter-deadline gap so a
# projection for the next gameweek always exists.
#
# Widening the WINDOW is not widening the CADENCE. Every run inside 48 hours
# still refreshes, because late team news dominates projection error there; a run
# further out refreshes only if the published projection has aged past
# PROJECTION_MAX_AGE. The gate lives in run_agent, not here, so this module stays
# a pure function of the schedule. IDLE_HORIZON is 45 days and does not shadow
# this.
REFRESH_WINDOW = timedelta(days=8)
```

- [ ] **Step 5: Run it to verify it passes**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_agent_schedule -v > /tmp/t3.log 2>&1; echo "exit=$?"; tail -3 /tmp/t3.log
```

Expected: `OK`.

- [ ] **Step 6: Write the failing cadence test**

Create `pipeline/tests/test_refresh_cadence.py`:

```python
"""A wide refresh window must not mean a full simulation every three hours."""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pipeline.learning.run_agent import projection_is_current

NOW = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
MAX_AGE = timedelta(hours=20)


class ProjectionIsCurrent(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "fpl").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, gameweek, generated_at):
        path = self.root / "fpl" / f"xp_public_gw{gameweek:02d}.json"
        path.write_text(json.dumps({"generated_at": generated_at}))

    def test_absent_is_not_current(self):
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_a_fresh_projection_is_current(self):
        self.write(2, "2026-08-24T06:00:00Z")
        self.assertTrue(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_an_aged_projection_is_not_current(self):
        self.write(2, "2026-08-23T06:00:00Z")  # 30 hours old
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_another_gameweek_s_file_does_not_count(self):
        # The exact failure being fixed: gw01 on disk, gw02 requested.
        self.write(1, "2026-08-24T06:00:00Z")
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_an_unreadable_stamp_is_not_current(self):
        path = self.root / "fpl" / "xp_public_gw02.json"
        path.write_text("{not json")
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))

    def test_a_missing_stamp_is_not_current(self):
        self.write(2, None)
        self.assertFalse(projection_is_current(self.root, 2, NOW, MAX_AGE))
```

- [ ] **Step 7: Run it to verify it fails**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_refresh_cadence -v > /tmp/t3b.log 2>&1; echo "exit=$?"; grep -E "cannot import" /tmp/t3b.log
```

Expected: FAIL — `cannot import name 'projection_is_current'`.

- [ ] **Step 8: Implement the gate**

Add to `pipeline/learning/run_agent.py`, above the phase dispatch:

```python
#: How stale a published projection may be before a run outside the seal window
#: rebuilds it. Set from a measured `_project_horizon` runtime — see
#: docs/superpowers/plans/2026-08-24-single-team-dashboard.md Task 3 Step 1.
PROJECTION_MAX_AGE = timedelta(hours=20)


def projection_is_current(
    predictions_dir: Path,
    gameweek: int,
    now: datetime,
    max_age: timedelta = PROJECTION_MAX_AGE,
) -> bool:
    """
    Whether a published projection for THIS gameweek is young enough to keep.

    Keyed on the gameweek, not on "the newest file present". That distinction is
    the whole defect: `xp_public_gw01.json` sat on disk looking fresh while the
    frontend asked for `gw02`, which had never been written.

    Anything unreadable counts as not current. A projection is cheap to rebuild
    and wrong to guess at.
    """
    path = Path(predictions_dir) / "fpl" / f"xp_public_gw{int(gameweek):02d}.json"
    try:
        stamp = json.loads(path.read_text(encoding="utf-8")).get("generated_at")
    except (OSError, ValueError):
        return False
    if not isinstance(stamp, str):
        return False
    try:
        generated = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    if generated.tzinfo is None:
        generated = generated.replace(tzinfo=timezone.utc)
    return (now - generated) < max_age
```

Then replace the `Phase.REFRESH` branch at `:1457-1460`:

```python
    if state.phase is Phase.REFRESH:
        outcome = refresh_expected_points(predictions_dir, state.gameweek)
        logger.info("refresh: %s", outcome)
        return 0
```

with:

```python
    if state.phase is Phase.REFRESH:
        # Inside the seal window every run refreshes: late team news dominates
        # projection error there. Further out, refresh only when the published
        # projection for THIS gameweek has aged out, so an eight-day window costs
        # about one full simulation a day rather than one every three hours.
        remaining = timedelta(seconds=state.seconds_to_deadline or 0)
        now = datetime.now(timezone.utc)
        if remaining > SEAL_WINDOW and projection_is_current(
            predictions_dir, state.gameweek, now
        ):
            logger.info(
                "refresh skipped: GW%s projection is younger than %s and the "
                "deadline is %.1fh away",
                state.gameweek, PROJECTION_MAX_AGE, remaining.total_seconds() / 3600,
            )
            return 0
        outcome = refresh_expected_points(predictions_dir, state.gameweek)
        logger.info("refresh: %s", outcome)
        return 0
```

**Two imports are missing and the code above will not run without them.** Verified
against the current file: `run_agent.py:22` is `from datetime import datetime,
timezone` — no `timedelta` — and `:30` is `from pipeline.learning.schedule import
Phase, ScheduleState, resolve` — no `SEAL_WINDOW`. `json`, `Path`, `Any`, `Dict`
and `List` are already imported. So make exactly these two edits:

```python
# line 22
from datetime import datetime, timedelta, timezone
# line 30
from pipeline.learning.schedule import Phase, ScheduleState, SEAL_WINDOW, resolve
```

- [ ] **Step 9: Run both tests, then the full suite**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_refresh_cadence -v > /tmp/t3b.log 2>&1; echo "exit=$?"; tail -3 /tmp/t3b.log
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v > /tmp/pipe.log 2>&1; echo "exit=$?"; grep -E "^(FAIL|ERROR):" /tmp/pipe.log; tail -3 /tmp/pipe.log
```

Expected: `OK` for both.

- [ ] **Step 10: Prove the real thing — a projection for the next gameweek**

```bash
# Confirm the phase BEFORE running. A SEAL is irrecoverable and there are 38 a
# season; if this prints `seal`, stop and escalate rather than running the agent.
PYTHONPATH=. .venv/bin/python -c "
from pathlib import Path
from pipeline.learning.schedule import resolve
s = resolve(Path('predictions')); print(s.phase.value, s.gameweek, s.reason)"

PYTHONPATH=. .venv/bin/python -m pipeline.learning.run_agent 2>&1 | tail -20
ls -la predictions/fpl/xp_public_gw*.json
.venv/bin/python -c "
import json, glob
for p in sorted(glob.glob('predictions/fpl/xp_public_gw*.json')):
    d = json.load(open(p))
    h = d.get('horizon')
    print(p, 'gw', d.get('gameweek'), 'horizon weeks',
          len(h['weeks']) if h else None)
"
```

Expected: a file for the **next** gameweek carrying a `horizon` block with at least 2 weeks.

If `horizon` is `None`, do **not** reach for the reverted Task 2 change. `_project_horizon` returns `None` when it covered fewer than 2 weeks; check the run's log for the "horizon covers N gameweek(s)" warning and for `flat_default` goal-rate warnings, which say the Dixon-Coles export does not reach the horizon. That is a data-coverage problem, not the week-selection logic.

`run_agent.py` has a bare `main()` at `:1498` with no argparse and no CLI flags —
it reads the phase and acts. There is no `--once`, which is why the phase must be
checked separately, first.

There IS one safety valve: `main()` reads `FPL_AGENT_DRY_RUN` from the environment
and threads it into `seal_forecast(dry_run=...)`. It guards **the seal only** — a
REFRESH run writes its projections either way — but set it anyway on any
hand-run of the agent (`FPL_AGENT_DRY_RUN=true PYTHONPATH=. .venv/bin/python -m
pipeline.learning.run_agent`), so a phase that turns out to be SEAL cannot burn one
of the season's 38 irrecoverable seals from a developer's terminal.

- [ ] **Step 11: Verify the ledger is untouched, then commit**

```bash
git status --short predictions/fpl/ledger/
git add pipeline/learning/schedule.py pipeline/learning/run_agent.py pipeline/tests/
git commit -m "Publish a projection every day, not only inside 48 hours

REFRESH_WINDOW was 48h while the frontend resolves the gameweek from the NEXT
deadline, so for ~4.5 days of every 7 the phase was IDLE, no projection for
that gameweek was written, and the front page fetched a file that had never
existed. Window widened to 8 days; cadence held by a per-gameweek staleness
gate so this costs about one simulation a day. Measured _project_horizon
runtime: <FILL IN FROM STEP 1>s over <N> weeks."
```

---

### Task 4: Rescue the four components before anything is deleted

**Files:**
- Modify: `frontend/app/players/page.tsx` (replace all 763 lines)
- Modify: `frontend/app/evidence/page.tsx` (replace all 433 lines)
- Modify: `frontend/app/page.tsx` (add the PlanGrid section)
- Test: `frontend/test/rescued-mounts.test.tsx` (create)

**Interfaces:**
- Consumes: `decisionDescriptor(gameweek, label)` from `@/lib/data/narrow` — still two-argument at this point; Task 7 collapses it. Pass `"owner"`.
- Produces: `/players`, `/evidence` and `/` each importing their rescued component, which Task 5's deletion depends on.

**Why this task is first among the frontend work:** `ResearchView`, `NewsView` and `WatchView` are imported **only** by `app/margin/page.tsx`. `PlanGrid` has no importer at all. Deleting `/margin` before this lands strands three tested components, which is precisely how this repo once stranded a 612-line page.

The two `Horizon` types are different and must not be crossed:
- `Planner` (already mounted via `ScoreView` on `/`) takes `lib/data/projections.ts`'s `Horizon` — per-player xP per week, from `xp_public`'s `horizon` block.
- `PlanGrid` takes `lib/data/narrow.ts`'s `Horizon` — `{evalHorizon, transferHorizon, weeks: HorizonWeek[]}` where each week carries `squad`/`xi`/`captain`/`vice`, from the **decision** artifact.

- [ ] **Step 1: Write the failing test**

Create `frontend/test/rescued-mounts.test.tsx`:

```tsx
/**
 * The four components that only a doomed route imports are mounted elsewhere.
 *
 * ResearchView, NewsView and WatchView are imported by `app/margin/page.tsx` and
 * nothing else; PlanGrid is imported by nothing at all. This asserts each has a
 * new home BEFORE the deletion commit, so "still reachable" is a measured claim.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

describe("rescued mounts", () => {
  it("mounts ResearchView on /players", () => {
    const source = read("app", "players", "page.tsx");
    expect(source).toContain("ResearchView");
    expect(source).toContain("margin/ResearchView");
  });

  it("mounts NewsView and WatchView on /evidence", () => {
    const source = read("app", "evidence", "page.tsx");
    expect(source).toContain("NewsView");
    expect(source).toContain("WatchView");
  });

  it("mounts PlanGrid on /", () => {
    const source = read("app", "page.tsx");
    expect(source).toContain("PlanGrid");
  });

  it("does not reach for the two detached entries", () => {
    for (const page of [
      read("app", "page.tsx"),
      read("app", "players", "page.tsx"),
      read("app", "evidence", "page.tsx"),
    ]) {
      expect(page).not.toContain('"weekly"');
      expect(page).not.toContain("ENTRY_LABELS");
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/dev/pl-prediction-engine/frontend
npx vitest run test/rescued-mounts.test.tsx 2>&1 | tail -20
```

Expected: FAIL on all three mount assertions.

- [ ] **Step 3: Replace `/players`**

Replace the entire contents of `frontend/app/players/page.tsx`:

```tsx
"use client";

/**
 * Players — who could I bring in, and how wide is the spread on him.
 *
 * ## What this replaces
 *
 * 763 lines that carried three panels answering the same question three ways: a
 * "Projections" table, a "Ranked players" list that duplicated the transfer
 * shortlist, and "Season statistics" built on player_stats.json's per-90 trap.
 *
 * `ResearchView` is the only surface in the app that reads `xp_public` end to end
 * with its quantiles, which is the reason this route survives the cut at all. It
 * was reachable only from `/margin`, a route now deleted.
 */

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ResearchView } from "@/components/margin/ResearchView";
import { useCurrentGameweek } from "@/lib/data/gameweek";

export default function PlayersPage() {
  const gameweek = useCurrentGameweek();

  return (
    <ErrorBoundary pageName="Players">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Players
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Who could I bring in, and how wide is the spread on him
          </p>
        </header>

        {gameweek === null ? (
          // One line, not a panel. There is no substance on this page to be
          // outweighed, but the rule is the rule.
          <p className="text-xs" style={{ color: "var(--text-4)" }}>
            Neither the agent&apos;s status nor FPL&apos;s own state could be read,
            so the gameweek is unknown. Guessing one would read a different
            gameweek&apos;s projection.
          </p>
        ) : (
          <ResearchView gameweek={gameweek} />
        )}
      </div>
    </ErrorBoundary>
  );
}
```

- [ ] **Step 4: Replace `/evidence`**

Replace the entire contents of `frontend/app/evidence/page.tsx`:

```tsx
"use client";

/**
 * Evidence — what moved since I last looked, and how much of this is guessed.
 *
 * ## What this absorbs
 *
 * `/inbox`, `/accuracy` and `/health`, plus `/margin?view=news`. `WatchView`
 * already carries the decay ledger and the perfect-model calibration ceiling from
 * accuracy.json, which is what makes `/accuracy` and `/health` redundant rather
 * than the reverse. `NewsView` performs the squad join the pipeline could not, and
 * its copy is the model for how a claim should carry its source.
 *
 * The page's own `CapturedHeadlines` is gone: it read the identical NEWS_FEED
 * artifact that NewsView reads better.
 */

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { NewsView } from "@/components/margin/NewsView";
import { WatchView } from "@/components/margin/WatchView";
import { Section } from "@/components/data/Artifact";
import { useCurrentGameweek } from "@/lib/data/gameweek";

export default function EvidencePage() {
  const gameweek = useCurrentGameweek();

  return (
    <ErrorBoundary pageName="Evidence">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Evidence
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            What moved since you last looked, and how much of this is guessed
          </p>
        </header>

        {/* The claims lead: they are what changed. */}
        <Section
          title="Availability"
          subtitle="What the model believes about who plays, and who said so"
        >
          <NewsView />
        </Section>

        {/* Then whether to trust any of it. */}
        <Section
          title="Do I believe it"
          subtitle="What has decayed, and how close the model is to the best any forecaster could do"
        >
          {gameweek === null ? (
            <p className="text-xs" style={{ color: "var(--text-4)" }}>
              The gameweek could not be resolved, so the decay ledger cannot be
              pointed at a projection.
            </p>
          ) : (
            <WatchView gameweek={gameweek} />
          )}
        </Section>
      </div>
    </ErrorBoundary>
  );
}
```

- [ ] **Step 5: Mount `PlanGrid` on `/`**

In `frontend/app/page.tsx`, add these imports:

```tsx
import { PlanGrid } from "@/components/margin/PlanGrid";
import { PlanGridSection } from "@/components/PlanGridSection";
```

Create `frontend/components/PlanGridSection.tsx`:

```tsx
"use client";

/**
 * The solved plan, week by week.
 *
 * `PlanGrid` reads the **decision** artifact's horizon — `{evalHorizon,
 * transferHorizon, weeks}` where each week carries squad, xi, captain and vice —
 * which is a different type from the per-player xP horizon `Planner` consumes off
 * `xp_public`. Both are called `Horizon`; crossing them is a type error, which is
 * the only reason it has not happened yet.
 *
 * It had no importer anywhere in the tree: 295 lines and a 170-line test,
 * rendering the players x gameweeks view this dashboard exists to show, mounted
 * nowhere. This is the mount.
 */

import { PlanGrid } from "@/components/margin/PlanGrid";
import { proven } from "@/lib/data/artifact";
import { decisionDescriptor } from "@/lib/data/narrow";
import { projectionsDescriptor } from "@/lib/data/projections";
import { useArtifact } from "@/lib/data/useArtifact";

export function PlanGridSection({ gameweek }: { gameweek: number }) {
  const { artifact: decision } = useArtifact(
    decisionDescriptor(gameweek, "owner"),
  );
  const { artifact: projections } = useArtifact(projectionsDescriptor(gameweek));

  const horizon = proven(decision)?.horizon ?? null;
  const players = proven(projections)?.players ?? [];

  if (horizon === null || players.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-4)" }}>
        No solved plan has been published for GW{gameweek}. The optimiser writes
        one when it decides, which is inside the seal window before the deadline.
      </p>
    );
  }

  return <PlanGrid horizon={horizon} projections={players} />;
}
```

Then add a section to `app/page.tsx`, below the existing "The plan" section:

```tsx
        <Section
          title="Week by week"
          subtitle="The solved plan across the horizon — who starts, who benches, who wears the armband"
        >
          {gameweek === null ? (
            <p className="text-xs" style={{ color: "var(--text-4)" }}>
              The gameweek could not be resolved, so the plan cannot be pointed at
              a decision.
            </p>
          ) : (
            <PlanGridSection gameweek={gameweek} />
          )}
        </Section>
```

Remove the now-unused direct `PlanGrid` import from `app/page.tsx` — only `PlanGridSection` is used there.

- [ ] **Step 6: Run the rescue test, then the full frontend gate**

```bash
cd ~/dev/pl-prediction-engine/frontend
npx vitest run test/rescued-mounts.test.tsx 2>&1 | tail -10
npm run test > /tmp/fe.log 2>&1; echo "exit=$?"; grep -E "FAIL|✗" /tmp/fe.log | head -20; tail -5 /tmp/fe.log
npm run lint && npm run build
```

Expected: rescue test passes. Existing `app/players/page.test.tsx` and `app/evidence/page.test.tsx` will fail where they assert deleted panels — rewrite those assertions against the new content. Do **not** delete those suites.

- [ ] **Step 7: Commit**

```bash
cd ~/dev/pl-prediction-engine
git add frontend/app/players/page.tsx frontend/app/evidence/page.tsx \
        frontend/app/page.tsx frontend/components/PlanGridSection.tsx \
        frontend/test/rescued-mounts.test.tsx frontend/app/players/page.test.tsx \
        frontend/app/evidence/page.test.tsx
git commit -m "Rescue four components before deleting the routes that hold them

ResearchView, NewsView and WatchView were imported only by app/margin, and
PlanGrid by nothing at all — 1,657 tested lines one deletion away from being
stranded, which is how this repo once stranded a 612-line match page. Nothing
is deleted here; the tree is briefly redundant and always green."
```

---

### Task 5: Delete 23 routes and everything only they reached

**Files:**
- Delete: 23 route directories under `frontend/app/`
- Delete: 17 components under `frontend/components/`
- Modify: `frontend/components/Navigation.tsx`, `frontend/public/sw.js`, `frontend/lib/data/narrow.ts`
- Delete: `frontend/test/absorbed-routes.test.tsx`
- Rewrite: `frontend/test/nav-coverage.test.tsx`

**Interfaces:**
- Consumes: the mounts from Task 4. Do not start this task until Task 4 is committed and green.
- Produces: an `app/` tree containing exactly `page.tsx`, `players/`, `evidence/`, `capture/`, `offline/`, `api/`.

**One commit.** Splitting it leaves the tree in a state where `sw.js` precaches a route that no longer exists, and `cache.addAll` rejects atomically.

- [ ] **Step 1: Write the enforcer test first**

Rewrite `frontend/test/nav-coverage.test.tsx` entirely:

```tsx
/**
 * The route surface is an allow-list, and the nav reaches all of it.
 *
 * ## Why this is a test and not a convention
 *
 * Three specs — 2026-08-11, 08-17, 08-18 — each prescribed deleting superseded
 * surfaces. None was executed; the 08-18 one specified the cut line by line and
 * two MORE routes were added after it was written. The tree's own docstrings named
 * the reason: "rescue precedes deletion… so the two surfaces can be compared
 * before anything is destroyed." The comparison never concluded.
 *
 * Intent has now lost three times, so this is the enforcer. A 24th route is a red
 * build, and the rescue half of that principle is preserved in
 * `test/rescued-mounts.test.tsx`, which runs before any deletion.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(process.cwd(), "app");
const NAV = join(process.cwd(), "components", "Navigation.tsx");

/** Every page route this app is allowed to have, and why it exists. */
const ALLOWED: Record<string, string> = {
  ".": "the call: XI, captain, and the horizon",
  players: "the shortlist, with the spread on each candidate",
  evidence: "what moved, and whether to believe it",
  capture: "the position: squad, bank, purchase prices — reached from /, not the nav",
  offline: "served by the service worker when a fetch fails; not a destination",
};

/** Routes reached from the nav. `capture` and `offline` deliberately are not. */
const IN_NAV = ["/", "/players", "/evidence"];

function routeDirs(): string[] {
  return readdirSync(APP, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "api")
    .map((e) => e.name);
}

describe("route allow-list", () => {
  it("has exactly the allowed routes and no others", () => {
    const found = routeDirs().sort();
    const allowed = Object.keys(ALLOWED).filter((r) => r !== ".").sort();
    expect(found).toEqual(allowed);
  });

  it("every allowed route is actually built", () => {
    for (const route of Object.keys(ALLOWED)) {
      const path = route === "."
        ? join(APP, "page.tsx")
        : join(APP, route, "page.tsx");
      expect(() => readFileSync(path, "utf8"), `${route} must exist`).not.toThrow();
    }
  });

  it("contains no redirect stubs", () => {
    // Nine of these existed, four pointing at the same page. A stub is how a
    // deleted surface comes back as a nav entry that promises variety.
    for (const route of routeDirs()) {
      const source = readFileSync(join(APP, route, "page.tsx"), "utf8");
      expect(source, `${route} must not be a redirect`).not.toContain(
        'from "next/navigation"',
      );
    }
  });

  it("the nav links exactly the three destinations", () => {
    const nav = readFileSync(NAV, "utf8");
    const linked = [...nav.matchAll(/href:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
    expect([...new Set(linked)].sort()).toEqual([...IN_NAV].sort());
  });

  it("the nav has no groups", () => {
    // Four groups over twelve destinations is what pushed the FPL screens below
    // the fold. Three flat items need no grouping.
    expect(readFileSync(NAV, "utf8")).not.toContain("NAV_GROUPS");
  });

  it("the service worker precaches only routes that exist", () => {
    const sw = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
    const routes = [...sw.matchAll(/^\s*"(\/[a-z-]*)",/gm)].map((m) => m[1]);
    for (const route of routes) {
      const name = route === "/" ? "." : route.slice(1);
      expect(ALLOWED, `sw.js precaches ${route}`).toHaveProperty(name);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/dev/pl-prediction-engine/frontend
npx vitest run test/nav-coverage.test.tsx 2>&1 | tail -25
```

Expected: FAIL — the found-routes array holds 27 entries against 4 allowed.

- [ ] **Step 3: Delete the routes**

```bash
cd ~/dev/pl-prediction-engine/frontend
git rm -r app/now app/margin app/decide app/decisions app/control-room \
          app/inbox app/accuracy app/health \
          app/bet app/markets app/bankroll app/matches app/h2h \
          app/captaincy app/optimizer app/planner app/transfers \
          app/rankings app/projections app/intelligence app/table app/value-bets
```

`app/matches` removal takes `app/matches/[id]` with it. That is 23 routes and 5,041 lines.

- [ ] **Step 4: Delete the components only those routes reached**

```bash
git rm components/margin/DecideView.tsx components/margin/Shell.tsx \
       components/margin/SquadInterval.tsx \
       components/control-room/Matrix.tsx components/control-room/Queue.tsx \
       components/control-room/Ambient.tsx components/control-room/parts.tsx \
       components/control-room/Squad.tsx \
       components/squad/SquadBoard.tsx components/squad/SquadRow.tsx \
       components/FixtureTable.tsx components/BetTable.tsx \
       components/HistoricalMatchDetails.tsx components/PnLChart.tsx \
       components/ScorelineHeatmap.tsx components/SHAPWaterfall.tsx \
       components/DistributionChart.tsx
git rm -f components/margin/DecideView.test.tsx components/margin/DecideCard.tsx \
          components/margin/DecideCard.test.tsx \
          components/squad/SquadBoard.test.tsx components/squad/SquadRow.test.tsx \
          components/control-room/*.test.tsx 2>/dev/null || true
```

`control-room/Squad` → `squad/SquadBoard` → `squad/SquadRow` is a four-link chain where each file has exactly one importer, the one above it. `components/SquadBoard.tsx` (no `squad/` prefix) is a **different** component used by `/` — do not delete it.

- [ ] **Step 5: Delete the test that enforced the deferral**

```bash
git rm test/absorbed-routes.test.tsx
```

Its docstring says it exists "before the deletion, not after" and asserts the nine doomed routes still import and render. Keeping it makes this commit red by design. Its rescue guarantee now lives in `test/rescued-mounts.test.tsx`.

- [ ] **Step 6: Flatten the nav**

In `frontend/components/Navigation.tsx`: delete the `NavGroup` interface, the `NAV_GROUPS` array and its render loop; delete `badge` and `valueBadge` from `NavItem`; delete the `REGISTRY.latest` fetch and `valueBetCount` (computed on every page load of every route and rendered nowhere); delete the sidebar's second deadline clock and the status block that reports `latest.json`'s age beneath the words "draft captured". Replace with a flat array:

```tsx
const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "The call", icon: LayoutDashboard },
  { href: "/players", label: "Players", icon: Users },
  { href: "/evidence", label: "Evidence", icon: Stethoscope },
];
```

and render it directly, dropping the group wrapper and `portal-nav-label`. Prune the now-unused lucide imports — `npm run lint` names each one.

- [ ] **Step 7: Update the service worker, same commit**

In `frontend/public/sw.js`, replace `SHELL_ROUTES` and bump the cache name:

```js
const CACHE_NAME = "suca-fpl-shell-v8";
const SHELL_ROUTES = [
  "/",
  "/players",
  "/evidence",
  "/capture",
  "/offline",
  "/icon.svg",
  "/icon-maskable.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];
```

v8 earns its bump because `/margin`, `/bet`, `/now`, `/decide` and `/accuracy` no longer exist; a v7 precache holds pages that now 410, and the offline branch would replay them.

- [ ] **Step 8: Drop the dead registry entries**

In `frontend/lib/data/narrow.ts`, remove the `REGISTRY` entries `table`, `h2h`, `latest` and `blendWeight` (`blendWeight` already had no consumer; the others lose theirs with the match and betting screens), and the `n_value_bets` field at `:111` and `:148` — narrowed, never rendered, null on every row of the shipped `latest.json`.

- [ ] **Step 9: Run the enforcer, then the full gate**

```bash
cd ~/dev/pl-prediction-engine/frontend
npx vitest run test/nav-coverage.test.tsx 2>&1 | tail -10
npm run test > /tmp/fe.log 2>&1; echo "exit=$?"; grep -E "FAIL|✗" /tmp/fe.log | head -30; tail -5 /tmp/fe.log
```

Expected: the enforcer passes. Every remaining failure is a test file whose subject is gone — delete those suites (`app/now/page.test.tsx`, `app/margin/page.test.tsx`, `app/decide/page.test.tsx`, `components/FixtureMatrix.test.tsx` if its subject went, and so on). A test whose only subject is deleted is deleted; a test that also covers surviving code is narrowed, not removed.

- [ ] **Step 10: Confirm nothing imports a deleted module**

```bash
npm run lint && npm run build && npm run build:cloudflare
npx vitest run test/no-untracked-imports.test.ts 2>&1 | tail -5
```

Expected: all pass. A build error naming a missing module means something surviving imported a deleted component — re-check before deleting more.

- [ ] **Step 11: Commit**

```bash
cd ~/dev/pl-prediction-engine
git add -A frontend/
git commit -m "Delete 23 routes and the 4,698 lines only they reached

Five routes answered 'who do I captain this week' and nine more were redirect
stubs, four of them landing on the same page. Routes 28 -> 5, nav destinations
12 -> 3, groups 4 -> 0. test/nav-coverage.test.tsx is now an allow-list, so a
24th route is a red build rather than a resolution to tidy up later — three
prior specs prescribed this cut and relied on intent, which lost three times.
sw.js CACHE_NAME bumped in the same commit; cache.addAll rejects atomically."
```

---

### Task 6: The deleted URLs return 410

**Files:**
- Create: `frontend/middleware.ts`
- Test: `frontend/test/gone-routes.test.ts` (create)

**Interfaces:**
- Consumes: the deletion from Task 5.
- Produces: nothing later depends on it.

`middleware.ts`, not `proxy.ts` — this frontend is Next.js 14.2 and the rename is a Next.js 16 change. `next.config.js` `redirects` cannot express 410, and a `route.ts` per path would be 23 files to avoid 23 files.

- [ ] **Step 1: Write the failing test**

Create `frontend/test/gone-routes.test.ts`:

```ts
/**
 * The deleted routes announce that they are gone, not missing.
 *
 * 22 path prefixes cover 23 deleted route files: `/matches/[id]` has no entry of
 * its own because the middleware also matches on the first path segment.
 *
 * 410 rather than 404 because these were real pages with bookmarks and a service
 * worker that precached several of them: "intentionally gone" is the true
 * statement, and it stops a crawler retrying forever.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");

const GONE = [
  "/now", "/margin", "/decide", "/decisions", "/control-room",
  "/inbox", "/accuracy", "/health",
  "/bet", "/markets", "/bankroll", "/matches", "/h2h",
  "/captaincy", "/optimizer", "/planner", "/transfers",
  "/rankings", "/projections", "/intelligence", "/table", "/value-bets",
];

describe("gone routes", () => {
  it("names every deleted route", () => {
    for (const route of GONE) {
      expect(source, `${route} must be listed as gone`).toContain(`"${route}"`);
    }
  });

  it("returns 410, not 404 or a redirect", () => {
    expect(source).toContain("410");
    expect(source).not.toContain("NextResponse.redirect");
  });

  it("does not intercept a surviving route", () => {
    const surviving = readdirSync(join(process.cwd(), "app"), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory() && e.name !== "api")
      .map((e) => `/${e.name}`);
    for (const route of surviving) {
      expect(GONE, `${route} still exists and must not be gone`).not.toContain(route);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/dev/pl-prediction-engine/frontend
npx vitest run test/gone-routes.test.ts 2>&1 | tail -10
```

Expected: FAIL — `middleware.ts` does not exist.

- [ ] **Step 3: Create the middleware**

Create `frontend/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

/**
 * The routes this app used to have, and no longer does.
 *
 * 410 Gone rather than 404 Not Found: these were real destinations, several were
 * precached by `public/sw.js`, and some are bookmarked. "Intentionally removed" is
 * the accurate statement and it stops a crawler retrying indefinitely.
 *
 * `next.config.js` redirects cannot express 410 — only 307/308 — and a `route.ts`
 * per path would be 23 files to avoid 23 files. This is `middleware.ts` and not
 * `proxy.ts` because this app is on Next.js 14.2; the rename landed in Next 16.
 */
const GONE = new Set([
  // Five surfaces that all answered "who do I captain this week".
  "/now", "/margin", "/decide", "/decisions", "/control-room",
  // Absorbed into /evidence.
  "/inbox", "/accuracy", "/health",
  // Betting and match prediction: a different question, and the models still run.
  "/bet", "/markets", "/bankroll", "/matches", "/h2h",
  // Redirect stubs, four of which landed on the same page.
  "/captaincy", "/optimizer", "/planner", "/transfers",
  "/rankings", "/projections", "/intelligence", "/table", "/value-bets",
]);

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/\/+$/, "") || "/";
  const root = "/" + (path.split("/")[1] ?? "");
  if (GONE.has(path) || GONE.has(root)) {
    return new NextResponse(null, { status: 410 });
  }
  return NextResponse.next();
}

export const config = {
  // Everything except assets, the API and Next's own internals. Matching on the
  // set above rather than here keeps the gone list in one readable place.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
```

The `root` check is what makes `/matches/38` 410 along with `/matches`.

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run test/gone-routes.test.ts 2>&1 | tail -8
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Verify against a running server, both build targets**

```bash
npm run build && npm run start &
sleep 8
for p in /now /margin /decide /control-room /matches /matches/38 /value-bets; do
  printf "%s -> %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' localhost:3000$p)"
done
for p in / /players /evidence /capture; do
  printf "%s -> %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' localhost:3000$p)"
done
kill %1
npm run build:cloudflare
```

Expected: 410 for every deleted path including `/matches/38`; 200 for the four survivors. If `build:cloudflare` drops the middleware, fall back to a `not-found` route returning 410 and record why in the commit message.

- [ ] **Step 6: Commit**

```bash
cd ~/dev/pl-prediction-engine
git add frontend/middleware.ts frontend/test/gone-routes.test.ts
git commit -m "410 the 23 deleted routes

They were real destinations, several precached by the service worker and some
bookmarked, so 'intentionally gone' is the true response rather than 404.
middleware.ts, not proxy.ts: this frontend is Next.js 14.2."
```

---

### Task 7: Collapse the entry label

**Files:**
- Modify: `frontend/lib/data/narrow.ts:889,975,1180,1431-1447,1493-1520`
- Modify: `frontend/lib/data/sensitivity.ts:162`
- Modify: `frontend/components/PlanGridSection.tsx`
- Test: `frontend/test/single-entry.test.ts` (create)

**Interfaces:**
- Consumes: `"owner"` as the only entry label, from Task 1.
- Produces: `decisionDescriptor(gameweek: number)` — one argument. `sensitivityDescriptor(gameweek: number)` likewise.

- [ ] **Step 1: Write the failing test**

Create `frontend/test/single-entry.test.ts`:

```ts
/**
 * One entry, so no label to choose.
 *
 * ENTRY_LABELS existed because the pipeline decided for two bot entries and the
 * portal rendered both, which is how a screen came to show two disagreeing
 * "Projected" figures by design. The bots moved to their own project on
 * 2026-08-24.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decisionDescriptor } from "@/lib/data/narrow";
import { sensitivityDescriptor } from "@/lib/data/sensitivity";

describe("single entry", () => {
  it("builds a decision path from a gameweek alone", () => {
    expect(decisionDescriptor(2).path).toBe(
      "fpl/decision_public_gw02_owner.json",
    );
  });

  it("builds a sensitivity path from a gameweek alone", () => {
    expect(sensitivityDescriptor(2).path).toBe(
      "fpl/sensitivity_gw02_owner.json",
    );
  });

  it("pads the gameweek", () => {
    expect(decisionDescriptor(11).path).toContain("gw11");
  });

  it("has no ENTRY_LABELS left anywhere", () => {
    const narrow = readFileSync(
      join(process.cwd(), "lib", "data", "narrow.ts"), "utf8",
    );
    expect(narrow).not.toContain("ENTRY_LABELS");
    expect(narrow).not.toContain("EntryLabel");
    expect(narrow).not.toContain('"weekly"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/dev/pl-prediction-engine/frontend
npx vitest run test/single-entry.test.ts 2>&1 | tail -15
```

Expected: FAIL — `decisionDescriptor` expects 2 arguments.

- [ ] **Step 3: Collapse the descriptors**

In `frontend/lib/data/narrow.ts`, delete `ENTRY_LABELS` and `EntryLabel` (`:1493-1494`) and replace `decisionDescriptor`:

```tsx
/** The single entry's label, as `pipeline/config.py::FPL_ENTRIES` names it. */
const ENTRY = "owner";

/**
 * A descriptor for the decision in one gameweek.
 *
 * Took a label until 2026-08-24, when the two bot entries moved to their own
 * project. The label survives in the FILENAME because `write_decision` still
 * composes `decision_gw{NN}_{label}.json` and the staging glob depends on that
 * shape; it no longer survives as a choice a caller can get wrong.
 *
 * Deliberately NOT a `decision_latest.json`: that name was fetched by the old
 * page, staged by one workflow, excluded by another, and written by nothing.
 */
export function decisionDescriptor(gameweek: number): Descriptor<PublicDecision> {
  const padded = String(gameweek).padStart(2, "0");
  return {
    key: `decision:${padded}`,
    path: `fpl/decision_public_gw${padded}_${ENTRY}.json`,
    owner: "agent",
    describes: `the proposal for GW${gameweek}`,
    freshnessBudgetMs: null,
    narrow: narrowPublicDecision,
    producedAtOf: (v) => v.generated_at,
    isEmpty: (v) => v.plan === null,
  };
}
```

Apply the same collapse to `sensitivityDescriptor` in `lib/data/sensitivity.ts:162`, using the same `ENTRY` constant exported from `narrow.ts`.

Keep `entry_label` on the `PublicDecision` interface and its narrowing (`:889`, `:975`, `:1180`, `:1431-1447`) — the artifact still carries the field, `WatchView` and the delta feed render it, and removing it from the wire contract would churn six Python test files for a cosmetic gain.

- [ ] **Step 4: Update the one caller**

In `frontend/components/PlanGridSection.tsx`, change:

```tsx
  const { artifact: decision } = useArtifact(
    decisionDescriptor(gameweek, "owner"),
  );
```

to:

```tsx
  const { artifact: decision } = useArtifact(decisionDescriptor(gameweek));
```

- [ ] **Step 5: Run it to verify it passes, then the full gate**

```bash
npx vitest run test/single-entry.test.ts 2>&1 | tail -8
npm run test > /tmp/fe.log 2>&1; echo "exit=$?"; grep -E "FAIL|✗" /tmp/fe.log | head -20; tail -5 /tmp/fe.log
npm run lint && npm run build && npm run build:cloudflare
```

Expected: all green. Any failure is a leftover two-argument call — `grep -rn "decisionDescriptor(\|sensitivityDescriptor(" app components lib test` finds them.

- [ ] **Step 6: Commit**

```bash
cd ~/dev/pl-prediction-engine
git add frontend/lib/data/narrow.ts frontend/lib/data/sensitivity.ts \
        frontend/components/PlanGridSection.tsx frontend/test/single-entry.test.ts
git commit -m "One entry, so no label to choose

decisionDescriptor and sensitivityDescriptor took an EntryLabel because the
pipeline decided for two bot entries and /decide rendered both — which is how a
screen came to show two disagreeing 'Projected' figures by design. The label
stays in the filename, because write_decision composes it and the staging glob
depends on that shape; it stops being an argument a caller can get wrong."
```

---

## Final verification

- [ ] **Full gate, both languages, both build targets**

```bash
cd ~/dev/pl-prediction-engine
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v > /tmp/pipe.log 2>&1; echo "python exit=$?"
cd frontend
npm run test > /tmp/fe.log 2>&1; echo "frontend exit=$?"
npm run lint; echo "lint exit=$?"
npm run build; echo "build exit=$?"
npm run build:cloudflare; echo "cloudflare exit=$?"
```

All five must be 0. Check the exit codes, not the log tails.

- [ ] **The ledger never moved**

```bash
cd ~/dev/pl-prediction-engine && git status --short predictions/fpl/ledger/
git log --oneline main..HEAD -- predictions/fpl/ledger/
```

Both empty. If either is not, a seal path was touched and this needs `seal-warden` review before it goes anywhere.

- [ ] **The dashboard is not blank**

```bash
ls predictions/fpl/xp_public_gw*.json frontend/public/predictions/fpl/xp_public_gw*.json
.venv/bin/python -c "
import json, glob
for p in sorted(glob.glob('frontend/public/predictions/fpl/xp_public_gw*.json')):
    d = json.load(open(p))
    h = d.get('horizon')
    print(p, 'gw', d.get('gameweek'), 'players', len(d.get('players', [])),
          'horizon weeks', len(h['weeks']) if h else None)
"
```

The published file's gameweek must equal `agent_status.json`'s `gameweek`, and it must carry a `horizon` block. Those two numbers disagreeing is the original defect; if they disagree here, Task 3 did not land.

- [ ] **Counts match the spec**

```bash
cd frontend
echo "routes: $(find app -name page.tsx | wc -l) (expect 5)"
echo "nav destinations: $(grep -c 'href: "' components/Navigation.tsx) (expect 3)"
grep -c "NAV_GROUPS" components/Navigation.tsx || echo "nav groups: 0"
```

- [ ] **Push**

```bash
cd ~/dev/pl-prediction-engine
git fetch origin && git rebase origin/main
```

Three bots push to `main`; rebase, confirm the active `gh` account, then watch whichever CI gate the changed paths trigger. Use the repo's `push-and-watch` skill rather than a bare `git push`.

## Self-review notes

**Spec coverage.** Target structure → Tasks 4, 5. Detachment (pipeline) → Task 1. Detachment (frontend) → Task 7. The gate that stops mattering → Task 1 Step 3, asserted in `test_config_entries.py`. Feeding the planner → Tasks 2, 3. Rescue before deletion → Task 4. Deletions → Task 5. How the 410 is served → Task 6. The enforcer → Task 5 Step 1. Sequencing → task order, with the Task 4/5 dependency stated in both. Verification → Final verification.

**Not covered, deliberately.** The seam to the agent-teams project is documentation for a different repo, not work here; Task 1's config comment records what it may read and the one rule it must obey. Tracing `objective: 0.0` on the provisional weeks is left open — `PlanGridSection` renders squad/xi/captain/vice and never that field, so nothing here depends on it.

**Type consistency.** `horizon_targets(fixtures_raw, first_gameweek, eval_horizon) -> List[int]` is defined in Task 2 and used in Tasks 2 and 3. `projection_is_current(predictions_dir, gameweek, now, max_age) -> bool` is defined and used in Task 3. `decisionDescriptor` is two-argument in Task 4 and one-argument from Task 7, which is why Task 4 passes `"owner"` explicitly and Task 7 Step 4 removes it. The two `Horizon` types are named apart wherever both appear.
