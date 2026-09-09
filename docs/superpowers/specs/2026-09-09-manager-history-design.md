# Manager history — what your own season has actually cost you

**Date:** 2026-09-09
**Entry:** 20945 (the one entry this dashboard serves)
**Status:** design, approved in outline; not yet implemented

## What this is

A retrospective ledger of the manager's own decisions and what they returned:
per-gameweek points against the field, bench waste, captaincy, auto-subs, rank
and value — and a transfer ledger recording each transfer's points delta in the
gameweek it was made and over the following 2, 3 and 4 gameweeks.

## What this is not

**Not a live tracker.** The 2026-08-23 product decision put live points, live
rank, EO and price changes out of scope, because they need the uncalibrated
field model. This reads only gameweeks that are `finished && data_checked`, so
it can never become an in-gameweek surface by accident.

**Not a verdict.** `DecisionReview` already occupies `/review`, and it judges
*foreseeability* against the sealed forecast — it goes to real lengths not to
manufacture blame, which is why `indistinguishable` exists as a third verdict.
This ledger judges *outcome*, which is a different question with a different
epistemic status. Rendered next to each other without separation, a reader
collapses the two, and "was the call wrong or merely unlucky" — the question the
page was built to keep open — silently closes.

**So the outcome ledger renders as accounting, not as judgement: no good/bad
colouring on transfer deltas.** A −3 is a number, not a reproach.

## Verified before designing

Measured 2026-09-09 against the live API and this repo. Recorded because each
one removes an assumption the design would otherwise rest on.

1. **No authentication is required.** `/entry/{id}/history/`,
   `/entry/{id}/transfers/`, `/entry/{id}/event/{gw}/picks/` and
   `/event/{gw}/live/` all return 200 with `credentials: 'omit'`. Only
   `/my-team/{id}/` needs a session (403 without), and that is the pre-deadline
   squad, which `/capture` already solves. **There is no credential handling in
   this feature at all.**

2. **`picks[].multiplier` reflects the post-auto-sub reality**, not the lineup
   as submitted. Proven on GW1: Thomas was auto-subbed in for Palestra, and no
   pick with `multiplier > 0` had zero minutes — Palestra already carried
   multiplier 0. This is what makes "effective points" well defined.

3. **The reconciliation identity holds exactly** for GW1–3:

   ```
   Σ(multiplier × points) − event_transfers_cost === entry_history.points
   ```

   **Not fully verified:** every settled gameweek so far had
   `event_transfers_cost = 0`, so the subtraction term is inferred from FPL's
   rules rather than observed. The producer asserts the identity, so the first
   hit taken will confirm or refute it.

4. **The season is nearly empty.** Three gameweeks settled; **one transfer**
   (GW3, Maguire out / Thiaw in, both £5.0m, no hit); zero chips; zero hits.
   Same-gameweek delta **−3** (Thiaw −1, Maguire +2). Every multi-gameweek
   window is unpopulated until the GW4 deadline on 2026-09-12.

5. **Bench waste dominates.** 2 + 13 + 12 = **27 points** across three
   gameweeks, roughly nine times the entire transfer effect. Points against
   average: −6, +28, −13, season **+9** (191 vs 182).

6. **`predictions/fpl/manager_history.json` is writable.** Checked against both
   forbid patterns by running them: allowed by `pipeline.yml`
   (`^predictions/fpl/(ledger|decision|hub)`) and by `fpl_agent.yml`. The check
   is not vacuous — `frontend/public/predictions/accuracy.json` is blocked for
   the agent.

7. **The seal ledger covers only 2 gameweeks.** Settlement is therefore not a
   dependable trigger, and this producer deliberately depends on no seal.

## Decisions taken

**Attribution: both effective and raw, side by side.**

- *Effective* = `Σ (raw_in − raw_out) × multiplier_in`, where `multiplier_in` is
  the slot the incoming player occupied that gameweek. Benched is ×0 — the
  transfer genuinely earned nothing that week. Captained is ×2. This holds the
  lineup fixed and swaps one player, which is the true counterfactual for what
  reached the score.
- *Raw* = `Σ (raw_in − raw_out)`, ignoring lineup. Measures the scouting call on
  its own merits.
