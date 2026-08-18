# Phase 0 — Make the numbers true: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every number the FPL surfaces display traceable and correct — anchor the FPL projections on market-blended goal rates, give them a multi-gameweek horizon, and close three defects that would otherwise report wrong or unfalsifiable values forever.

**Architecture:** Six independent changes to the Python pipeline, no frontend work. Five are small and self-contained; one (Tasks 4–5) redirects the FPL layer's fixture source from `latest.json`'s unanchored ensemble to `predictions/fixture_xg.json`, which is the only artifact carrying rates beyond the next gameweek.

**Tech Stack:** Python 3.11, unittest (NOT pytest — no pytest config exists), pandas, numpy. Run everything through the repo venv.

**Spec:** `docs/superpowers/specs/2026-08-17-fpl-control-room-design.md` (§3, "Phase 0")

## Global Constraints

- **Tests are `unittest`, not pytest.** Run: `PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v`
- **Never pipe test output to `tail`/`head`** — `cmd | tail` reports tail's exit code, so a failing suite looks like a pass. Redirect to a file, then check `$?`.
- **Use `.venv/bin/python`, never bare `python3`.** Bare python3 is a Homebrew 3.14 without scipy; the suite degrades to 1187 tests with 56 import errors and reads as a code regression.
- **Never widen stake sizing or drop a risk cap.** Nothing in this plan touches `pipeline/risk/kelly.py` or `RISK` in `config.py`. If a change appears to require it, stop.
- **Team names must be canonicalised** through `pipeline/data/team_mapping.py`. Never join on raw provider strings.
- **A swallowed error yields confidently wrong predictions.** Sources the models depend on must fail loudly. Optional scraped sources degrade gracefully by design.
- **`predictions/forecast_ledger.json` is the only artifact proving a prediction predated kickoff.** Never source an accuracy claim from `latest.json`.
- Files named `foo 2.py` are iCloud sync-conflict duplicates. Never edit one; never treat one as source.

---

### Task 1: The forecast ledger refuses a forecast it cannot prove predated kickoff

The ledger is the sole admissible source for any accuracy claim, and it currently upserts every prediction with no date check at all. A fixture whose `kickoff_time` is null — the state FPL publishes for postponed and TBC fixtures — is admitted as if it were a pre-match forecast.

Note the separation of concerns: we still *predict* TBC fixtures. We simply refuse to record a prediction as **proof of precedence** when precedence cannot be established.

**Files:**
- Modify: `pipeline/validation/ledger.py:15-49` (`update_forecast_ledger`)
- Test: `pipeline/tests/test_ledger.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `update_forecast_ledger(output: Dict, path: Path) -> Dict` — unchanged signature. The returned dict gains a `"rejected"` key: `List[Dict[str, str]]`, each `{"match_id": str, "reason": str}`.

- [ ] **Step 1: Write the failing test**

Add to `pipeline/tests/test_ledger.py`:

```python
class ForecastLedgerAdmissibility(unittest.TestCase):
    """The ledger's only job is proving a forecast predated kickoff."""

    def _output(self, match_id, kickoff, generated_at="2026-08-20T06:00:00Z"):
        return {
            "metadata": {"generated_at": generated_at, "season": "2627"},
            "predictions": [{
                "match_id": match_id,
                "fixture": {"home_team": "Arsenal", "away_team": "Coventry City",
                            "gameweek": 1, "date": kickoff},
                "probabilities": {"home": 0.7, "draw": 0.2, "away": 0.1},
                "expected_goals": {"home": 2.4, "away": 0.7},
            }],
        }

    def test_admits_a_forecast_made_before_kickoff(self):
        path = Path(self.tmpdir) / "ledger.json"
        result = update_forecast_ledger(
            self._output("m1", "2026-08-21T19:00:00Z"), path
        )
        self.assertIn("m1", result["forecasts"])
        self.assertEqual(result["rejected"], [])

    def test_rejects_a_forecast_generated_after_kickoff(self):
        path = Path(self.tmpdir) / "ledger.json"
        result = update_forecast_ledger(
            self._output("m2", "2026-08-21T19:00:00Z",
                         generated_at="2026-08-22T06:00:00Z"),
            path,
        )
        self.assertNotIn("m2", result["forecasts"])
        self.assertEqual(result["rejected"][0]["match_id"], "m2")

    def test_rejects_a_fixture_with_no_kickoff_time(self):
        """FPL publishes null kickoff for postponed and TBC fixtures."""
        path = Path(self.tmpdir) / "ledger.json"
        result = update_forecast_ledger(self._output("m3", None), path)
        self.assertNotIn("m3", result["forecasts"])
        self.assertIn("no kickoff", result["rejected"][0]["reason"])

    def test_never_overwrites_an_admitted_forecast_with_a_later_one(self):
        """The first pre-match forecast is the record; later ones cannot replace it."""
        path = Path(self.tmpdir) / "ledger.json"
        update_forecast_ledger(
            self._output("m4", "2026-08-21T19:00:00Z",
                         generated_at="2026-08-19T06:00:00Z"), path)
        second = self._output("m4", "2026-08-21T19:00:00Z",
                              generated_at="2026-08-20T06:00:00Z")
        second["predictions"][0]["expected_goals"] = {"home": 9.9, "away": 9.9}
        result = update_forecast_ledger(second, path)
        self.assertEqual(result["forecasts"]["m4"]["expected_goals"]["home"], 2.4)
