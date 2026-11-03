# Pre-registration: the outfield h=0 start gate (gated fix B)

Written 2026-11-03, before any seal has been made with the gate active. The git
timestamp of the commit that adds this file is the evidence that the rule
predates the outcomes it judges. Do not edit the rule after the first scored
seal; add a dated note under **Decisions** instead.

## Status at landing: shipped OFF

The gate landed on 2026-11-03 with `minutes.h0_start_target_keep` = **1.0**.
That was the owner's decision, because fix A has not been built.
- From GW11 the gate opens and every seal records `active: true`.
- At κ = 1.0 that record changes nothing: `kappa_effective` is 1.0 and every
  sealed row is bit for bit what it would have been without the gate.
- **The clock starts at the switch, not at this landing.** The rule below
  counts only seals made after κ is switched to 0.8. The owner makes that
  switch in fix A's release. Seals made at κ = 1.0 are not in the population
  and do not count toward either look.
- Record the switching commit under **Decisions** when it lands.

## What is being tested

Parameters:
- `minutes.h0_start_target_keep` (κ = 0.8).
- `minutes.h0_start_target_min_settled_gw` (10).

Once the predicted season has at least 10 settled gameweeks, an outfield
player's keep is κ·ρ^h at every horizon, h = 0 included. Before that, and for
keepers, keep is ρ^h as before.

Evidence so far:
- Archive 2024-26 at k11–38, measured on fix A's pooled lineup draw:
  simulated h=0 outfield start Brier −0.0015 [−0.0017, −0.0012].
- Without fix A, sealed h=0 start is −0.0008 [−0.0021, +0.0006].
- No sealed out-of-sample evidence exists for the active regime.

**Scope: h=0 only.** κ also scales h = 1–5. Those weeks are not scored by
this rule, because a horizon forecast is superseded at the next deadline and
only the h=0 row is sealed.

## Population

- **Rows:** sealed forecast rows for outfield players (DEF, MID, FWD) from every
  seal whose header records `h0_start_gate.active == true` AND
  `h0_start_gate.kappa_effective < 1`. A seal with `active` true at
  `kappa_effective` 1.0 was made while κ was shipped off. It is not in the
  population and starts no count.
- **Strata:** stratify on the RECORDED gate state, never on the gameweek number.
  - A seal with `active == false` is not in the population. One example is a
    slow `data_checked` that left 9 settled gameweeks at the GW11 seal. Report
    such seals separately.
  - A seal with no `h0_start_gate` record is excluded, and the exclusion is
    reported.
- **Fix A stratum.** Whether fix A (the pooled outfield lineup draw) is live at
  a seal is read from the sealing commit. Each configuration has its own count
  of scored seals (seals in the population above):
  - **A + B** is the configuration the evidence above supports, and the only
    one this rule can confirm.
  - **B without A** is reported, and the rollback tests apply to it at the
    same looks, but it can never be confirmed. It arises only if κ is ever
    switched on without A, which is not the plan of record.
  - If A lands after the first scored seal, the A + B count starts at A's
    first scored seal.
- **Double gameweeks:** both fixture rows are included.

## Comparison

Both arms are offline rebuilds. The sealed numbers are not compared directly,
so the difference cannot mix κ with drift in inputs fetched later.

**Inputs for one seal** (identical in both arms):
- The code at the sealing commit. That is the commit that added the
  gameweek's `predictions/fpl/ledger/gwNN/forecast.jsonl`
  (`git log --diff-filter=A -- <path>`); the header carries `github_run_id`
  but no commit hash.
- The bootstrap frozen under the header's `frozen_inputs`.
- The current-season rows, refetched from FPL's settled `event/{gw}/live/`
  payloads. The gameweeks are the events the frozen bootstrap marks
  `finished` AND `data_checked`, which is the set the seal read. Their
  distinct count must equal the header's `h0_start_gate.settled_gameweeks`.
- The claim history and evidence at the sealing commit.
- The committed archive.
- The seed `stable_seed_entropy(season, gw)` (`run_agent.py`).

