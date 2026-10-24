"""
The per-fixture value-bet simulation: blend the goal rates, draw the match,
derive the markets. One function, shared by ``run_pipeline`` Step 9 and by any
offline replay, so a replay exercises exactly the seeded path production runs.

## Why this exists

Identical offline replays of the GW8 card (2026-10-25, 5,000 simulations, the
CI setting) moved 1X2 and totals probabilities by 1-2pp and flipped 1-2 of
roughly 8 value bets. The pipeline did seed ``np.random`` per fixture, but
``simulate_from_posterior`` called ``sample_dixon_coles`` with no Generator, and
that fell back to ``np.random.default_rng()`` — fresh OS entropy every call. With
the scoreline draw unseeded, nothing downstream of it could be reproduced, and a
model change could not be told apart from noise.

Every random draw on this path now comes from an explicit Generator derived from
the fixture. This module never touches numpy's legacy global state; a test
asserts that.

## Seed design: common random numbers, not an input hash

The fixture seed is ``SeedSequence(base, spawn_key=(sha256(match_id),))`` and
deliberately does NOT include the model inputs (the blended rates, the
posterior). Two designs were on the table:

* **Input hash** — seed from match_id plus a hash of the inputs. Unchanged
  inputs reproduce, changed inputs re-draw. But a re-draw is exactly the problem:
  comparing model A with model B then differences two INDEPENDENT noise
  realisations, so the comparison carries ``sqrt(2)`` times the single-run MC
  error (about 1pp on a 1X2 probability at 5,000 sims) on top of the real
  effect. That is the noise this change exists to remove.
* **Common random numbers (chosen)** — seed from match_id only. Unchanged inputs
  still reproduce bit-for-bit, and a changed input reuses the same uniforms, so
  the difference between two runs is the model's effect alone. The scoreline is
  drawn by inverse CDF with one uniform per simulation (``sample_dixon_coles``),
  so a higher home rate moves individual draws monotonically rather than
  reshuffling them, and each component has its own child stream (posterior
  indices, rho, scorelines, half-time, corners, cards) so a change in one does
  not shift the draws of the others. (Since rho was paired to the posterior
  draw of lambda and mu, the rho stream is still spawned but unused, so the
  other five keep their identity.)

Neither design reduces the Monte Carlo error itself: a fixed seed is a fixed
draw of noise, so a published probability is still ``p_hat`` with standard error
``sqrt(p(1-p)/n)``. Determinism makes the error stable, not smaller.
``PIPELINE_VERSION`` is no longer in the seed for the same CRN reason; the base
seed in ``PARAM_REGISTRY["simulation.value_path_seed"]`` is the one knob for
re-drawing.
"""
import hashlib
import logging
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

import numpy as np

from pipeline.config import PARAM_REGISTRY

logger = logging.getLogger(__name__)

#: Domain separator, so this path's seeds cannot collide with another stream
#: that happens to hash the same match_id (gameweek_sim hashes the bare id).
VALUE_PATH_DOMAIN = "value_path"

#: Goal rates used when no model produced any, kept from run_pipeline.
DEFAULT_RATES = (1.4, 1.1)


def value_path_base_seed() -> int:
    """The configured base entropy. Tier C: human-set, never refit."""
    return int(PARAM_REGISTRY["simulation.value_path_seed"]["value"])


def fixture_seed_sequence(
    match_id: str, base_seed: Optional[int] = None
) -> np.random.SeedSequence:
    """
    The SeedSequence for one fixture's value-bet simulation.

    sha256 rather than ``hash``: Python's built-in hash is salted per process,
    which would look deterministic and not be.
    """
    base = value_path_base_seed() if base_seed is None else int(base_seed)
    digest = hashlib.sha256(f"{VALUE_PATH_DOMAIN}:{match_id}".encode("utf-8")).digest()
    return np.random.SeedSequence(
        entropy=base, spawn_key=(int.from_bytes(digest[:8], "big"),)
    )


def fixture_rng(match_id: str, base_seed: Optional[int] = None) -> np.random.Generator:
    """A fresh Generator for one fixture. Same arguments, same draws."""
    return np.random.default_rng(fixture_seed_sequence(match_id, base_seed))


@dataclass
class FixtureSimulation:
    markets: Dict[str, Any]
    lambda_h: float
    mu_a: float
    #: Per-model (lambda, mu) that entered the blend, in blend order.
    model_lambdas: Dict[str, Tuple[float, float]]
    #: True when the scoreline was drawn from the Dixon-Coles posterior.
    from_posterior: bool


