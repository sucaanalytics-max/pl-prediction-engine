"""
Custom Bayesian Dixon-Coles model using PyMC.
Full posterior inference with NUTS sampling for uncertainty quantification.

Mathematical specification:
  Home goals ~ Poisson(λ_ij), Away goals ~ Poisson(μ_ij)
  log(λ_ij) = α_i + β_j + γ   (home attack + away defence + home advantage)
  log(μ_ij) = α_j + β_i        (away attack + home defence)
  Low-score correction: ρ adjusts P(0-0), P(1-0), P(0-1), P(1-1)
  Time decay: weight(t) = exp(-ξ * days_since_match)
  Team effects: attack_raw_i ~ Normal(m_i, σ), defence_raw_i ~ Normal(d_i, σ), centred.
    σ is FIXED (PARAM_REGISTRY "dixon_coles.team_effect_sigma"); m_i = d_i = 0 except
    for clubs promoted into the current season, whose prior means are the measured
    promoted-club offsets (see ``promoted_prior_means``).
"""
import logging
from typing import Dict, Iterable, Optional, Set, Tuple

import numpy as np
import pandas as pd

from pipeline.config import (
    CURRENT_SEASON,
    DIXON_COLES,
    MAX_GOALS,
    PARAM_REGISTRY,
    PL_CLUBS_PER_SEASON,
    PL_PROMOTED_PER_SEASON,
)

logger = logging.getLogger(__name__)


def _tau(home_goals, away_goals, lambda_h, mu_a, rho):
    """
    Dixon-Coles low-score correction factor (scalar version for post-hoc use).
    Adjusts probabilities for 0-0, 1-0, 0-1, 1-1 scorelines.
    """
    if home_goals == 0 and away_goals == 0:
        return 1 - lambda_h * mu_a * rho
    elif home_goals == 1 and away_goals == 0:
        return 1 + mu_a * rho
    elif home_goals == 0 and away_goals == 1:
        return 1 + lambda_h * rho
    elif home_goals == 1 and away_goals == 1:
        return 1 - rho
    else:
        return 1.0


def _log_tau_vectorized(home_goals, away_goals, lambda_h, mu_a, rho):
    """
    Vectorized log(tau) for use in PyMC Potential.

    Returns log(tau(x, y, λ, μ, ρ)) for each observation, where tau is the
    Dixon-Coles low-score adjustment. For scorelines not in {(0,0),(1,0),(0,1),(1,1)},
    log(tau) = 0 (i.e. tau = 1, no adjustment).

    Uses PyMC-compatible tensor operations.
    """
    import pytensor.tensor as pt

    # Build tau for each observation based on scoreline
    is_00 = pt.eq(home_goals, 0) * pt.eq(away_goals, 0)
    is_10 = pt.eq(home_goals, 1) * pt.eq(away_goals, 0)
    is_01 = pt.eq(home_goals, 0) * pt.eq(away_goals, 1)
    is_11 = pt.eq(home_goals, 1) * pt.eq(away_goals, 1)

    # tau values for each scoreline type
    tau_00 = 1 - lambda_h * mu_a * rho
    tau_10 = 1 + mu_a * rho
    tau_01 = 1 + lambda_h * rho
    tau_11 = 1 - rho

    # Combine: log(tau) for each obs, defaulting to 0 for non-low-scoring
    log_tau = (
        is_00 * pt.log(pt.maximum(tau_00, 1e-10))
        + is_10 * pt.log(pt.maximum(tau_10, 1e-10))
        + is_01 * pt.log(pt.maximum(tau_01, 1e-10))
        + is_11 * pt.log(pt.maximum(tau_11, 1e-10))
    )
    return log_tau


def _registry_value(name: str) -> float:
    """The one place the model reads its registered hyperparameters from."""
    return float(PARAM_REGISTRY[name]["value"])


def promoted_prior_settings() -> Dict[str, float]:
    """Registered promoted-club prior: offsets (log scale) and the new-club shrink."""
    return {
        "attack_offset": _registry_value("dixon_coles.promoted_attack_offset"),
        "defence_offset": _registry_value("dixon_coles.promoted_defence_offset"),
        "new_club_shrink": _registry_value("dixon_coles.promoted_new_club_shrink"),
    }


def _season_order(matches: pd.DataFrame) -> list:
    """Season labels ordered by their first match date (not by string)."""
    firsts = matches.groupby("season")["Date"].min().sort_values()
    return list(firsts.index)