- **Their difference is the third metric**: transfer value given back through
  lineup decisions. It is why both are kept rather than one chosen.

**Stale windows: fixed lengths, pollution flagged.**

Windows stay at same-GW / +2 / +3 / +4 so transfers remain comparable. The
moment either player leaves the squad the window is marked **polluted**, and
polluted windows are excluded from season aggregates and reported separately —
never blended in as though clean. This mirrors `indistinguishable`: a third
state instead of a forced answer.

**Multi-transfer gameweeks get a basket row.**

Pairing each `element_in` with each `element_out` is a fiction FPL's list
implies but does not mean; with three transfers the pairing is arbitrary, and so
is any per-transfer share of the hit. The ledger therefore also reports, per
gameweek, all that week's transfers combined against that week's total hit. With
one transfer the basket equals the transfer; from three onwards it is the only
honest number.

## Metrics

Split by what the data can currently support. The distinction is not cosmetic:
the first group has three gameweeks behind it and the second has almost nothing,
so a page that gives them equal visual weight will lead with a −3 while 27
points sit unmentioned. **The surface orders findings by magnitude.**

**Measurable today**

| Metric | Definition | Now |
|---|---|---|
| Bench waste | `points_on_bench`, per GW and cumulative | 2, 13, 12 → **27** |
| Points vs average | `points − average_entry_score` | −6, +28, −13 → **+9** |
| Captaincy return | captain points × multiplier, vs best-in-XI and best-in-15 | — |
| Auto-sub rescue | Σ `points_gained` | GW1 recovered Palestra's blank |
| Rank trajectory | `overall_rank` per GW | 6.12m → 1.67m → 3.43m |
| Squad value | `value + bank` | 100.0 → 99.9 |
| Hit spend | Σ `event_transfers_cost` | £0 |

**Accrues — structurally correct, currently unpopulated**

Per transfer: effective and raw delta at same-GW / +2 / +3 / +4, the gap between
them, pollution flag, and hit payback. Per gameweek: the basket row. Season:
aggregates over clean windows only, withheld with a stated reason until enough
observations exist.

## Architecture

**Approach: the pipeline writes facts, the frontend computes verdicts.**

Facts need fetching and sealing; windows are a presentation choice. Keeping the
window arithmetic in TypeScript means changing 2/3/4 to 1/3/6, or adding a
clean-only toggle, costs no pipeline run and no commit. It also puts the
withhold-until-enough-observations rule beside `decision-review.ts`, which
already solves that problem, instead of growing a second implementation of it in
Python.

### Producer — `pipeline/fpl/manager_history.py`

A standalone module invoked as `python -m pipeline.fpl.manager_history`, added
to `fpl_agent.yml` as its own step after `run_agent` and before the commit step.

**It must NOT become a gate in `pipeline/learning/schedule.py`.** That gate
order is load-bearing — `MISSED_SEAL` must stay last and `PROJECTION_WINDOW`
must stay after it, both pinned by tests — and a new gate risks a livelock that
costs one of 38 irrecoverable observations a season. This producer is
independent of the seal machinery and stays independent of its scheduler.

Reuses what exists: `entry_api.fetch_history` / `fetch_transfers` /
`fetch_picks`, and `outcomes.parse_event_live`. Live payloads go through the
caching helper in `pipeline/data/fpl_api.py` — `entry_api._get` is plain
`urllib` with no cache, and uncached this is ~38 fetches a season.

Idempotent: it early-exits without rewriting when no new gameweek has settled,
so the hourly agent tick is nearly free and the file only churns when it should.

### Artifact — `frontend/public/predictions/fpl/manager_history.json`

Facts only.

```
schema_version, generated_at, entry_id, settled_through

gameweeks[]:
  event, points, gross_points, transfer_cost, transfers_made,
  bench_points, average_entry_score, highest_score,
  rank, overall_rank, value, bank, chip,
  captain { element, multiplier, points },
  auto_subs[] { element_in, element_out, points_gained },
  picks[] { element, multiplier, points, minutes }

transfers[]:
  event, time, element_in, element_in_cost, element_out, element_out_cost,
  in_points_by_gw   { gw: raw points }      # every settled gw since the transfer
  out_points_by_gw  { gw: raw points }
  in_multiplier_by_gw { gw: 0 | 1 | 2 | 3 | null }
```