```

Add `setUp`/`tearDown` using `tempfile.mkdtemp()` and `shutil.rmtree`, matching the file's existing convention. Import `update_forecast_ledger` from `pipeline.validation.ledger` and `Path` from `pathlib` if not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/tusk-jvb/dev/pl-prediction-engine
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_ledger -v > /tmp/t1.log 2>&1; echo "exit=$?"
grep -E "FAIL|ERROR" /tmp/t1.log
```

Expected: 3 of 4 FAIL. `test_admits_a_forecast_made_before_kickoff` passes already; the three refusals fail because no check exists and `result["rejected"]` raises `KeyError`.

- [ ] **Step 3: Write the implementation**

In `pipeline/validation/ledger.py`, replace the loop body of `update_forecast_ledger`:

```python
def _parse_iso(value):
    """Return an aware UTC datetime, or None if unparseable/absent."""
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
```

Then, inside `update_forecast_ledger`, replace the `for prediction in ...` loop with:

```python
    forecasts = ledger.get("forecasts", {})
    rejected = []
    generated_at = output.get("metadata", {}).get("generated_at")
    generated_dt = _parse_iso(generated_at)

    for prediction in output.get("predictions", []):
        match_id = prediction["match_id"]
        kickoff_dt = _parse_iso(prediction.get("fixture", {}).get("date"))

        # A forecast is only evidence if we can show it predated kickoff.
        # We still PREDICT these fixtures; we refuse to record the prediction
        # as proof of precedence.
        if kickoff_dt is None:
            rejected.append({"match_id": match_id,
                             "reason": "no kickoff time — cannot prove precedence"})
            continue
        if generated_dt is None:
            rejected.append({"match_id": match_id,
                             "reason": "no generated_at — cannot prove precedence"})
            continue
        if generated_dt >= kickoff_dt:
            rejected.append({"match_id": match_id,
                             "reason": f"generated {generated_at} at or after kickoff"})
            continue

        # First admissible forecast wins. A later one is not more honest for
        # being later, and overwriting would destroy the earlier proof.
        if match_id in forecasts:
            continue

        forecasts[match_id] = {
            "match_id": match_id,
            "generated_at": generated_at,
            "fixture": prediction.get("fixture", {}),
            "probabilities": prediction.get("probabilities", {}),
            "expected_goals": prediction.get("expected_goals", {}),
            "odds_comparison": prediction.get("odds_comparison"),
        }

    if rejected:
        logger.warning(
            "forecast ledger rejected %d of %d predictions as unprovable: %s",
            len(rejected), len(output.get("predictions", [])),
            ", ".join(r["match_id"] for r in rejected),
        )

    ledger = {
        "season": output.get("metadata", {}).get("season"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "forecasts": forecasts,
        "rejected": rejected,
    }
```

Add at the top of the module if absent:

```python
import logging

logger = logging.getLogger(__name__)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_ledger -v > /tmp/t1.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`, 4 tests pass. Then run the whole suite to catch consumers that assumed unconditional upsert:

```bash
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests > /tmp/all.log 2>&1; echo "exit=$?"
grep -cE "^(FAIL|ERROR)" /tmp/all.log
```

If `pipeline/validation/run_validation.py` or `metrics.py` fails because it reads `forecasts` and now sees fewer entries, that is the change working. Fix the caller to tolerate a smaller ledger; do not relax the admissibility rule.

- [ ] **Step 5: Commit**

```bash
git add pipeline/validation/ledger.py pipeline/tests/test_ledger.py
git commit -m "fix(ledger): refuse a forecast that cannot be shown to predate kickoff"
```

---

### Task 2: Settled-outcome discovery reads the file settlement actually writes

`run_agent._settled_outcomes` globs `gw*/outcomes.json`. Settlement writes `outcome.jsonl`. The two have never matched, so `accuracy.json`'s `measured` block and `sensitivity`'s sigma will report zero settled gameweeks forever — and the docstrings excuse today's null with "no gameweek has sealed", which will still read as correct after gameweeks settle. Nothing fails; it just stays silently empty.

Every other consumer already uses the right name (`scoring.py:118`, `schedule.py:147,172`), so this is one reader out of step.

**Files:**
- Modify: `pipeline/learning/run_agent.py:224`
- Create: `pipeline/tests/test_settled_outcomes.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `_settled_outcomes()` — unchanged signature, returns `List[Dict[str, Any]]`. Now non-empty when `outcome.jsonl` files exist.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_settled_outcomes.py`:

```python
"""The reader must find the file the writer writes.

This defect is invisible by construction: both the broken and the correct
state return [] before any gameweek settles, and the docstring's excuse for
the empty case stays plausible forever. Only a test with a settled file on
disk can tell them apart.
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class SettledOutcomeDiscovery(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ledger = Path(self.tmpdir) / "fpl" / "ledger" / "gw01"
        self.ledger.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_settled_gameweek(self):
        """Write the shape outcomes.settle_gameweek produces: a JSONL file
        whose first line is a header and whose remaining lines are players."""
        path = self.ledger / "outcome.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(
                {"gameweek": 1, "revision": 1, "provisional": False}) + "\n")
            handle.write(json.dumps(
                {"element_id": 328, "total_points": 9, "minutes": 90}) + "\n")

    def test_finds_a_settled_gameweek(self):
        self._write_settled_gameweek()
        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            rows = _settled_outcomes()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["element_id"], 328)

    def test_returns_empty_when_nothing_has_settled(self):
        with mock.patch("pipeline.learning.run_agent.PREDICTIONS_DIR", self.tmpdir):
            from pipeline.learning.run_agent import _settled_outcomes
            self.assertEqual(_settled_outcomes(), [])
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_settled_outcomes -v > /tmp/t2.log 2>&1; echo "exit=$?"
```

Expected: `test_finds_a_settled_gameweek` FAILS with `0 != 1` — the glob matches nothing.

- [ ] **Step 3: Write the implementation**

In `pipeline/learning/run_agent.py`, change line 224 from `glob("gw*/outcomes.json")` to `glob("gw*/outcome.jsonl")`, and change the body to parse JSONL rather than a single JSON object:

```python
    rows: List[Dict[str, Any]] = []
    for outcome_path in sorted(ledger_root.glob("gw*/outcome.jsonl")):
        try:
            lines = [
                line for line in
                outcome_path.read_text(encoding="utf-8").splitlines() if line.strip()
            ]
        except OSError as exc:
            # One unreadable sealed week must not hide the others, but it must
            # not pass silently either: a shrinking sample changes every sigma.
            logger.warning("unreadable sealed outcomes at %s: %s", outcome_path, exc)
            continue
        if not lines:
            continue
        try:
            header = json.loads(lines[0])
        except ValueError as exc:
            logger.warning("unreadable outcome header at %s: %s", outcome_path, exc)
            continue
        # Provisional weeks are not settled: bonus and defensive contributions
        # still move until 09:00 UK the day after the last match.
        if header.get("provisional", True):
            continue
        for line in lines[1:]:
            try:
                rows.append(json.loads(line))
            except ValueError as exc:
                logger.warning("unreadable outcome row in %s: %s", outcome_path, exc)
                continue
```

Delete the now-unused `payload.get("players")` loop that followed.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_settled_outcomes -v > /tmp/t2.log 2>&1; echo "exit=$?"
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests > /tmp/all.log 2>&1; echo "exit=$?"
```

Expected: both `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/learning/run_agent.py pipeline/tests/test_settled_outcomes.py
git commit -m "fix(agent): read the outcome file settlement writes, not one nothing writes"
```

---

### Task 3: A run that seals refuses a stale bootstrap

`fetch_bootstrap_static` defaults `allow_stale=True`, and `run_pipeline.py:183` calls it without the argument — while the same run writes the forecast ledger. The fetcher's own docstring states the contract: *any caller that timestamps a forecast MUST pass both*. The stale fallback has no age bound, and `pipeline.yml`'s cache restore keys have no run pin, so the restored `data/raw` can be arbitrarily old.

**Files:**
- Modify: `pipeline/run_pipeline.py:183`
- Create: `pipeline/tests/test_sealing_freshness.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new symbols. `run_pipeline` now propagates a fetch failure rather than silently using stale cache.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_sealing_freshness.py`:

```python
"""The daily lane seals the forecast ledger, so it may not run on stale cache.

fpl_api documents this as a contract: a caller that timestamps a forecast must
refuse stale data. run_agent obeys it; the daily pipeline did not.
"""
import ast
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


class SealingRunRefusesStaleBootstrap(unittest.TestCase):
    # Task 6 swaps these call sites to the provenance-returning variants. The
    # rule under test is about allow_stale, not about which wrapper is used, so
    # accept either name and keep the test valid across that change.
    FETCHERS = {
        "fetch_bootstrap_static", "fetch_bootstrap_static_with_provenance",
        "fetch_fixtures", "fetch_fixtures_with_provenance",
    }

    def test_daily_pipeline_passes_allow_stale_false(self):
        source = (REPO / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and getattr(node.func, "id", None) in self.FETCHERS
        ]
        self.assertTrue(calls, "expected run_pipeline to fetch FPL bootstrap/fixtures")
        for call in calls:
            name = call.func.id
            keywords = {kw.arg for kw in call.keywords}
            self.assertIn(
                "allow_stale", keywords,
                f"{name} at line {call.lineno} must pass allow_stale explicitly — "
                "this run seals the forecast ledger",
            )
            allow_stale = next(
                kw.value for kw in call.keywords if kw.arg == "allow_stale")
            self.assertIs(
                allow_stale.value, False,
                f"{name} at line {call.lineno} must pass allow_stale=False",
            )
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_sealing_freshness -v > /tmp/t3.log 2>&1; echo "exit=$?"
```

Expected: FAIL — `'allow_stale' not found in set()`.

- [ ] **Step 3: Write the implementation**

In `pipeline/run_pipeline.py`, change lines 183–184. **Both** calls, not just the bootstrap — the test checks every FPL fetcher, and a stale fixture list is as corrosive to a sealed record as a stale price list:

```python
    # This run writes forecast_ledger.json, so it may not run on stale cache:
    # a stale bootstrap means stale prices, a stale chance_of_playing and a
    # stale deadline_time riding into a record whose entire value is that it
    # predated kickoff. fpl_api's _fetch_cached_json states this as a contract:
    # "Any caller that timestamps a forecast MUST pass both."
    bootstrap = fetch_bootstrap_static(force=force_refresh, allow_stale=False)
    fixtures_raw = fetch_fixtures(force=force_refresh, allow_stale=False)