def current_clubs_from_bootstrap(bootstrap) -> Optional[Set[str]]:
    """
    Canonical names of the clubs in the FPL bootstrap ``teams`` list.

    The authoritative current-season roster: FPL publishes it before a ball is
    kicked, whereas the match data only knows a club once it has played. Names
    go through ``team_mapping`` (never raw provider strings). Returns ``None``
    for a missing or malformed list; plausibility (20 clubs, 3 promoted) is
    judged by ``classify_promoted_clubs``, which logs and falls back.
    """
    from pipeline.data.team_mapping import update_fpl_team_map

    try:
        names = set(update_fpl_team_map(bootstrap["teams"]).values())
    except (KeyError, TypeError, AttributeError) as exc:
        logger.warning(f"FPL bootstrap has no usable teams list ({exc!r}); no club roster.")
        return None
    names = {str(n) for n in names if n}
    if not names:
        # An empty list is a broken fetch, not a league with no clubs.
        logger.warning("FPL bootstrap teams list is empty; no club roster.")
        return None
    return names


def _clubs(frame: pd.DataFrame) -> Set[str]:
    return set(frame["HomeTeam"]) | set(frame["AwayTeam"])


def _classify_from_roster(
    played: pd.DataFrame, season: str, roster: Set[str]
) -> Optional[Tuple[Set[str], Set[str]]]:
    """
    Promoted / new clubs from the published roster, or ``None`` (with a warning)
    when the roster or the data cannot support a trustworthy answer.

    "Previous season" is the season before ``season`` by date when ``season``
    has played rows, else the latest season with played rows (pre-season).
    """
    def reject(why: str) -> None:
        logger.warning(
            f"Club roster not used for promoted-club detection in {season}: {why}. "
            "Falling back to played rows, so a promoted club with no played "
            f"{season} match gets no promoted-club prior."
        )
        return None

    if len(roster) != PL_CLUBS_PER_SEASON:
        return reject(f"{len(roster)} clubs, expected {PL_CLUBS_PER_SEASON}")
    order = _season_order(played)
    before = order[: order.index(season)] if season in order else order
    if not before:
        return reject("no earlier season in the training data")
    previous_label = before[-1]
    previous = _clubs(played[played["season"] == previous_label])
    promoted = roster - previous
    if len(promoted) != PL_PROMOTED_PER_SEASON:
        return reject(
            f"{len(promoted)} clubs absent from {previous_label} "
            f"({', '.join(sorted(promoted)) or 'none'}), expected "
            f"{PL_PROMOTED_PER_SEASON} — stale roster, mis-mapped names, or a "
            "missing season"
        )
    current_played = _clubs(played[played["season"] == season])
    if not current_played <= roster:
        return reject(
            f"clubs with played {season} matches missing from the roster: "
            f"{', '.join(sorted(current_played - roster))}"
        )
    elsewhere = _clubs(played[played["season"] != season])
    return promoted, promoted - elsewhere


def classify_promoted_clubs(
    matches: pd.DataFrame,
    season: Optional[str] = None,
    current_clubs: Optional[Iterable[str]] = None,
) -> Tuple[Set[str], Set[str]]:
    """
    Clubs promoted into ``season``, and which of them are new to the window.

    ``season`` defaults to ``CURRENT_SEASON``. Promoted means: plays in ``season``
    but not in the season immediately before it (by date order). "New" means a
    promoted club with no match in ``matches`` outside ``season`` at all — no
    Premier League data anywhere in the training window.

    ``current_clubs`` is the published roster of ``season`` (canonical names,
    e.g. from ``current_clubs_from_bootstrap``). When given and plausible —
    exactly ``PL_CLUBS_PER_SEASON`` clubs, exactly ``PL_PROMOTED_PER_SEASON`` of
    them absent from the previous season, every club already playing in
    ``season`` on it — it decides who plays in ``season``, so a promoted club is
    classified from the first fixture: pre-season (previous season = latest
    season with played rows) and when its own first match is still unplayed.
    An implausible roster is logged at WARNING and ignored.

    Without a usable roster, "plays in ``season``" means "has a played row in
    ``season``", and this returns ``(set(), set())`` — no promoted-club prior,
    every prior mean 0 — when ``season`` has no played rows (pre-season: a club
    new to the window is then unseen and ``unseen_prior`` covers it, but a
    returning promoted club gets no offset) or when the previous season is
    absent, in which case every club would wrongly look promoted.
    """
    season = CURRENT_SEASON if season is None else season
    if "season" not in matches.columns or matches.empty:
        if current_clubs is not None:
            logger.warning(
                "No season-labelled played rows; promoted clubs cannot be identified "
                "from the roster, so no promoted-club prior is applied."
            )
        return set(), set()
    played = matches.dropna(subset=["FTHG", "FTAG"])
    if current_clubs is not None:
        result = _classify_from_roster(played, season, {c for c in current_clubs if c})
        if result is not None:
            return result
    order = _season_order(played)
    if season not in order:
        return set(), set()
    pos = order.index(season)
    if pos == 0:
        logger.warning(
            f"No season before {season} in the training data; promoted clubs "
            "cannot be identified, so no promoted-club prior is applied."
        )
        return set(), set()

    clubs = _clubs
    current = clubs(played[played["season"] == season])
    previous = clubs(played[played["season"] == order[pos - 1]])
    elsewhere = clubs(played[played["season"] != season])
    promoted = current - previous
    return promoted, promoted - elsewhere


