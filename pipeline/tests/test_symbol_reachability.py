"""
Is every public SYMBOL reached from something that runs?

`test_module_reachability.py` asks this question at module granularity and its own
docstring explains why a whole-package view is the only thing that can answer it. This
file exists because module granularity has a blind spot big enough to hide a subsystem.

## The case this was built from

`pipeline/decide/field.py` passes the module check. It is imported — once, at
`run_decide.py:29`, for two names:

    from pipeline.decide.field import REQUIRED_CALIBRATED_GAMEWEEKS, field_is_usable

Everything else in that module is unreached: `sample_rivals`, `score_field`,
`ownership_share`, `effective_ownership` and `FieldReport` — the entire rival-simulation
and calibration core, roughly 280 lines. `score_field` has no caller anywhere in
production, so the field's simulated scores are never produced, which is why
`run_agent._field_calibrated_gameweeks` ends in an unconditional `return 0` and the
weekly objective can never be selected.

One import made 280 unreached lines look wired. That is the defect this file catches.

## The criterion, and why it is this one

A symbol is unreached when it is referenced NOWHERE in production — not from another
module, and not from its own. The looser question ("is it referenced outside its own
module?") flags every module-level constant a module uses internally: 537 of 872 symbols,
which is noise. This criterion returns 52, and `field.py` is the largest cluster in it.

Attribute access counts as a reference, so `field.score_field(...)` and a bare
`score_field(...)` both count. That is deliberately generous: an unrelated object with a
matching attribute name can mask a real orphan. A guard that under-reports is worth
having; one that cries wolf gets an allowlist entry per line and stops meaning anything.

Tests do NOT count. A symbol exercised only by its own unit test is the exact shape of
every module in the sibling file's list: green tests over code nothing calls. Where that
is deliberate the entry goes in ALLOWED with a reason, which is the same bargain the
sibling file strikes.
"""
from __future__ import annotations

import ast
import collections
import pathlib
import unittest
from typing import Dict, List, Set, Tuple

PACKAGE = pathlib.Path(__file__).resolve().parent.parent

# ── The allowlist ────────────────────────────────────────────────────────────────
#
# `module: {symbol: reason}`. A reason has to say what the symbol is FOR and why nothing
# calls it, and "not yet examined" is an acceptable reason — it is a backlog marker made
# somewhere a reviewer will see it, which is the whole point. What is not acceptable is
# an unreached symbol that nobody has written a line about.

