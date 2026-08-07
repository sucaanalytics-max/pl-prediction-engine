# Independent FPL projection system

## Objective

Replace the decision value of an FPLReview subscription with an independently
owned, transparent and testable system. FPLReview exports may be used during a
short shadow period as a comparator. They must never become model training data,
because that would make the replacement permanently dependent on the service it
is meant to replace.

## What is publicly established

FPLReview describes a layered model rather than one formula:

1. Team attacking and defensive strength informed by betting markets and
   historical/contextual data.
2. Player goal, assist, clean-sheet and other event probability distributions.
3. Expected minutes averaged over many rotation, injury and tactical scenarios.
4. FPL scoring applied to the joint event distribution to produce expected
   points and probability data.
5. A multi-gameweek solver with time decay, free-transfer value, bank value,
   transfer hits, ownership/risk controls and chip scenarios.
6. Sensitivity analysis that perturbs ratings, minutes and solver settings.

The exact proprietary features, fitted coefficients, market-normalisation
method and scenario generator are not public. They should be estimated and
validated independently, not guessed and presented as an exact clone.

## Observable controls confirmed in the premium app

- The default team-strength source was 100% Markets; an Elevenify blend was
  available as an alternative.
- Team strength was displayed as expected goals for, expected goals against and
  goal difference.
- Player projections exposed fixture-level expected minutes, points and elite
  ownership over ten gameweeks.
- Changing expected minutes is intended to update points immediately.
- Current premium values differed slightly from the earlier CSV export,
  confirming that projections are dynamic rather than a season-long table.

## Mechanism we will own

### 1. Fixture state

For each fixture, estimate home and away scoring intensities. The current engine
uses the Dixon-Coles posterior first and archive-derived team strengths as a
fallback. The next improvement is a no-vig market anchor derived from 1X2 and
goal-total prices, blended with the statistical posterior according to measured
out-of-sample performance.

### 2. Player opportunity

Estimate a shrunk distribution over three roles: starts, appears from the bench,
or is unused. Conditional minutes and the probability of reaching 60 minutes
are modelled separately. Current availability, recency, evidence weight and
horizon uncertainty are explicit. This is superior to multiplying a per-90
projection by expected minutes, because appearance points and the 60-minute
clean-sheet threshold are non-linear.

### 3. Player event shares

Use recency-weighted and position-shrunk xG/xA rates to allocate the team's drawn
goals to players who are on the pitch. Penalty takers receive designated penalty
weight. Assists are child events of goals and cannot be awarded to the scorer.
Saves, cards and defensive contributions are drawn from exposure-scaled rates.

### 4. Joint FPL simulation

Simulate the match score, goal times, player intervals and player events jointly.
Apply the signed 2026-27 FPL scoring rules to every draw. This yields expected
points, expected minutes, goal/clean-sheet probabilities, uncertainty, quantiles
and right-tail probabilities. Joint draws also support correct autosubs,
vice-captaincy and correlated attacking returns.

### 5. Decision solver

Optimise legal squads and line-ups over six gameweeks with static-price caveats,
free-transfer accrual, exact hit costs, budget, selling-price rules, club limits,
formations and captaincy. Evaluate only the immediate action as a commitment;
future transfers remain provisional because injuries, prices and projections
will change.

### 6. Evidence and learning

Seal every forecast before the deadline, settle it only against confirmed FPL
outcomes, and evaluate calibration by component. Promote a parameter change only
when it improves held-out data and passes bounds, sample-size and regression
gates. Never refit staking parameters through the FPL learning loop.

## Gap assessment

| Layer | Current state | Remaining work |
| --- | --- | --- |
| FPL rules and scoring | Implemented and contract-tested | Monitor live rule drift |
| Minutes/rotation | Empirical-Bayes, recency and horizon decay implemented | Automated injury, presser and predicted-lineup evidence |
| Player events | Joint scorer/assister allocation and shrunk rates implemented | Tactical role and set-piece hierarchy updates; richer bonus/BPS model |
| Fixture strength | Dixon-Coles plus archive fallback | Market-implied goal-rate anchor and calibrated blending |
| Expected points | Joint Monte Carlo with uncertainty implemented | Validate live coverage and late-update freshness |
| Multi-week solver | Six-week MILP implemented | Scenario sensitivity, chip search and price-change uncertainty |
| Validation | Walk-forward tests and sealed ledger implemented | Four-to-six live-GW shadow study versus premium and realised outcomes |

## Red-team findings before live use

1. The automated decision agent is configured for two legacy entry IDs
   (`2561567` and `2561099`), not the portal owner's entry `20945`. The public
   portal and the Python decision agent therefore do not currently describe the
   same manager.
2. The committed message feed contains a synthetic-looking GW7 decision dated
   before GW1 of the 2026-27 season. It must be quarantined or regenerated before
   the feed can be treated as operational evidence.
3. Future-week expected points are currently simulated with current role
   probabilities and then multiplied by a horizon availability factor. That is
   a useful conservative approximation, but it is not the correct non-linear
   treatment of expected minutes. The factor must instead alter the start,
   substitute and unused probabilities before simulation.
4. Immediate projections prefer the statistical Dixon-Coles posterior. The
   premium app currently defaults to market-derived team strength, so the owned
   model still lacks its most important independent external anchor.
5. FPL status is the only live availability source in the production model.
   Press-conference, injury and predicted-lineup evidence is not yet ingested,
   and late team news is likely to dominate projection error near deadlines.

These are release blockers for claiming subscription replacement, not reasons
to discard the current model. The underlying simulation and decision machinery
is already present; the blockers are identity, freshness, anchoring and live
validation.

## Shadow-period scorecard

Run the owned projections and export FPLReview at the same pre-deadline timestamp
for four to six gameweeks. The parity command is:

```bash
PYTHONPATH=. .venv/bin/python -m pipeline.validation.fplreview_benchmark \
  frontend/data/fplreview-projections.json \
  predictions/fpl/xp_gw1.json predictions/fpl/xp_gw2.json
```

The comparator report measures expected-points MAE and bias, rank correlation,
top-player overlap and expected-minutes MAE. It measures similarity, not truth.

Subscription replacement requires both parts below:

1. **Operational independence:** the owned pipeline refreshes automatically,
   covers the player pool, records source freshness, and produces projections,
   captaincy and transfer plans before every deadline without a premium export.
2. **Predictive evidence:** across at least four live gameweeks, the sealed owned
   forecasts are no worse than the premium comparator on realised points and
   component calibration within sampling uncertainty. Rank parity is a useful
   diagnostic, but disagreement is not an error when the owned forecast is more
   accurate.

Until both conditions hold, cancelling would be a hope-based decision rather
than a validated one.
