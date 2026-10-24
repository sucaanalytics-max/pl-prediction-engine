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

## Goals markets are exact; only corners and cards are simulated

Determinism alone left a fixed draw of noise the size of the decision margin
(0.69pp SE at 5,000 sims against a 5pp minimum edge; see
``pipeline/simulation/exact_markets.py``). So 1X2, totals, BTTS and every other
goals-only market are now computed exactly: the Dixon-Coles scoreline grid
averaged over EVERY posterior draw, recentred on the blended rates exactly as
the simulated draws are. The Dixon-Coles point rate that enters the blend is the
full-posterior mean, not the mean of ``n`` resampled draws, so it carries no
resampling noise either.

Corners and cards are conditioned on simulated goals, so the simulation still
runs, on the same seeded child streams as before, and only those fields are
taken from it. Its goal draws are recentred on the same blended rates as the
exact grid.

If the exact computation fails it raises ``ExactMarketsError``; there is no
fallback to simulated goals markets. Without a Dixon-Coles posterior the goals
markets are the exact independent-Poisson grid at the blended rates, which is
the expectation of the ``simulate_match`` fallback this path has always used,
and that is logged and recorded in ``goal_markets.method``.
"""
import hashlib
import logging
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

import numpy as np

from pipeline.config import PARAM_REGISTRY
from pipeline.simulation.exact_markets import (
    METHOD_POISSON_GRID,
    METHOD_POSTERIOR_GRID,
    ExactMarketsError,
    apply_exact_goal_markets,
    goal_markets_from_grid,
    independent_poisson_grid,
    scoreline_grid_mixture,
)

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
    #: True when the scoreline distribution came from the Dixon-Coles posterior.
    from_posterior: bool
    #: How the goals markets were computed (``exact_markets.METHOD_*``).
    goal_markets_method: str = METHOD_POSTERIOR_GRID
    #: Posterior draws the exact grid averaged over (0 without a posterior).
    n_posterior_draws: int = 0


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
    Blend, compute the goals markets exactly, simulate corners and cards, for
    one fixture, reproducibly.

    ``other_lambdas`` are the non-DC models' point rates (XGBoost, PenaltyBlog),
    in the order they should enter the blend; Dixon-Coles always enters first,
    which is the order run_pipeline has always summed in. ``rng`` defaults to
    :func:`fixture_rng` of ``match_id``; pass one only to override the seed
    (e.g. to measure Monte Carlo error across seeds). It affects only the
    simulated fields (corners, cards); the goals markets do not depend on it or
    on ``simulator.n_sims``.

    The DC posterior's relative uncertainty is kept and recentred on the blended
    rates (``lam_k * lambda_blend / mean(lam)``) on both paths. rho is paired to
    the same posterior draw as each (lambda, mu) on both paths: the simulation
    via ``get_paired_posterior_samples`` with ``rho_paired=True``, the exact grid
    by averaging over the aligned full-posterior triples. Measured on the GW8
    card (2026-10-25): pairing moves any 1X2, O/U 1.5 or BTTS probability by
    <= 0.013pp (O/U 2.5 and 3.5 cannot move: tau only redistributes mass among
    0-0, 1-0, 0-1, 1-1). A correctness fix, not a re-tune.
    """
    generator = rng if rng is not None else fixture_rng(match_id)
    posterior_rng, simulation_rng = generator.spawn(2)
    sim_kwargs = dict(sim_kwargs or {})

    lambda_h, mu_a = DEFAULT_RATES
    dc_lam_samples = dc_mu_samples = dc_rho_samples = None
    dc_lam_post = dc_mu_post = dc_rho_post = None

    if dc_model is not None:
        try:
            # rho is the whole reason to prefer Dixon-Coles over independent
            # Poisson, and it is taken from the SAME posterior draw as each
            # (lambda, mu): the predictive integrates over the joint posterior,
            # not the product of its marginals.
            # Every posterior draw, aligned with the rho trace, for the exact
            # grid and the point rate.
            dc_lam_post, dc_mu_post = dc_model.get_lambda_mu_posterior(home, away)
            dc_rho_post = dc_model.get_rho_samples()
            if dc_rho_post is None or np.shape(dc_rho_post) != np.shape(dc_lam_post):
                # A fitted posterior with no (or misaligned) rho is a broken
                # fit, not a missing prediction: raise rather than fall back
                # to the Poisson grid below.
                raise ExactMarketsError(
                    f"{home} vs {away}: Dixon-Coles posterior has "
                    f"{0 if dc_rho_post is None else np.size(dc_rho_post)} rho draws "
                    f"for {np.size(dc_lam_post)} rate draws; the exact goals "
                    "markets cannot be computed"
                )
            # n paired resampled draws, only to drive the corners/cards
            # simulation. The draw indices consume posterior_rng exactly as
            # get_lambda_mu_samples always has.
            dc_lam_samples, dc_mu_samples, dc_rho_samples = (
                dc_model.get_paired_posterior_samples(
                    home, away, simulator.n_sims, rng=posterior_rng
                )
            )
            lambda_h = float(np.mean(dc_lam_post))
            mu_a = float(np.mean(dc_mu_post))
        except ExactMarketsError:
            raise
        except Exception as e:
            logger.warning(f"  DC prediction failed for {home} vs {away}: {e}")
            dc_lam_samples = dc_mu_samples = dc_rho_samples = None
            dc_lam_post = dc_mu_post = dc_rho_post = None

    from_posterior = dc_lam_post is not None and dc_mu_post is not None

    model_lambdas: Dict[str, Tuple[float, float]] = {}
    if from_posterior:
        model_lambdas["dixon_coles"] = (lambda_h, mu_a)
    for name, rates in other_lambdas.items():
        model_lambdas[name] = rates

    total_w = sum(weights.get(m, 0) for m in model_lambdas)
    if total_w > 0 and len(model_lambdas) > 0:
        lambda_h = sum(weights.get(m, 0) * lam for m, (lam, _) in model_lambdas.items()) / total_w
        mu_a = sum(weights.get(m, 0) * mu for m, (_, mu) in model_lambdas.items()) / total_w

    if from_posterior:
        # Preserve the Bayesian posterior's relative uncertainty while
        # centring it on the actual ensemble-blended goal rates. The rescale is
        # one scalar per side for the fixture, so it keeps sample order (and
        # hence the rho pairing) and leaves corr(rho, log lambda) unchanged.
        post_lam_mean = max(float(np.mean(dc_lam_post)), 1e-6)
        post_mu_mean = max(float(np.mean(dc_mu_post)), 1e-6)
        # Paired: (lam[k], mu[k], rho[k]) is one joint posterior draw, the same
        # semantics as the simulation's rho_paired=True. scoreline_grid_mixture
        # raises ExactMarketsError if the arrays are not aligned.
        grid = scoreline_grid_mixture(
            dc_lam_post * (lambda_h / post_lam_mean),
            dc_mu_post * (mu_a / post_mu_mean),
            dc_rho_post,
        )
        method, n_post = METHOD_POSTERIOR_GRID, int(len(dc_lam_post))

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
        logger.warning(
            f"  {home} vs {away}: no Dixon-Coles posterior; goals markets are the "
            f"exact independent-Poisson grid at the blended rates "
            f"({lambda_h:.3f}, {mu_a:.3f}), with no low-score correction"
        )
        grid = independent_poisson_grid(lambda_h, mu_a)
        method, n_post = METHOD_POISSON_GRID, 0
        sims = simulator.simulate_match(lambda_h, mu_a, rng=simulation_rng, **sim_kwargs)

    provenance = {
        "method": method,
        "n_posterior_draws": n_post,
        "rho": "paired" if from_posterior else None,
    }
    markets = apply_exact_goal_markets(
        simulator.derive_all_markets(sims), goal_markets_from_grid(grid), provenance
    )

    return FixtureSimulation(
        markets=markets,
        lambda_h=float(lambda_h),
        mu_a=float(mu_a),
        model_lambdas=model_lambdas,
        from_posterior=from_posterior,
        goal_markets_method=method,
        n_posterior_draws=n_post,
    )