**Arms:**
- **Treatment:** κ as recorded in `h0_start_gate.kappa_effective`.
- **Counterfactual:** `minutes.h0_start_target_keep = 1.0`, everything else
  identical.

**Reproduction gate.** The rebuilt treatment arm must reproduce the sealed
`p_appears` and `p_60` of every outfield row to 1e-9. A seal that fails is
excluded and reported with its largest discrepancy. Never score a seal whose
inputs could not be rebuilt.

**Δ:** treatment minus counterfactual. Negative is better.

**Intervals:** percentile intervals from a player-clustered bootstrap,
B = 2000 resamples. Resample players, keeping all of a player's rows across
seals together.

## Metrics

Outfield rows only. Probabilities are scored against the settled outcome rows
(`pipeline/learning/outcomes.py`), using
`pipeline/learning/scoring.py` `BINARY_COMPONENTS` where they apply.

**Confirmatory (one metric):** `p_60` Brier. This is the sealed field with
the largest archive effect: 60+ −0.0013 [−0.0015, −0.0011].

**Secondary:**
1. `p_appears` Brier.
2. **Start Brier.** The forecast is the SIMULATED start rate: the share of
   simulation draws in which the player started, from the rebuilt arm. The
   outcome is `starts > 0`. This is the study's headline quantity.
3. **Rotation subset start Brier.** The rotation subset is players whose
   counterfactual h=0 MARGINAL start probability lies in [0.30, 0.85). That
   probability is `RoleProbabilities.p_start` after the availability multiply,
   which is the study's definition. This subset is where the always-on form
   failed: +0.0042 on sealed seals 3–7.
4. **Nailed subset bias.** Nailed means counterfactual marginal p_start
   ≥ 0.85. The bias is simulated start rate minus realised.

## Decision rule

Two planned looks. Alpha is split between them, 99% at look 1 and 95% at
look 2, so confirming early takes stronger evidence. Rollback uses several
tests on purpose, because rollback (κ = 1.0) is the safe default and a false
rollback costs only the archive gain.

**Look 1: after four scored seals in the A + B stratum have settled**
(the first four after the switch to 0.8).
- **Rollback** (set κ to 1.0) if EITHER 95% interval lies wholly above 0:
  - Δ outfield `p_60` Brier;
  - Δ rotation-subset start Brier.
- **Confirm** if no rollback test fires AND the 99% interval of Δ `p_60` Brier
  lies wholly below 0.
- **Otherwise inconclusive:** keep κ = 0.8 and go to look 2.

Expected power at look 1 is inferred from seals 3–7, whose CI half-width was
about 0.0009. A start-Brier-sized gain of −0.0013 to −0.0015 is only
marginally detectable, so an inconclusive result is the likely outcome and is
not evidence of harm.

**Look 2: after eight scored seals in the A + B stratum have settled**
(the first eight after the switch).
- **Rollback:** the same tests as look 1.
- **Confirm** if the 95% interval of Δ `p_60` Brier lies wholly below 0.
- **Otherwise:** keep κ only if the point estimates of Δ `p_60` Brier and
  Δ `p_appears` Brier are both ≤ 0. Else roll back.

**Safety check after every scored seal**, including B without A. It can only
roll back. Roll back immediately if the 99% interval of Δ rotation-subset start
Brier lies wholly above 0.

**Rollback mechanics:** set the registry value of κ to 1.0, which is bit for
bit the pre-gate behaviour. Record the decision, the numbers and the seals
used under **Decisions**.

## What would invalidate this rule

Seals scored before any of these changes remain evidence for the configuration
they were sealed under. Count the new configuration from zero.
- κ's value changes.
- ρ (`minutes.horizon_start_target_rho`) is refit.
- The target half-life is refit.
- The threshold is changed.
- Bench credit β lands. The registry entry for κ says κ must then be refit
  jointly.
- Fix A lands after the first scored seal.

## Known limitation

The current-season rows are not frozen with the seal. The reproduction gate
detects any that changed after settling but cannot repair them. Freezing them
beside the bootstrap is a seal-path change for seal-warden, and is not part
of this change.

## Decisions

(none yet)