```

This makes a network failure raise rather than silently serving an arbitrarily old cache. That is the intent: on deadline day — exactly when the FPL API is most likely to fail — a loud failure is correct and a quiet stale seal is not.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_sealing_freshness -v > /tmp/t3.log 2>&1; echo "exit=$?"
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests > /tmp/all.log 2>&1; echo "exit=$?"
```

Expected: both `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add pipeline/run_pipeline.py pipeline/tests/test_sealing_freshness.py
git commit -m "fix(pipeline): refuse a stale bootstrap on the run that seals the ledger"
```

---

### Task 4: Build fixture specs from the market-anchored artifact

`fixture_specs_from_predictions` reads `latest.json`'s unanchored ensemble. Measured on the committed artifacts for GW1 Arsenal v Coventry: the anchored rate is **2.472 / 0.661** (`rate_source: market_blend`) while the FPL layer uses **1.802 / 0.971** — 37% low on the home rate and 47% high on the away rate. `xp_gw01.json`'s `rate_source` is `null` on every fixture.

The join is three fields — `gameweek`, `home_team`, `away_team` — because both sides already run through `normalize_team_name`. Only `match_id` differs (`fixture_xg` uses the FPL fixture id `"1"`; `latest.json` uses `"20260821_Arsenal_Coventry_City"`).

This task builds and tests the new spec source. Task 5 wires it in.

**Files:**
- Modify: `pipeline/simulation/gameweek_sim.py:54-63` (add one field to `FixtureSpec`)
- Modify: `pipeline/models/fpl_inputs.py` (add a function beside `fixture_specs_from_predictions:333-364`)
- Create: `pipeline/tests/test_fixture_spec_source.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```python
  def fixture_specs_from_fixture_xg(
      fixture_xg: Dict[str, Any],
      gameweeks: Optional[Sequence[int]] = None,
  ) -> List[Any]  # List[FixtureSpec]
  ```
  Each returned `FixtureSpec` carries `match_id, gameweek, home_team, away_team, lambda_home, mu_away, kickoff, rate_source`. Task 5 consumes this exact name and signature, and reads `spec.rate_source`.

  `FixtureSpec` gains `rate_source: Optional[str] = None` as its last field. This is backward-compatible: `kickoff` is already the last field and already has a default, so every existing construction site — positional or keyword — keeps working untouched. Carrying the source on the spec is what removes the need for any parallel lookup table.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_fixture_spec_source.py`:

