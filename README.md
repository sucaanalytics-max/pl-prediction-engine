# PL Prediction Engine

Premier League and FPL decision-support engine that publishes probabilistic
match, player, and betting-market forecasts.

The 2026-27 pipeline is in forward-validation mode. Predictions are explicitly
marked uncalibrated until enough post-change fixtures have completed.

## Architecture

```
Python Pipeline (GitHub Actions) → JSON → Next.js Frontend (Vercel)
```

**Pipeline** runs daily at 06:00 UTC via GitHub Actions cron, fetching historical
data from Football-Data.co.uk and current fixture/player data from FPL, with
FBref enrichment where available. It fits Dixon-Coles Bayesian, XGBoost, and
PenaltyBlog models, runs Monte Carlo simulations, records the final pre-match
forecast in a forward-validation ledger, and commits prediction JSON.

**Frontend** reads the static JSON and renders a 6-page dashboard: Matchweek Overview, Match Deep Dive, Value Bets, Player Projections, Bankroll Tracker, and Model Health.

## Models

- **Dixon-Coles (PyMC)**: Bayesian with NUTS sampler, 2000 draws, attack/defence parameters with sum-to-zero constraint, home advantage prior, time decay ξ=0.003
- **XGBoost**: Poisson objective, 21 features including rolling xG, Elo, form, rest days
- **PenaltyBlog**: Fast baseline Dixon-Coles via the `penaltyblog` library
- **Ensemble**: 60% DC + 30% XGB + 10% PB weighted blend, renormalized across
  models available for each fixture
- **Sub-models**: Negative Binomial (corners), Zero-Inflated Poisson (cards)

## Markets

1X2, Over/Under (2.5, 3.5), BTTS, Correct Score (7×7), Asian Handicap, HT/FT, Corners O/U, Cards O/U

## Quick Start

### Pipeline
```bash
cd pipeline
pip install -r requirements.txt
python -m pipeline.run_pipeline --skip-pymc  # Fast mode (PenaltyBlog only)
python -m pipeline.run_pipeline              # Full mode (all models)
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

## GitHub Actions

- **pipeline.yml**: Daily predictions (06:00 UTC) + manual dispatch
- **validate.yml**: Weekly artifact/freshness validation (Sundays 10:00 UTC)

## Odds and credentials

Set `ODDS_API_KEY` as a GitHub Actions secret. Featured 1X2 and total-goals
markets are fetched by default. Quota-intensive BTTS, corners, and cards markets
use per-event requests and are opt-in with `ODDS_FETCH_ADDITIONAL=true`.

Never commit real credentials. See `.env.example` for supported settings.

## Validation

Run the local contract suite:

```bash
python -m unittest discover -s pipeline/tests -v
```

`predictions/forecast_ledger.json` starts a forward-only record. Model-health
metrics remain provisional until at least 100 completed fixtures are available.

## Key Dependencies

Python: `pymc`, `xgboost`, `penaltyblog`, `shap`, `pandas`, `numpy`, `scipy`, `fbrefdata`
Frontend: `next`, `react`, `recharts`, `tailwindcss`