ALLOWED: Dict[str, Dict[str, str]] = {
    # ── Staged, with a written pre-registration ──────────────────────────────────
    #
    # `run_agent._field_calibrated_gameweeks`' docstring is the specification for
    # finishing this, and says exactly what is missing: "What is missing is the verdict
    # store, not the counter." Completing it means WIRING THE SIMULATION IN — a new Monte
    # Carlo over rival squads on every decision run — not plumbing, because `score_field`
    # has no caller and the scores it would verify are never produced. The gate needs six
    # consecutive calibrated gameweeks and one has settled; the only configured entry runs
    # `objective: "season"`, so `field_is_usable` is not consulted either.
    "pipeline.decide.field": {
        "FieldReport": "field model staged: see run_agent._field_calibrated_gameweeks",
        "score_field": "field model staged: no caller, so no scores are ever produced",
        "sample_rivals": "field model staged: rival simulation, never invoked",
        "ownership_share": "field model staged: input to sample_rivals",
        "effective_ownership": "field model staged: input to sample_rivals",
    },
    "pipeline.learning.field_observations": {
        "consecutive_calibrated": (
            "the counter the field gate would read. Exists and is tested; unreachable "
            "until the verdict store above exists to feed it"
        ),
    },

    # ── Remnants of the value-bet surface, which was cut ─────────────────────────
    #
    # These are deletion candidates, not standalone code. Grouped rather than deleted
    # here because removing a risk model is its own change with its own review, and
    # because `kelly.py` is the one place a staking rule is written down.
    "pipeline.risk.kelly": {
        "check_drawdown": "value-bet surface remnant — deletion candidate",
        "devig_edge": "value-bet surface remnant — deletion candidate",
        "find_value_bets_multi_match": "value-bet surface remnant — deletion candidate",
        "risk_of_ruin": "value-bet surface remnant — deletion candidate",
    },
    "pipeline.data.odds_api": {
        "PREFERRED_BOOKMAKERS": "value-bet surface remnant — deletion candidate",
        "build_odds_comparison": "value-bet surface remnant — deletion candidate",
        "find_best_odds": "value-bet surface remnant — deletion candidate",
    },
    "pipeline.data.football_data": {
        "REQUIRED_COLS": "not yet examined",
        "extract_odds_benchmark": "value-bet surface remnant — deletion candidate",
    },

    # ── Research harnesses, run by hand ──────────────────────────────────────────
    "pipeline.learning.backtest_decisions": {
        "run_strategy": "backtest harness, driven by its own tests and by hand",
        "sell_prices": "backtest harness helper",
        "strategy_agent": "backtest strategy, selected by name at the call site",
        "strategy_do_nothing": "backtest strategy, the null comparator",
        "strategy_greedy": "backtest strategy, the naive comparator",
    },

    # ── Not yet examined ─────────────────────────────────────────────────────────
    #
    # Each of these is a real question nobody has answered. They are here so the guard
    # can be switched on today rather than after an audit, and so the audit has a list.
    "pipeline.data.news_extract": {
        "RULED_OUT_MONTHS": "not yet examined",
        "RULED_OUT_SEASON": "not yet examined",
        "RULED_OUT_WEEKS": "not yet examined",
    },
    "pipeline.decide.milp": {
        "derive_ft_schedule": "not yet examined",
        "recompute_objective": "not yet examined",
    },
    "pipeline.learning.params": {
        "promote": "not yet examined — parameter promotion, possibly a manual path",
        "rollback": "not yet examined — parameter rollback, possibly a manual path",
    },
    "pipeline.learning.availability_evidence": {
        "claims_for_gameweek": "not yet examined",
        "digest_matches": "not yet examined",
    },
    "pipeline.learning.sensitivity": {
        "NotMeasurableError": "not yet examined",
        "interpret": "not yet examined",
    },
    "pipeline.data.referee_profiles": {
        "get_referee_for_upcoming": "not yet examined",
        "get_referee_multiplier": "not yet examined",
    },
    "pipeline.decide.plan_eval": {"reranked": "not yet examined"},
    "pipeline.learning.gates": {"evaluate": "not yet examined"},

    # ── Model classes with no production caller ──────────────────────────────────
    #
    # The two biggest single findings in this list, kept separate because they are not
    # leftovers of a cut surface: they are named parts of the modelling stack that
    # nothing constructs. Either the pipeline builds its ensemble and calibration some
    # other way — in which case these are twins that will drift — or a step is missing.
    # Answering that is its own investigation.
    "pipeline.models.ensemble": {
        "EnsemblePredictor": "not yet examined — a model class nothing constructs",
    },
    "pipeline.models.calibration": {
        "ProbabilityCalibrator": "not yet examined — a model class nothing constructs",
    },

    # ── A hand-maintained twin of a derived value ────────────────────────────────
    #
    # Same shape as `config.PL_TEAMS`, which was deleted for it: every live path derives
    # the mapping from FPL bootstrap via `update_fpl_team_map`, so this is a second list
    # of clubs that no code consults and no test checks against the real roster.
    "pipeline.data.team_mapping": {
        "FPL_TEAM_MAP": "hand-maintained twin of the bootstrap-derived map — deletion candidate",
    },

    # ── Not yet examined, one symbol each ────────────────────────────────────────
    "pipeline.data.fbref": {"fetch_fbref_match_stats": "not yet examined"},
    "pipeline.data.market_snapshots": {"last_before_kickoff": "not yet examined"},
    "pipeline.data.x_relevance": {"PATTERN_COUNT": "not yet examined"},
    "pipeline.data.x_scan": {
        "EXTRACT_JS": "not yet examined — sibling of EXTRACT_JS_PATH, which is read",
    },
    "pipeline.data.youtube": {"COST_SEARCH_LIST": "not yet examined — quota accounting"},
    "pipeline.fpl.artifacts": {"SCHEMA_DIR": "not yet examined"},
    "pipeline.fpl.autosub": {"SCORING_CHIPS": "not yet examined"},
    "pipeline.fpl.entry_api": {"fetch_entry": "not yet examined"},
    "pipeline.fpl.public_xp": {
        "notable": "not yet examined — the display view's 'worth showing first' ranking",
    },
    "pipeline.learning.deltas": {"DeltaError": "not yet examined — unraised error type"},
    "pipeline.learning.schedule": {"FINAL_SETTLEMENT_DELAY": "not yet examined"},
    "pipeline.learning.walk_forward": {
        "walk_forward": "not yet examined — the module's namesake entry point",
    },
    "pipeline.models.devig": {"apply_margin": "not yet examined"},
    "pipeline.models.player_events": {"RATE_COLUMNS": "not yet examined"},
}