```python
"""The FPL layer must rank on the market-anchored rates, not the raw ensemble.

fixture_xg.json is validated by seven blocking checks and then discarded. It is
also the only artifact in the repo carrying rates beyond the next gameweek:
80 fixtures across GW1-8 against latest.json's single gameweek.
"""
import unittest

from pipeline.models.fpl_inputs import fixture_specs_from_fixture_xg


def _artifact():
    return {
        "schema_version": 1,
        "horizon": 8,
        "first_gameweek": 1,
        "fixtures": [
            {"match_id": "1", "gameweek": 1,
             "home_team": "Arsenal", "away_team": "Coventry City",
             "kickoff": "2026-08-21T19:00:00Z",
             "lambda_home": 2.471716, "mu_away": 0.661262,
             "rate_source": "market_blend", "prior_only": True},
            {"match_id": "2", "gameweek": 1,
             "home_team": "Hull City", "away_team": "Man United",
             "kickoff": "2026-08-21T19:00:00Z",
             "lambda_home": 0.917505, "mu_away": 2.028719,
             "rate_source": "market_blend", "prior_only": True},
            {"match_id": "11", "gameweek": 2,
             "home_team": "Arsenal", "away_team": "Everton",
             "kickoff": "2026-08-28T19:00:00Z",
             "lambda_home": 2.1, "mu_away": 0.8,
             "rate_source": "dixon_coles_posterior", "prior_only": False},
        ],
    }


class FixtureSpecsFromFixtureXg(unittest.TestCase):
    def test_uses_the_anchored_rate_not_the_dixon_coles_one(self):
        specs = fixture_specs_from_fixture_xg(_artifact(), gameweeks=[1])
        arsenal = next(s for s in specs if s.home_team == "Arsenal")
        self.assertAlmostEqual(arsenal.lambda_home, 2.471716, places=6)
        self.assertAlmostEqual(arsenal.mu_away, 0.661262, places=6)

    def test_spans_multiple_gameweeks(self):
        """The horizon the Planner needs; latest.json is one gameweek wide."""
        specs = fixture_specs_from_fixture_xg(_artifact())
        self.assertEqual(sorted({s.gameweek for s in specs}), [1, 2])

    def test_filters_to_requested_gameweeks(self):
        specs = fixture_specs_from_fixture_xg(_artifact(), gameweeks=[2])
        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0].away_team, "Everton")

    def test_canonicalises_team_names(self):
        artifact = _artifact()
        artifact["fixtures"][0]["home_team"] = "Arsenal FC"
        specs = fixture_specs_from_fixture_xg(artifact, gameweeks=[1])
        self.assertIn("Arsenal", [s.home_team for s in specs])
        self.assertNotIn("Arsenal FC", [s.home_team for s in specs])

    def test_skips_a_fixture_with_no_usable_rate(self):
        """A missing rate must drop the fixture loudly, never default to zero:
        a 0.0 goal rate silently makes every clean sheet a certainty."""
        artifact = _artifact()
        artifact["fixtures"][0]["lambda_home"] = None
        specs = fixture_specs_from_fixture_xg(artifact, gameweeks=[1])
        self.assertEqual([s.home_team for s in specs], ["Hull City"])

    def test_returns_empty_for_an_empty_artifact(self):
        self.assertEqual(fixture_specs_from_fixture_xg({"fixtures": []}), [])

    def test_each_spec_carries_its_own_rate_source(self):
        """Provenance travels on the spec, so the artifact writer needs no
        parallel lookup keyed on team names."""
        specs = fixture_specs_from_fixture_xg(_artifact())
        by_gw = {s.gameweek: s.rate_source for s in specs}
        self.assertEqual(by_gw[1], "market_blend")
        self.assertEqual(by_gw[2], "dixon_coles_posterior")

    def test_labels_an_unsourced_row_rather_than_leaving_it_null(self):
        artifact = _artifact()
        del artifact["fixtures"][0]["rate_source"]
        specs = fixture_specs_from_fixture_xg(artifact, gameweeks=[1])
        arsenal = next(s for s in specs if s.home_team == "Arsenal")
        self.assertEqual(arsenal.rate_source, "unknown")
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_fixture_spec_source -v > /tmp/t4.log 2>&1; echo "exit=$?"
```

Expected: FAIL at import — `cannot import name 'fixture_specs_from_fixture_xg'`.

- [ ] **Step 3: Write the implementation**

**3a.** In `pipeline/simulation/gameweek_sim.py`, add one field to `FixtureSpec` (after `kickoff` at `:63`):

```python
    kickoff: Optional[str] = None
    # Where lambda_home/mu_away came from: "market_blend" when odds anchored the
    # fixture, "dixon_coles_posterior" beyond the priced horizon, or
    # "ensemble_unanchored" on the legacy path. Carried here so the published
    # artifact can state it per fixture without a second lookup.
    rate_source: Optional[str] = None
```

**3b.** In `pipeline/models/fpl_inputs.py`, add directly after `fixture_specs_from_predictions`:

```python
def fixture_specs_from_fixture_xg(fixture_xg, gameweeks=None):
    """
    Build fixture specs from the market-anchored rate artifact.

    Prefer this over :func:`fixture_specs_from_predictions`. That function reads
    ``latest.json``'s ensemble expectation, which is never anchored to the
    market and is one gameweek wide. ``fixture_xg.json`` carries the blended
    rate that seven blocking checks in ``pipeline/fpl/artifacts.py`` already
    validate, spans the full horizon, and states its own ``rate_source`` per
    fixture — so a projection built from it can say where its numbers came from.

    Rows whose rate is missing are DROPPED, not defaulted. A 0.0 goal rate
    makes every clean sheet a certainty and every goal impossible, and that
    error propagates silently into every player projection for the fixture.
    """
    from pipeline.simulation.gameweek_sim import FixtureSpec

    wanted = set(gameweeks) if gameweeks is not None else None
    specs = []
    for row in fixture_xg.get("fixtures") or []:
        gameweek = row.get("gameweek")
        if gameweek is None:
            continue
        gameweek = int(gameweek)
        if wanted is not None and gameweek not in wanted:
            continue

        home = normalize_team_name(row.get("home_team", ""))
        away = normalize_team_name(row.get("away_team", ""))
        if not home or not away:
            continue

        lambda_home = row.get("lambda_home")
        mu_away = row.get("mu_away")
        if lambda_home is None or mu_away is None:
            logger.warning(
                "fixture_xg row GW%s %s v %s has no usable rate; dropping it",
                gameweek, home, away,
            )
            continue

        specs.append(
            FixtureSpec(
                match_id=str(row.get("match_id", f"{home}_{away}")),
                gameweek=gameweek,
                home_team=home,
                away_team=away,
                lambda_home=float(lambda_home),
                mu_away=float(mu_away),
                kickoff=row.get("kickoff"),
                # Never leave this null. A null source is indistinguishable from
                # "nobody wired provenance", which is the bug this replaces.
                rate_source=row.get("rate_source") or "unknown",
            )
        )
    return specs
```