def simulate_fixture(
    simulator,
    *,
    match_id: str,
    home: str,
    away: str,
    dc_model,
    other_lambdas: Mapping[str, Tuple[float, float]],
    weights: Mapping[str, float],
    sim_kwargs: Optional[Mapping[str, Any]] = None,
    rng: Optional[np.random.Generator] = None,
) -> FixtureSimulation:
    """
    Blend, simulate and derive markets for one fixture, reproducibly.

    ``other_lambdas`` are the non-DC models' point rates (XGBoost, PenaltyBlog),
    in the order they should enter the blend; Dixon-Coles always enters first,
    which is the order run_pipeline has always summed in. ``rng`` defaults to
    :func:`fixture_rng` of ``match_id``; pass one only to override the seed
    (e.g. to measure Monte Carlo error across seeds).

    The DC posterior's relative uncertainty is kept and recentred on the
    blended rates, and ``derive_all_markets`` is untouched. One semantic change
    from the inline code this replaced: rho is paired to the same posterior draw
    as each (lambda, mu) (``get_paired_posterior_samples`` with
    ``rho_paired=True``) rather than drawn independently from its marginal.
    Measured on the GW8 card (2026-10-25): the posterior correlation between
    rho and intercept / home_adv / log-rates is |r| <= 0.07, the exact (no-MC)
    shift in any 1X2, O/U 1.5 or BTTS probability is <= 0.013pp (O/U 2.5 and
    3.5 cannot move: tau only redistributes mass among 0-0, 1-0, 0-1, 1-1), and
    that is ~50x below the 5,000-sim MC standard deviation. A correctness fix,
    not a re-tune.
    """
    generator = rng if rng is not None else fixture_rng(match_id)
    posterior_rng, simulation_rng = generator.spawn(2)
    sim_kwargs = dict(sim_kwargs or {})

    lambda_h, mu_a = DEFAULT_RATES
    dc_lam_samples = dc_mu_samples = dc_rho_samples = None

    if dc_model is not None:
        try:
            # rho is the whole reason to prefer Dixon-Coles over independent
            # Poisson, and it is taken from the SAME posterior draw as each
            # (lambda, mu): the predictive integrates over the joint posterior,
            # not the product of its marginals. The draw indices consume
            # posterior_rng exactly as get_lambda_mu_samples always has, so
            # lambda and mu are unchanged by the pairing.
            dc_lam_samples, dc_mu_samples, dc_rho_samples = (
                dc_model.get_paired_posterior_samples(
                    home, away, simulator.n_sims, rng=posterior_rng
                )
            )
            lambda_h = float(np.mean(dc_lam_samples))
            mu_a = float(np.mean(dc_mu_samples))
        except Exception as e:
            logger.warning(f"  DC prediction failed for {home} vs {away}: {e}")
            dc_lam_samples = dc_mu_samples = dc_rho_samples = None

    model_lambdas: Dict[str, Tuple[float, float]] = {}
    if dc_lam_samples is not None and dc_mu_samples is not None:
        model_lambdas["dixon_coles"] = (lambda_h, mu_a)
    for name, rates in other_lambdas.items():
        model_lambdas[name] = rates

    total_w = sum(weights.get(m, 0) for m in model_lambdas)
    if total_w > 0 and len(model_lambdas) > 0:
        lambda_h = sum(weights.get(m, 0) * lam for m, (lam, _) in model_lambdas.items()) / total_w
        mu_a = sum(weights.get(m, 0) * mu for m, (_, mu) in model_lambdas.items()) / total_w

    from_posterior = dc_lam_samples is not None and dc_mu_samples is not None
    if from_posterior:
        # Preserve the Bayesian posterior's relative uncertainty while
        # centring it on the actual ensemble-blended goal rates. The rescale is
        # one scalar per side for the fixture, so it keeps sample order (and
        # hence the rho pairing) and leaves corr(rho, log lambda) unchanged.
        lam_mean = max(float(np.mean(dc_lam_samples)), 1e-6)
        mu_mean = max(float(np.mean(dc_mu_samples)), 1e-6)
        sims = simulator.simulate_from_posterior(
            dc_lam_samples * (lambda_h / lam_mean),
            dc_mu_samples * (mu_a / mu_mean),
            rho_samples=dc_rho_samples,
            rho_paired=True,
            rng=simulation_rng,
            **sim_kwargs,
        )
    else:
        sims = simulator.simulate_match(lambda_h, mu_a, rng=simulation_rng, **sim_kwargs)

    return FixtureSimulation(
        markets=simulator.derive_all_markets(sims),
        lambda_h=float(lambda_h),
        mu_a=float(mu_a),
        model_lambdas=model_lambdas,
        from_posterior=from_posterior,
    )