def promoted_prior_means(
    teams: Iterable[str],
    promoted: Iterable[str],
    new_clubs: Iterable[str],
    attack_offset: float,
    defence_offset: float,
    new_club_shrink: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Prior means for ``attack_raw`` / ``defence_raw``, aligned with ``teams``.

    Zero for every club except those promoted into the current season, which get
    the measured promoted-club offsets: in full for a club with Premier League
    data elsewhere in the window, scaled by ``new_club_shrink`` for one with none.

    The offsets were measured against a single season's 20-club mean, while the
    model centres over every club in the window. Those frames differ by about
    0.03-0.04 (latest-season clubs sit that far above the window mean in 2023-27);
    evaluating the prior in both frames moved walk-forward NLL by under 0.001,
    so the offsets are used as-is rather than via a prior that depends on the
    other clubs' parameters.
    """
    teams = list(teams)
    promoted = set(promoted)
    new_clubs = set(new_clubs)
    att = np.zeros(len(teams))
    dfc = np.zeros(len(teams))
    for i, team in enumerate(teams):
        if team in promoted:
            k = new_club_shrink if team in new_clubs else 1.0
            att[i] = k * attack_offset
            dfc[i] = k * defence_offset
    return att, dfc


class BayesianDixonColes:
    """
    Full Bayesian Dixon-Coles model with PyMC NUTS sampling.
    Provides posterior distributions for all team parameters.
    """

    def __init__(self):
        self.trace = None
        self.team_index = {}
        self.teams = []
        self.n_teams = 0
        # (attack, defence) used for a club the posterior has never seen. Set at
        # fit time; a model pickled before it existed has no attribute and falls
        # back to (0, 0), i.e. exactly its old behaviour.
        self.unseen_prior = (0.0, 0.0)
        self.promoted_clubs: Set[str] = set()
        self.new_promoted_clubs: Set[str] = set()
        self.team_effect_sigma: Optional[float] = None

    def fit(
        self,
        matches: pd.DataFrame,
        promoted_clubs: Optional[Iterable[str]] = None,
        new_promoted_clubs: Optional[Iterable[str]] = None,
        current_clubs: Optional[Iterable[str]] = None,
    ) -> None:
        """
        Fit the Bayesian Dixon-Coles model.

        Args:
            matches: DataFrame with HomeTeam, AwayTeam, FTHG, FTAG, Date, season
            promoted_clubs: override for the clubs promoted into the current
                season. Default: derived from the ``season`` column by
                ``classify_promoted_clubs`` for ``CURRENT_SEASON``.
            new_promoted_clubs: override for the subset with no other data in the
                window. Default: derived alongside ``promoted_clubs``; when
                ``promoted_clubs`` is given without it, a promoted club whose
                every row is in the latest season of ``matches`` is new.
            current_clubs: canonical names of the clubs in ``CURRENT_SEASON``
                (the FPL bootstrap roster, ``current_clubs_from_bootstrap``).
                Lets the default classification apply the promoted-club prior
                before a club's first played match — see
                ``classify_promoted_clubs``. Ignored when ``promoted_clubs`` is
                given. Changes the prior, so it belongs in any fit cache key.
        """
        try:
            import pymc as pm
            import arviz as az
        except ImportError:
            logger.error("PyMC not installed. Run: pip install pymc arviz")
            raise

        df = matches.dropna(subset=["FTHG", "FTAG"]).copy()
        df["FTHG"] = df["FTHG"].astype(int)
        df["FTAG"] = df["FTAG"].astype(int)

        # Build team index
        self.teams = sorted(set(df["HomeTeam"].unique()) | set(df["AwayTeam"].unique()))
        self.team_index = {team: i for i, team in enumerate(self.teams)}
        self.n_teams = len(self.teams)

        att_mu, def_mu, sigma = self._configure_prior(
            df, promoted_clubs, new_promoted_clubs, current_clubs=current_clubs
        )

        home_idx = df["HomeTeam"].map(self.team_index).values
        away_idx = df["AwayTeam"].map(self.team_index).values
        home_goals = df["FTHG"].values
        away_goals = df["FTAG"].values

        # Time decay weights
        max_date = df["Date"].max()
        days_ago = (max_date - df["Date"]).dt.days.values
        xi = DIXON_COLES["xi_decay"]
        weights = np.exp(-xi * days_ago)

        logger.info(f"Fitting Bayesian Dixon-Coles on {len(df)} matches, {self.n_teams} teams...")

        with pm.Model() as model:
            import pytensor.tensor as pt

            # Team-level parameters (sum-to-zero constraint via centering).
            #
            # sigma is FIXED, not learned. The HalfNormal(1) hyperprior it replaces
            # learned 0.16 / 0.12 (att / def) on 2023-27, leaving posterior-mean
            # defence effects with an SD of 0.06 — the best defence in the league
            # rated barely above average — and its funnel cost convergence (one
            # walk-forward fit in 52 at R-hat 2.24). Evidence and the out-of-sample
            # selection are in PARAM_REGISTRY["dixon_coles.team_effect_sigma"].
            attack_raw = pm.Normal("attack_raw", mu=att_mu, sigma=sigma, shape=self.n_teams)
            defence_raw = pm.Normal("defence_raw", mu=def_mu, sigma=sigma, shape=self.n_teams)

            # Center parameters (identifiability)
            attack = pm.Deterministic("attack", attack_raw - attack_raw.mean())
            defence = pm.Deterministic("defence", defence_raw - defence_raw.mean())

            # Home advantage
            home_adv = pm.Normal(
                "home_adv",
                mu=DIXON_COLES["home_advantage_prior_mean"],
                sigma=DIXON_COLES["home_advantage_prior_sd"],
            )

            # Intercept (league average scoring rate)
            intercept = pm.Normal("intercept", mu=0.3, sigma=0.2)

            # ρ (rho) — Dixon-Coles low-score dependence parameter
            # Typically small and negative (draws slightly less likely than
            # bivariate Poisson would suggest). Bounded to keep tau > 0.
            rho = pm.Uniform("rho", lower=-0.5, upper=0.5)

            # Goal rates
            log_lambda = intercept + attack[home_idx] - defence[away_idx] + home_adv
            log_mu = intercept + attack[away_idx] - defence[home_idx]

            lambda_h = pm.math.exp(log_lambda)
            mu_a = pm.math.exp(log_mu)

            # ── Weighted log-likelihood via pm.Potential ──────────────────────
            # Instead of pm.Poisson (which doesn't support observation weights),
            # we compute the weighted log-likelihood manually.
            #
            # log L = Σ_i w_i * [logp(home_goals_i | λ_i) + logp(away_goals_i | μ_i)
            #                    + log τ(home_goals_i, away_goals_i, λ_i, μ_i, ρ)]
            #
            # where w_i = exp(-ξ * days_since_match_i) are the time-decay weights.

            # Poisson log-pmf: k*log(μ) - μ - log(k!)
            home_logp = (
                home_goals * pt.log(lambda_h)
                - lambda_h
                - pt.gammaln(home_goals + 1)
            )
            away_logp = (
                away_goals * pt.log(mu_a)
                - mu_a
                - pt.gammaln(away_goals + 1)
            )

            # Dixon-Coles low-score correction
            log_tau = _log_tau_vectorized(home_goals, away_goals, lambda_h, mu_a, rho)

            # Time-decay weighted total log-likelihood
            weights_tensor = pt.as_tensor_variable(weights.astype(np.float64))
            total_logp = pt.sum(weights_tensor * (home_logp + away_logp + log_tau))

            pm.Potential("weighted_dc_likelihood", total_logp)

            # Sample
            self.trace = pm.sample(
                draws=DIXON_COLES["pymc_draws"],
                tune=DIXON_COLES["pymc_tune"],
                chains=DIXON_COLES["pymc_chains"],
                target_accept=DIXON_COLES["pymc_target_accept"],
                random_seed=42,
                return_inferencedata=True,
                progressbar=True,
            )

        # Check convergence
        summary = az.summary(self.trace, var_names=["attack", "defence", "home_adv", "intercept", "rho"])
        max_rhat = summary["r_hat"].max()
        logger.info(f"PyMC sampling complete. Max R-hat: {max_rhat:.4f}")

        if max_rhat > 1.05:
            logger.warning(f"Convergence issue: max R-hat = {max_rhat:.4f} > 1.05")

    def _configure_prior(
        self,
        df: pd.DataFrame,
        promoted_clubs: Optional[Iterable[str]] = None,
        new_promoted_clubs: Optional[Iterable[str]] = None,
        current_clubs: Optional[Iterable[str]] = None,
    ) -> Tuple[np.ndarray, np.ndarray, float]:
        """
        Team-effect prior for ``fit``: (attack means, defence means, sigma).

        Separate from ``fit`` so it can be tested without PyMC. Requires
        ``self.teams`` / ``self.team_index`` to be built from ``df`` already.
        Also sets ``promoted_clubs``, ``new_promoted_clubs``, ``unseen_prior``
        and ``team_effect_sigma`` on the instance, so a fitted model records
        which prior it was fitted under.
        """
        if promoted_clubs is None:
            promoted, new = classify_promoted_clubs(df, current_clubs=current_clubs)
        else:
            promoted = set(promoted_clubs)
            if new_promoted_clubs is None:
                # Override without the "new" subset: a promoted club is new when
                # every one of its rows is in the latest season of the data.
                played = df.dropna(subset=["FTHG", "FTAG"])
                order = _season_order(played) if "season" in played.columns else []
                if order:
                    other = played[played["season"] != order[-1]]
                    seen = set(other["HomeTeam"]) | set(other["AwayTeam"])
                else:
                    seen = set()
                new = promoted - seen
            else:
                new = set(new_promoted_clubs)
        self.promoted_clubs = promoted & set(self.teams)
        self.new_promoted_clubs = new & self.promoted_clubs
        unseen = promoted - self.promoted_clubs
        if unseen:
            # Promoted but absent from the data (new to the window, nothing played
            # yet): no fit parameter exists, so predict-time ``unseen_prior`` —
            # the shrunk offset — is what they get.
            logger.info(
                "Promoted clubs with no played rows (predicted via unseen_prior): %s",
                ", ".join(sorted(unseen)),
            )

        prior = promoted_prior_settings()
        sigma = _registry_value("dixon_coles.team_effect_sigma")
        self.team_effect_sigma = sigma
        att_mu, def_mu = promoted_prior_means(
            self.teams, self.promoted_clubs, self.new_promoted_clubs,
            prior["attack_offset"], prior["defence_offset"], prior["new_club_shrink"],
        )
        # A club absent from the data entirely has no Premier League data in the
        # window by definition, so the predict-time fallback is the shrunk offset.
        self.unseen_prior = (
            prior["new_club_shrink"] * prior["attack_offset"],
            prior["new_club_shrink"] * prior["defence_offset"],
        )
        if self.promoted_clubs:
            logger.info(
                "Promoted-club prior: %s",
                ", ".join(
                    f"{t} (att {att_mu[self.team_index[t]]:+.3f}, "
                    f"def {def_mu[self.team_index[t]]:+.3f}"
                    f"{', new to window' if t in self.new_promoted_clubs else ''})"
                    for t in sorted(self.promoted_clubs)
                ),
            )
        return att_mu, def_mu, sigma

    def get_team_params(self, team: str) -> Dict:
        """Get posterior mean and CI for a team's parameters."""
        if self.trace is None:
            raise RuntimeError("Model not fitted")

        idx = self.team_index.get(team)
        if idx is None:
            raise ValueError(f"Unknown team: {team}")

        attack = self.trace.posterior["attack"].values[:, :, idx].flatten()
        defence = self.trace.posterior["defence"].values[:, :, idx].flatten()

        return {
            "attack_mean": float(np.mean(attack)),
            "attack_ci": [float(np.percentile(attack, 5)), float(np.percentile(attack, 95))],
            "defence_mean": float(np.mean(defence)),
            "defence_ci": [float(np.percentile(defence, 5)), float(np.percentile(defence, 95))],
        }

    @staticmethod
    def scoreline_matrix(
        lam: float, mu: float, rho: float, max_goals: int = MAX_GOALS
    ) -> np.ndarray:
        """
        Scoreline probabilities for ONE (lambda, mu, rho), with the Dixon-Coles
        low-score correction.

        Extracted so the market-implied rate inversion can run the *same* forward
        model the simulator draws from. Inverting prices through a different
        distribution than we later simulate would make the two disagree by
        construction, and the disagreement would be invisible.

        Deliberately NOT used by ``predict_scoreline``, whose vectorised path is
        on the daily prediction route: refactoring it to loop over this would risk
        moving ``latest.json``. Equivalence is pinned by a test that feeds a
        single-sample trace instead, which buys the same guarantee at no risk.
        """
        from scipy.stats import poisson

        goals = np.arange(max_goals + 1)
        i_grid, j_grid = np.meshgrid(goals, goals, indexing="ij")

        pmf_home = poisson.pmf(i_grid, lam)
        pmf_away = poisson.pmf(j_grid, mu)

        tau = np.ones_like(pmf_home, dtype=float)
        tau = np.where((i_grid == 0) & (j_grid == 0), 1 - lam * mu * rho, tau)
        tau = np.where((i_grid == 1) & (j_grid == 0), 1 + mu * rho, tau)
        tau = np.where((i_grid == 0) & (j_grid == 1), 1 + lam * rho, tau)
        tau = np.where((i_grid == 1) & (j_grid == 1), 1 - rho, tau)

        matrix = np.maximum(pmf_home * pmf_away * tau, 0.0)
        total = matrix.sum()
        # The floor plus renormalisation is what keeps tau positivity from needing
        # a hard constraint on rho: for large lambda*mu and positive rho the 0-0
        # correction can go negative, and flooring it is what predict_scoreline
        # already does.
        return matrix / total if total > 0 else matrix

    def predict_scoreline(self, home: str, away: str, n_samples: int = 5000) -> np.ndarray:
        """
        Predict scoreline matrix from posterior predictive.
        Samples parameters from posterior, then simulates goals.
        """
        if self.trace is None:
            raise RuntimeError("Model not fitted")

        h_idx = self.team_index.get(home)
        a_idx = self.team_index.get(away)
        if h_idx is None or a_idx is None:
            raise ValueError(f"Unknown team(s): {home}, {away}")

        # Sample from posterior
        attack = self.trace.posterior["attack"].values
        defence = self.trace.posterior["defence"].values
        home_adv = self.trace.posterior["home_adv"].values
        intercept = self.trace.posterior["intercept"].values
        rho_samples = self.trace.posterior["rho"].values.flatten()

        # Flatten chains
        att_h = attack[:, :, h_idx].flatten()
        att_a = attack[:, :, a_idx].flatten()
        def_h = defence[:, :, h_idx].flatten()
        def_a = defence[:, :, a_idx].flatten()
        ha = home_adv.flatten()
        inter = intercept.flatten()

        # Subsample if needed
        n_total = len(att_h)
        indices = np.random.choice(n_total, size=min(n_samples, n_total), replace=False)

        # Compute rates
        log_lambda = inter[indices] + att_h[indices] - def_a[indices] + ha[indices]
        log_mu = inter[indices] + att_a[indices] - def_h[indices]
        lambda_h = np.exp(log_lambda)
        mu_a = np.exp(log_mu)
        rho_vals = rho_samples[indices % len(rho_samples)]

        # Build scoreline matrix with ρ correction using NumPy broadcasting
        # lam and mu have shape (n_samples,). We want matrix of shape (MAX_GOALS+1, MAX_GOALS+1)
        # Vectorized over samples (s), home goals (i), and away goals (j)
        from scipy.stats import poisson as poisson_dist
        
        # Ranges
        goals_range = np.arange(MAX_GOALS + 1)
        i_grid, j_grid = np.meshgrid(goals_range, goals_range, indexing='ij')
        
        # Reshape for broadcasting:
        # lambda_h, mu_a, rho_vals -> (n_samples, 1, 1)
        lam_3d = lambda_h[:, np.newaxis, np.newaxis]
        mu_3d = mu_a[:, np.newaxis, np.newaxis]
        rho_3d = rho_vals[:, np.newaxis, np.newaxis]
        
        # i_grid, j_grid -> (1, MAX_GOALS+1, MAX_GOALS+1)
        i_3d = i_grid[np.newaxis, :, :]
        j_3d = j_grid[np.newaxis, :, :]
        
        # Calculate Poisson PMFs
        pmf_h = poisson_dist.pmf(i_3d, lam_3d)
        pmf_a = poisson_dist.pmf(j_3d, mu_3d)
        
        # Calculate Tau
        # Default is 1.0
        tau_3d = np.ones_like(pmf_h)
        
        # Masks for specific scorelines
        mask_00 = (i_3d == 0) & (j_3d == 0)
        mask_10 = (i_3d == 1) & (j_3d == 0)
        mask_01 = (i_3d == 0) & (j_3d == 1)
        mask_11 = (i_3d == 1) & (j_3d == 1)
        
        # Apply corrections using np.where to handle broadcasting safely
        tau_3d = np.where(mask_00, 1 - lam_3d * mu_3d * rho_3d, tau_3d)
        tau_3d = np.where(mask_10, 1 + mu_3d * rho_3d, tau_3d)
        tau_3d = np.where(mask_01, 1 + lam_3d * rho_3d, tau_3d)
        tau_3d = np.where(mask_11, 1 - rho_3d, tau_3d)
        
        # Compute joint probabilities for all samples and sum over samples
        p_ij_3d = pmf_h * pmf_a * tau_3d
        p_ij_3d = np.maximum(p_ij_3d, 0) # Ensure no negative probabilities
        
        matrix = p_ij_3d.sum(axis=0)

        total = matrix.sum()
        if total > 0:
            matrix /= total
        return matrix

    def predict_match(self, home: str, away: str) -> Dict:
        """Full match prediction with all markets."""
        matrix = self.predict_scoreline(home, away)
        return self._derive_markets(matrix, home, away)

    def get_rho_samples(self) -> np.ndarray:
        """
        Posterior samples of the low-score dependence parameter, one per
        posterior draw of the trace.

        Flattened in the same (chain, draw) order as the per-draw parameter
        arrays `get_lambda_mu_samples` builds its rates from — NOT in the order
        of the rates it returns, which are a resample of those draws. To pair rho
        with (lambda, mu) elementwise, index this array with the draw indices
        (``get_lambda_mu_samples(..., return_indices=True)``) or call
        :meth:`get_paired_posterior_samples`, which does exactly that. Returning
        a mean would throw the parameter uncertainty away, and rho's posterior is
        wide enough that it matters.
        """
        if self.trace is None:
            raise RuntimeError("Model not fitted")
        return self.trace.posterior["rho"].values.flatten()

    def get_paired_posterior_samples(
        self,
        home: str,
        away: str,
        n_samples: int = 10000,
        rng: Optional[np.random.Generator] = None,
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        (lambda, mu, rho) drawn from the JOINT posterior: element ``k`` of each
        array comes from the same posterior draw.

        The predictive the value-bet card wants is
        ``p(score) = E_{theta ~ p(theta | data)}[DC(score | lambda(theta), mu(theta), rho(theta))]``
        with ``theta = (attack, defence, home_adv, intercept, rho)``. Drawing rho
        with its own indices instead integrates over ``p(lambda, mu) p(rho)`` —
        the product of the marginals — which is a different distribution
        whenever rho is correlated with the strength parameters. The tau
        correction depends on ``lambda * mu * rho`` (0-0) and ``mu * rho`` /
        ``lambda * rho`` (1-0, 0-1), so that covariance is exactly what the
        product of marginals drops.

        The draw indices consume ``rng`` exactly as :meth:`get_lambda_mu_samples`
        does, so lambda and mu are bit-for-bit those of that method under the
        same Generator.
        """
        lambda_h, mu_a, indices = self.get_lambda_mu_samples(
            home, away, n_samples, rng=rng, return_indices=True
        )
        rho_all = self.get_rho_samples()
        n_draws = self.trace.posterior["intercept"].values.size
        if rho_all.shape != (n_draws,):
            # Pairing by index is only meaningful if rho has one value per
            # posterior draw, in the same flattening. Fail loudly rather than
            # pair unrelated arrays.
            raise ValueError(
                f"rho trace has shape {rho_all.shape}, expected ({n_draws},) "
                "to align with the per-draw rate parameters"
            )
        return lambda_h, mu_a, rho_all[indices]

    def get_lambda_mu_samples(
        self,
        home: str,
        away: str,
        n_samples: int = 10000,
        rng: Optional[np.random.Generator] = None,
        return_indices: bool = False,
    ):
        """
        Get posterior samples of (lambda, mu) for Monte Carlo simulation.
        Used by the simulation engine.

        ``rng`` selects which posterior draws are resampled. The value-bet path
        passes one so the card is reproducible; ``None`` keeps numpy's legacy
        global state (the FPL ``fixture_rates`` export still relies on that).

        ``return_indices=True`` also returns the flattened posterior draw index
        behind each sample, so a caller can take any other per-draw quantity
        (rho, via ``get_rho_samples()[indices]``) from the SAME draw. It changes
        nothing about which draws are taken.

        Returns:
            (lambda_home, mu_away) arrays of posterior samples, or
            (lambda_home, mu_away, indices) with ``return_indices=True``.
        """
        if self.trace is None:
            raise RuntimeError("Model not fitted")

        attack = self.trace.posterior["attack"].values
        defence = self.trace.posterior["defence"].values
        home_adv = self.trace.posterior["home_adv"].values
        intercept = self.trace.posterior["intercept"].values
        ha = home_adv.flatten()
        inter = intercept.flatten()

        h_idx = self.team_index.get(home)
        a_idx = self.team_index.get(away)
        # A club the posterior has never seen — at the start of a season, one
        # promoted from outside the window — gets the promoted-club prior mean
        # rather than the league average, while known opponents retain their
        # posterior strength. ``getattr`` keeps models pickled before this
        # attribute existed on their original (0, 0).
        unseen_att, unseen_def = getattr(self, "unseen_prior", (0.0, 0.0))
        unseen_att = np.full_like(inter, unseen_att)
        unseen_def = np.full_like(inter, unseen_def)

        att_h = attack[:, :, h_idx].flatten() if h_idx is not None else unseen_att
        att_a = attack[:, :, a_idx].flatten() if a_idx is not None else unseen_att
        def_h = defence[:, :, h_idx].flatten() if h_idx is not None else unseen_def
        def_a = defence[:, :, a_idx].flatten() if a_idx is not None else unseen_def

        if h_idx is None or a_idx is None:
            logger.info(
                f"Using promoted-club prior (att {unseen_att[0]:+.3f}, def "
                f"{unseen_def[0]:+.3f}) for {home} vs {away} "
                f"(unknown: {[t for t, idx in ((home, h_idx), (away, a_idx)) if idx is None]})"
            )

        n_total = len(inter)
        source = rng if rng is not None else np.random
        indices = source.choice(n_total, size=n_samples, replace=True)

        lambda_h = np.exp(inter[indices] + att_h[indices] - def_a[indices] + ha[indices])
        mu_a = np.exp(inter[indices] + att_a[indices] - def_h[indices])

        if return_indices:
            return lambda_h, mu_a, indices
        return lambda_h, mu_a

    def get_rho_mean(self) -> float:
        """Get posterior mean of ρ for use in scoreline correction."""
        if self.trace is None:
            return 0.0
        return float(self.trace.posterior["rho"].values.mean())

    def _derive_markets(self, matrix: np.ndarray, home: str, away: str) -> Dict:
        """Derive all betting markets from scoreline matrix."""
        p_home = sum(matrix[i, j] for i in range(MAX_GOALS + 1) for j in range(i))
        p_draw = sum(matrix[i, i] for i in range(MAX_GOALS + 1))
        p_away = 1 - p_home - p_draw

        over_under = {}
        for line in [0.5, 1.5, 2.5, 3.5, 4.5]:
            p_over = sum(
                matrix[i, j] for i in range(MAX_GOALS + 1)
                for j in range(MAX_GOALS + 1) if i + j > line
            )
            over_under[f"over_{line}"] = float(p_over)
            over_under[f"under_{line}"] = float(1 - p_over)

        p_btts = sum(
            matrix[i, j] for i in range(1, MAX_GOALS + 1)
            for j in range(1, MAX_GOALS + 1)
        )

        e_home = sum(i * matrix[i, j] for i in range(MAX_GOALS + 1) for j in range(MAX_GOALS + 1))
        e_away = sum(j * matrix[i, j] for i in range(MAX_GOALS + 1) for j in range(MAX_GOALS + 1))

        correct_scores = {}
        for i in range(min(6, MAX_GOALS + 1)):
            for j in range(min(6, MAX_GOALS + 1)):
                correct_scores[f"{i}-{j}"] = float(matrix[i, j])

        return {
            "1x2": {"home": float(p_home), "draw": float(p_draw), "away": float(p_away)},
            "over_under": over_under,
            "btts": float(p_btts),
            "expected_goals": {"home": float(e_home), "away": float(e_away)},
            "correct_score": correct_scores,
            "scoreline_matrix": matrix.tolist(),
            "model": "dixon_coles_pymc",
        }

    def get_lambda_mu_posterior(self, home: str, away: str) -> Tuple[np.ndarray, np.ndarray]:
        """
        Every posterior draw of (lambda, mu), in flattened chain-major order,
        with no resampling.

        The same rate formula and promoted-club prior as
        :meth:`get_lambda_mu_samples`, which draws ``n_samples`` indices from
        exactly these arrays; a test pins that the two agree draw for draw. The
        order matches :meth:`get_rho_samples`, so ``(lam[k], mu[k], rho[k])`` is
        one joint posterior draw.

        Used by the exact goals-market path
        (``pipeline/simulation/exact_markets.py``), which averages the scoreline
        grid over the whole posterior. Averaging over all draws deterministically
        is what removes posterior-resampling noise from the 1X2, totals and BTTS
        probabilities and from the Dixon-Coles point rate entering the blend.
        """
        if self.trace is None:
            raise RuntimeError("Model not fitted")

        attack = self.trace.posterior["attack"].values
        defence = self.trace.posterior["defence"].values
        ha = self.trace.posterior["home_adv"].values.flatten()
        inter = self.trace.posterior["intercept"].values.flatten()

        h_idx = self.team_index.get(home)
        a_idx = self.team_index.get(away)
        unseen_att, unseen_def = getattr(self, "unseen_prior", (0.0, 0.0))
        unseen_att = np.full_like(inter, unseen_att)
        unseen_def = np.full_like(inter, unseen_def)

        att_h = attack[:, :, h_idx].flatten() if h_idx is not None else unseen_att
        att_a = attack[:, :, a_idx].flatten() if a_idx is not None else unseen_att
        def_h = defence[:, :, h_idx].flatten() if h_idx is not None else unseen_def
        def_a = defence[:, :, a_idx].flatten() if a_idx is not None else unseen_def

        lambda_h = np.exp(inter + att_h - def_a + ha)
        mu_a = np.exp(inter + att_a - def_h)
        return lambda_h, mu_a