Confirm `normalize_team_name` and a module-level `logger` are already imported in `fpl_inputs.py` (they are used by `fixture_specs_from_predictions` at `:346-358`). If `logger` is absent, add `import logging` and `logger = logging.getLogger(__name__)` at module level.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_fixture_spec_source -v > /tmp/t4.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`, 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline/models/fpl_inputs.py pipeline/tests/test_fixture_spec_source.py
git commit -m "feat(fpl): build fixture specs from the market-anchored rate artifact"
```

---

### Task 5: Wire the anchored specs into the daily lane and record the rate source

Task 4 built the source; this wires it in and makes the result self-describing. The two halves must land together — anchoring without the horizon leaves the Planner reading a one-gameweek artifact, and `fixture_xg.json` is the only multi-week rate source that exists.

`n_anchored` is 10 of 80: GW1's fixtures are market-blended, GW2–8 carry Dixon-Coles posterior rates. That is the honest horizon — anchored where a market exists, model beyond, with each row declaring which.

**Files:**
- Modify: `pipeline/run_pipeline.py:1112` (the `fpl_specs = ...` call site)
- Modify: `pipeline/fpl/artifacts.py` (record `rate_source` per fixture in the emitted artifact)
- Create: `pipeline/tests/test_xp_artifact_rate_source.py`

**Interfaces:**
- Consumes: `fixture_specs_from_fixture_xg(fixture_xg, gameweeks=None) -> List[FixtureSpec]` from Task 4.
- Produces: `xp_gw{NN}.json` whose every entry in `fixtures[]` carries a non-null `rate_source: str`.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_xp_artifact_rate_source.py`:

```python
"""Every published fixture rate must say where it came from.

Without this, a fixture priced at the hardcoded 1.4/1.1 fallback is
indistinguishable from one blended 60/30/10 from three fitted models, and
assert_valid_prediction_output cannot detect the difference because a 1X2
triple still sums to 1.
"""
import json
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARTIFACT = REPO / "predictions" / "fpl" / "xp_gw01.json"


class PublishedRatesDeclareTheirSource(unittest.TestCase):
    @unittest.skipUnless(ARTIFACT.exists(), "no committed xp artifact")
    def test_every_fixture_declares_a_rate_source(self):
        payload = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        fixtures = payload.get("fixtures") or []
        self.assertTrue(fixtures, "artifact has no fixtures")
        missing = [
            f"{f.get('home_team')} v {f.get('away_team')}"
            for f in fixtures if not f.get("rate_source")
        ]
        self.assertEqual(
            missing, [],
            "fixtures published with a null rate_source — the FPL layer is "
            "reading unanchored rates: " + ", ".join(missing),
        )

    @unittest.skipUnless(ARTIFACT.exists(), "no committed xp artifact")
    def test_gameweek_one_is_market_anchored(self):
        payload = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        sources = {f.get("rate_source") for f in payload.get("fixtures") or []}
        self.assertIn(
            "market_blend", sources,
            "no GW1 fixture is market-anchored; the odds blend is being discarded",
        )
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_xp_artifact_rate_source -v > /tmp/t5.log 2>&1; echo "exit=$?"
```

Expected: both FAIL against the committed artifact — every `rate_source` is currently `null`.

- [ ] **Step 3: Write the implementation**

**3a.** In `pipeline/run_pipeline.py`, replace line 1112:

```python
        # Rank on the market-anchored rates, not latest.json's ensemble. The
        # ensemble is never anchored and is one gameweek wide, so reading it
        # cost the FPL layer both its market information and its horizon.
        # fixture_xg.json is validated by seven blocking checks before this
        # point; if it is absent, fall back rather than lose the gameweek.
        fpl_specs = []
        fixture_xg_path = PREDICTIONS_DIR / "fixture_xg.json"
        if fixture_xg_path.exists():
            try:
                fixture_xg_payload = json.loads(
                    fixture_xg_path.read_text(encoding="utf-8"))
                fpl_specs = fixture_specs_from_fixture_xg(fixture_xg_payload)
            except (OSError, ValueError) as exc:
                logger.warning("  unreadable fixture_xg.json: %s", exc)
        if not fpl_specs:
            logger.warning(
                "  falling back to unanchored ensemble rates — projections will "
                "carry rate_source 'ensemble_unanchored' and no horizon"
            )
            fpl_specs = fixture_specs_from_predictions(all_predictions, gameweek)
```

Add `fixture_specs_from_fixture_xg` to the existing `from pipeline.models.fpl_inputs import (...)` statement that already imports `fixture_specs_from_predictions`. Confirm `json` and `PREDICTIONS_DIR` are in scope at that point in `run_pipeline.py`; both are used elsewhere in the module.

**3b.** In `pipeline/models/fpl_inputs.py`, label the legacy path so a fallback is never mistaken for an anchored run. In `fixture_specs_from_predictions` (`:333-364`), add to the `FixtureSpec(...)` construction:

```python
                kickoff=fixture.get("date"),
                rate_source="ensemble_unanchored",
```

**3c.** In `pipeline/fpl/artifacts.py`, **two** places build fixture rows from `spec` — the private artifact at `:487-496` and the public one at `:532-540`. Add the same line to both, immediately after `"mu_away"`:

```python
                "rate_source": spec.rate_source,