**`in_held_through` was specified here and deliberately dropped during
implementation.** It is fully derivable — a `null` in `in_multiplier_by_gw`
already means the player had left the squad — and two encodings of one fact
drift apart. Pollution is computed in the frontend from the multiplier map alone.

**Absent and `null` mean different things, everywhere in this artifact.** A
gameweek **absent** from a by-gw map has not settled yet. A gameweek present
with `in_multiplier_by_gw = null` has settled, but the incoming player was no
longer in the squad — which is exactly the pollution signal. Collapsing the two
would make "not yet played" indistinguishable from "no longer relevant", and
both would silently read as zero.

`auto_subs[].points_gained` is the substitute's realised points × the multiplier
he inherited, which is what the auto-sub actually recovered — not the difference
between the two players, since the player subbed out scored nothing by
definition.

The frontend derives effective delta, raw delta, pollution and aggregates from
these. Nothing pre-computes a window.

### Narrower — `frontend/lib/data/narrow-manager-history.ts`

Runtime narrowing, never `as T` (rule 4), built from `check.ts` helpers, owning
its own payload interfaces the way `narrow-fpl.ts` does.

### Registry entry

`Descriptor` with `owner: "agent"`, `producedAtOf` reading `generated_at`, and
`freshnessBudgetMs = 8 days`.

Eight days, not hours: this file only changes when a gameweek settles, and
gameweeks are ~7 days apart. A budget tuned to the hourly agent tick would mark
it stale for six days out of every seven while it was perfectly correct —
training the reader to ignore the staleness chip, which then fails to warn when
it matters. Eight days flags a genuinely missed settlement and nothing else.
The GW5→GW6 gap this season is longer (2026-09-18 to 2026-10-10, an
international break), so that one window will legitimately trip the chip; that
is the correct reading, since the artifact really will be a month old.

### Surface — extend `/review`

No ninth route. The 2026-08-23 decision was "superseded routes deleted and
410'd, not kept for comparison", and unchecked surface growth is how this
frontend reached 28 routes before being cut back to 8. `/review` is already the
manager's-own-subject page: post-hoc, last in the masthead, deliberately without
a deadline clock.

Rendered below `DecisionReview`, under its own heading, visually separated per
"not a verdict" above.

## Ordering constraint

**`paths.test.ts` fails a registry path that no Python module writes.** It greps
`pipeline/**/*.py` (excluding `/tests/`) for the literal filename. So
`manager_history.py`, containing the literal string `manager_history.json`, must
land **before or in the same commit as** the registry entry. Never after.

## Error handling

- **The reconciliation identity is an assertion.** If
  `Σ(mult × pts) − transfer_cost ≠ entry_history.points` for any settled
  gameweek, the producer raises and publishes nothing. A plausible wrong number
  here is worse than an absent one, because every derived metric inherits it.
- **Unsettled gameweeks are skipped, not estimated.** `finished && data_checked`
  or it does not exist.
- **Aggregates are withheld, not zeroed,** until enough clean observations
  exist, and the payload states in its own words why — as `decision-review.ts`
  does with `aggregateReason`. With n=1 transfer and no completed window, the
  transfer section will say it is not yet measurable. That is the correct
  output, not a failure.
- **A missing window is `null`, never 0.** "Not yet played" and "scored nothing"
  must never render alike.

## Testing

- Producer against a recorded payload, including a gameweek with auto-subs.
- The reconciliation identity over every settled gameweek.
- Narrower unit tests, plus `dead-reads` agreement between the writer's field
  names and the reader's.
- Window arithmetic: effective vs raw, pollution, the basket rule, and the
  withheld-aggregate path.
- A regression pinning that a benched incoming player yields effective 0 and
  non-zero raw — the case that distinguishes the two definitions.

## Out of scope

Effective ownership and template distance (needs league-wide fetches, thin value
for one manager); chip-timing analysis (no chips played); mini-league
comparison; anything in-gameweek.
