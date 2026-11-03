# Pre-registration: the outfield h=0 start gate (gated fix B)

Written 2026-11-03, before any seal has been made with the gate active. Its git
timestamp is the evidence that this rule predates the outcomes it judges. Do not
edit the rule after the first active seal; add a dated note below it instead.

## What is being tested

Parameters:
- `minutes.h0_start_target_keep` (κ = 0.8).
- `minutes.h0_start_target_min_settled_gw` (10).

Once the predicted season has at least 10 settled gameweeks, an outfield
player's keep is κ·ρ^h at every horizon, h = 0 included. Before that, and for
keepers, keep is ρ^h as before.

Evidence so far:
- Archive 2024-26 at k11–38: simulated h=0 outfield start Brier −0.0015
  [−0.0017, −0.0012].
- No sealed out-of-sample evidence exists yet for the active regime.

## Population

- **Rows:** sealed forecast rows for outfield players (DEF, MID, FWD) from every
  seal whose header records `h0_start_gate.active == true`.
- **Strata:** use the RECORDED gate state, never the gameweek number. A seal
  with `active == false` (for example a slow `data_checked` that left 9 settled
  gameweeks at the GW11 seal) is not in the population. Report those seals
  separately.
- **Exclusions:** a seal without an `h0_start_gate` record is excluded, and
  the exclusion is reported.
- **Double gameweeks:** both fixture rows are included.

## Comparison

- **Treatment:** each row as sealed.
- **Counterfactual:** the same seal rebuilt offline with
  `minutes.h0_start_target_keep = 1.0` and everything else held fixed:
  - the frozen inputs under the seal's `frozen_inputs`;
  - the code at the sealing commit;
  - the seeds from `sim_params_gwNN.json`;
  - every other registry value.

  If fix A (the pooled outfield lineup draw) is live at the seal, it is live
  in both arms. Do not add a shadow κ = 1 field to the seal.
- **Δ:** treatment minus counterfactual. Negative is better.
- **Interval:** 95% percentile interval from a player-clustered bootstrap with
  B = 2000 resamples. Resample players, keeping all of a player's rows
  together.

## Metrics

**Primary**, ledger-scored with `pipeline/learning/scoring.py`
`BINARY_COMPONENTS`, outfield rows:
1. `p_60` Brier.
2. `p_appears` Brier.

**Secondary**, reconstructed (p_start is not sealed), outfield:
1. Start Brier overall.
2. Start Brier on the rotation subset: counterfactual h=0 p_start in
   [0.30, 0.85). This is where the always-on form failed: +0.0042 on sealed
   seals 3–7.
3. Nailed subset, counterfactual h=0 p_start ≥ 0.85: start bias, simulated
   minus realised.

## Decision rule

Only two looks are planned, so the error rate is not inflated by peeking.

**Look 1: after the first four active seals have settled** (nominally GW11–14).
- **Rollback** (set κ to 1.0, the OFF value) if EITHER:
  - the lower bound of Δ is above 0 for outfield `p_60` Brier; or
  - the lower bound of Δ is above 0 for rotation-subset start Brier.
- **Confirm** if no rollback trigger fires AND the upper bound of Δ is below 0
  for at least one primary metric.
- **Otherwise inconclusive:** keep κ = 0.8 and go to look 2.

Expected power at look 1 (inferred from seals 3–7, CI half-width about
0.0009): about ±0.0010. That makes an archive-sized gain (−0.0013 to −0.0015)
only marginally confirmable, so an inconclusive result is the likely outcome
and is not evidence of harm.

**Look 2: after the first eight active seals have settled** (nominally GW11–18).
- **Rollback** and **Confirm** use the same tests as look 1.
- **Otherwise:** keep κ only if the point estimate of Δ is ≤ 0 on BOTH
  primary metrics. Else roll back.

**Safety check after every active seal.** This check can only roll back,
never confirm. Roll back immediately if the 99% interval for rotation-subset
start Brier lies wholly above 0. It is stricter than the planned looks
because it is taken repeatedly.

**Rollback mechanics:** set the registry value of κ to 1.0, which is bit for
bit the pre-gate behaviour. Record the decision, the numbers and the seals
used below this line.

## What would invalidate this rule

If any of the following change before look 2, the active seals scored so far
stay valid evidence for the old configuration. Restart the count for the new
one.
- ρ (`minutes.horizon_start_target_rho`) is refit.
- The target half-life is refit.
- The threshold is changed.
- Bench credit β lands.

The registry entry for κ says it must be refit jointly with any of them.

## Decisions

(none yet)