```

Note the two differ deliberately: `:493-494` rounds to 4 decimal places, `:537-538` does not. Preserve that difference; only add the new key.

Because Task 4 put `rate_source` on the spec itself, no lookup table, no team-name re-normalisation and no extra parameter is needed at either site.

- [ ] **Step 4: Run the pipeline's FPL step and verify**

Regenerate the artifact, then run the test:

```bash
PYTHONPATH=. .venv/bin/python -m pipeline.run_pipeline > /tmp/run.log 2>&1; echo "exit=$?"
PYTHONPATH=. .venv/bin/python -c "
import json
d = json.load(open('predictions/fpl/xp_gw01.json'))
for f in d['fixtures'][:3]:
    print(f\"{f['home_team']:12} v {f['away_team']:16} \"
          f\"{f['lambda_home']:.3f} / {f['mu_away']:.3f}  {f.get('rate_source')}\")
p = d['players'][0]
print('quantiles published:', sorted(k for k in p if k.startswith('q')))
"
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_xp_artifact_rate_source -v > /tmp/t5.log 2>&1; echo "exit=$?"
```

Expected: Arsenal v Coventry City now reads **2.472 / 0.661** with `rate_source: market_blend`, and `exit=0`.

**Also confirm here — do not build it, it is already fixed in code:** `quantiles published` must list `q10, q25, q50, q75, q90, q99`. `gameweek_sim.py:186-198` computes all six and `public_xp.py:56` publishes `q25`/`q75`; the committed artifact lacks them only because it was generated at 06:30 on 2026-08-17, before commit `4bca1b8` landed at 12:11. If `q25`/`q75` are still absent after a fresh run, that is a real defect: the distribution glyph's interquartile box must come from real quartiles, and `artifacts.py:145` guards the quantile-monotonicity check on `all(value is not None)`, so their absence silently disables it.

- [ ] **Step 5: Run the full suite and commit**

```bash
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests > /tmp/all.log 2>&1; echo "exit=$?"
git add pipeline/run_pipeline.py pipeline/fpl/artifacts.py pipeline/tests/test_xp_artifact_rate_source.py predictions/
git commit -m "fix(fpl): rank on market-anchored rates across the full horizon, and say so"
```

---

### Task 6: `health.json` reports which sources a run actually had

A run with no xG features, no odds and a three-day-old stale bootstrap is currently indistinguishable from a fully-sourced one, and `/health` shows a hardcoded green tick either way — `run_pipeline.py:1198` writes `"status": "healthy"` as a literal. This is exactly the "confidently wrong predictions" failure the project's own constraints warn about.

The remedy is already written and unwired: `fetch_bootstrap_static_with_provenance` and `fetch_fixtures_with_provenance` return `(data, Provenance)` with `source ∈ {network, cache, stale_cache}` and `age_seconds`, and their only callers are the thin wrappers that discard it.

**Files:**
- Modify: `pipeline/run_pipeline.py:183-185` (use the provenance-returning fetchers) and `:1190-1200` (the health writer)
- Create: `pipeline/tests/test_health_provenance.py`

**Interfaces:**
- Consumes: nothing from earlier tasks. Task 3 already set `allow_stale=False` on the bootstrap fetch; this task keeps that and records the resulting provenance.
- Produces: `health.json` gains `sources: Dict[str, Dict[str, Any]]`, each `{"source": str, "age_seconds": float | None}`, and `status` becomes derived rather than literal.

- [ ] **Step 1: Write the failing test**

Create `pipeline/tests/test_health_provenance.py`:

```python
"""health.json must distinguish a fully-sourced run from a degraded one.

'no key' and 'no edge' currently look identical, and status is a hardcoded
literal, so the health page shows the same green tick either way.
"""
import ast
import json
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HEALTH = REPO / "predictions" / "health.json"


class HealthReportsSourceProvenance(unittest.TestCase):
    def test_status_is_not_a_hardcoded_literal(self):
        source = (REPO / "pipeline" / "run_pipeline.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                if (isinstance(key, ast.Constant) and key.value == "status"
                        and isinstance(value, ast.Constant)
                        and value.value == "healthy"):
                    self.fail(
                        f"health status is the literal 'healthy' at line "
                        f"{value.lineno}; derive it from the sources actually present"
                    )

    @unittest.skipUnless(HEALTH.exists(), "no committed health artifact")
    def test_health_names_its_sources(self):
        payload = json.loads(HEALTH.read_text(encoding="utf-8"))
        self.assertIn("sources", payload)
        self.assertIn("bootstrap", payload["sources"])
        entry = payload["sources"]["bootstrap"]
        self.assertIn(entry.get("source"), {"network", "cache", "stale_cache"})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_health_provenance -v > /tmp/t6.log 2>&1; echo "exit=$?"
```

Expected: `test_status_is_not_a_hardcoded_literal` FAILS naming line 1198; the second test fails on the missing `sources` key.

- [ ] **Step 3: Write the implementation**

**3a.** In `run_pipeline.py`, switch to the provenance-returning fetchers, keeping Task 3's refusal:

```python
    from pipeline.data.fpl_api import (
        fetch_bootstrap_static_with_provenance, fetch_fixtures_with_provenance,
        get_upcoming_fixtures, build_player_stats, get_current_gameweek,
    )
    bootstrap, bootstrap_prov = fetch_bootstrap_static_with_provenance(
        force=force_refresh, allow_stale=False
    )
    fixtures_raw, fixtures_prov = fetch_fixtures_with_provenance(
        force=force_refresh, allow_stale=False
    )
    # Provenance is a plain dict (`Provenance = Dict[str, Any]`, fpl_api.py:27),
    # NOT a dataclass — use subscripts, not attributes.
    source_provenance = {
        "bootstrap": {"source": bootstrap_prov["source"],
                      "age_seconds": bootstrap_prov.get("age_seconds")},
        "fixtures": {"source": fixtures_prov["source"],
                     "age_seconds": fixtures_prov.get("age_seconds")},
    }
```

**3b.** In `run_pipeline.py`, `health_data` is built at `:1196` and already carries a `models` block with a per-model `status` for `dixon_coles`, `xgboost`, `penaltyblog` and `goalscorer` (`:1209-1214`). Derive from what is already there rather than inventing a new flag.

Immediately **before** the `health_data = {` literal, add:

```python
        degraded = [
            name for name, entry in source_provenance.items()
            if entry["source"] == "stale_cache"
        ]
        degraded += [
            f"model:{name}" for name, entry in {
                "dixon_coles": {"status": "active" if dc_model else "skipped"},
                "xgboost": {"status": "active" if xgb_model else "failed"},
                "penaltyblog": {"status": "active" if pb_predictions else "failed"},
            }.items() if entry["status"] != "active"
        ]
        if not parsed_main:
            degraded.append("odds")
```

Note `odds_source` is **not** a variable — it is the inline expression
`"the_odds_api" if parsed_main else "unavailable"`, written at both `:900` and `:1218`.
Test the underlying `parsed_main` instead of trying to reuse a name that does not exist.

Then change `"status": "healthy",` at `:1197` to:

```python
            # Derived, never asserted. A run that finished without its odds, or
            # on a stale bootstrap, or with two of three goal models skipped, is
            # not healthy — and a hardcoded literal made those look identical.
            "status": "healthy" if not degraded else "degraded",
            "sources": source_provenance,
            "degraded": degraded,
```

Keep the existing `"odds_source"` key at `:1218` exactly as it is. This task adds three keys and changes one; it does not restructure `health_data`.

- [ ] **Step 4: Run and verify**

```bash
PYTHONPATH=. .venv/bin/python -m pipeline.run_pipeline > /tmp/run.log 2>&1; echo "exit=$?"
PYTHONPATH=. .venv/bin/python -c "
import json; d=json.load(open('predictions/health.json'))
print('status  :', d['status'])
print('degraded:', d.get('degraded'))
print('sources :', json.dumps(d.get('sources'), indent=1))
"
PYTHONPATH=. .venv/bin/python -m unittest pipeline.tests.test_health_provenance -v > /tmp/t6.log 2>&1; echo "exit=$?"
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests > /tmp/all.log 2>&1; echo "exit=$?"
```

Expected: `status` reads `degraded` on a run without odds or xG features — that is correct, not a regression. `exit=0` on both test runs.

- [ ] **Step 5: Commit**

```bash
git add pipeline/run_pipeline.py pipeline/tests/test_health_provenance.py predictions/health.json
git commit -m "feat(health): report the sources a run actually had, and derive status from them"
```

---

## Phase 0 exit criteria

Verify all of these before starting Phase 1:

```bash
cd /Users/tusk-jvb/dev/pl-prediction-engine
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests > /tmp/final.log 2>&1; echo "exit=$?"
PYTHONPATH=. .venv/bin/python -c "
import json
xp = json.load(open('predictions/fpl/xp_gw01.json'))
assert all(f.get('rate_source') for f in xp['fixtures']), 'a fixture has no rate_source'
assert 'market_blend' in {f['rate_source'] for f in xp['fixtures']}, 'nothing anchored'
p = xp['players'][0]
assert {'q10','q25','q50','q75','q90'} <= set(p), 'quartiles missing — glyph cannot draw'
h = json.load(open('predictions/health.json'))
assert 'sources' in h and h['status'] in {'healthy','degraded'}, 'health not derived'
led = json.load(open('predictions/forecast_ledger.json'))
assert 'rejected' in led, 'ledger does not report what it refused'
print('Phase 0 exit criteria: PASS')
"
```

**Not covered by this plan, deferred to their own plans:**
- The typed availability-claim parser (all 207 stored claims are `unparsed_news`, discarded before projections see them) — spec §3.2
- The free official FPL fields: `price_change_percent`, `events[].chip_plays`, transfer velocity, `can_select`, `scout_news_link`, `element-summary`, `pulse_id` rest-days — spec §3.4
- Deleting the FBref path and rewriting the Understat client — spec §3.6
- Rewriting `CLAUDE.md` — spec §3.7
- Phases 1 (field model / Wazza), 2 (six surfaces), 3 (write path)