# ── The scan ─────────────────────────────────────────────────────────────────────


def modules(*, tests: bool) -> List[pathlib.Path]:
    return [
        p for p in PACKAGE.rglob("*.py")
        if ("tests" in p.parts) is tests and "__pycache__" not in p.parts
    ]


def dotted(path: pathlib.Path) -> str:
    rel = path.relative_to(PACKAGE.parent).with_suffix("")
    parts = [p for p in rel.parts if p != "__init__"]
    return ".".join(parts)


def public_symbols(path: pathlib.Path) -> List[Tuple[str, int]]:
    """Top-level defs, classes and SCREAMING_CASE constants, excluding `_private`."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return []
    out: List[Tuple[str, int]] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if not node.name.startswith("_"):
                out.append((node.name, node.lineno))
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if (isinstance(target, ast.Name) and target.id.isupper()
                        and not target.id.startswith("_")):
                    out.append((target.id, node.lineno))
    return out


def referenced(path: pathlib.Path, definition_lines: Set[int]) -> collections.Counter:
    """
    Every name this file references, NOT counting the definitions themselves.

    A `def foo` is skipped so a function does not count as its own caller, and a
    module-level `NAME = ...` is skipped in `Store` context for the same reason — but a
    later read of `NAME` in the same module counts, which is what makes an internally
    used constant reachable.
    """
    names: collections.Counter = collections.Counter()
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return names
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(node, ast.Name):
            if (getattr(node, "lineno", None) in definition_lines
                    and isinstance(node.ctx, ast.Store)):
                continue
            names[node.id] += 1
        elif isinstance(node, ast.Attribute):
            names[node.attr] += 1
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                names[alias.name] += 1
    return names


def unreached() -> Dict[str, List[str]]:
    """`module -> [symbol]` for every public symbol production never mentions."""
    prod = modules(tests=False)
    defined = {p: public_symbols(p) for p in prod}
    used: collections.Counter = collections.Counter()
    for p in prod:
        used.update(referenced(p, {ln for _, ln in defined[p]}))
    out: Dict[str, List[str]] = {}
    for p, syms in defined.items():
        missing = sorted({name for name, _ in syms if used[name] == 0})
        if missing:
            out[dotted(p)] = missing
    return out


class TestEveryPublicSymbolIsReached(unittest.TestCase):
    def setUp(self):
        self.unreached = unreached()

    def test_the_scan_finds_symbols_at_all(self):
        # A scan that silently matched nothing would pass every assertion below.
        total = sum(len(public_symbols(p)) for p in modules(tests=False))
        self.assertGreater(total, 400, "the symbol scan is not seeing the package")

    def test_no_unreached_symbol_is_undeclared(self):
        undeclared = []
        for module, symbols in sorted(self.unreached.items()):
            allowed = ALLOWED.get(module, {})
            for symbol in symbols:
                if symbol not in allowed:
                    undeclared.append(f"{module}.{symbol}")
        self.assertEqual(
            undeclared, [],
            "these public symbols are referenced nowhere in production. Wire them up, "
            "delete them, or add them to ALLOWED with a reason — the third option is "
            "fine and is the point of the list.",
        )

    def test_every_allowance_carries_a_real_reason(self):
        thin = []
        for module, entries in ALLOWED.items():
            for symbol, reason in entries.items():
                if len(reason.strip()) < 12:
                    thin.append(f"{module}.{symbol}")
        self.assertEqual(thin, [], "an allowance needs a reason that says what it is for")

    def test_no_allowance_has_gone_stale(self):
        # The ratchet. A symbol that has since been wired up, or deleted, must leave the
        # list — otherwise the list stops describing the code and starts excusing it.
        stale = []
        for module, entries in sorted(ALLOWED.items()):
            actually = set(self.unreached.get(module, []))
            for symbol in sorted(entries):
                if symbol not in actually:
                    stale.append(f"{module}.{symbol}")
        self.assertEqual(
            stale, [],
            "these are allowlisted but no longer unreached — they were wired up or "
            "deleted, so remove the allowance",
        )

    def test_the_field_model_is_the_case_this_guards(self):
        # Pinned as the worked example, so a reader of a failure understands the shape.
        # `field.py` IS imported, which is why `test_module_reachability` passes on it.
        field = self.unreached.get("pipeline.decide.field", [])
        self.assertIn("score_field", field)
        self.assertIn("sample_rivals", field)


if __name__ == "__main__":
    unittest.main()
