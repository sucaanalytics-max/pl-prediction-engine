# PL Prediction Engine

Production-grade Premier League match prediction engine that outputs calibrated Bayesian probabilities for all major betting markets.

## Architecture

```
Python Pipeline (GitHub Actions) → JSON → Next.js Frontend (Vercel)
```

**Pipeline** runs daily at 06:00 UTC via GitHub Actions cron, fetching data from Football-Data.co.uk, FBref, and the FPL API. It fits Dixon-Coles Bayesian, XGBoost, and PenaltyBlog models, runs 10K Monte Carlo simulations per match, and commits prediction JSON to the repo.

**Frontend** reads the static JSON and renders a 6-page dashboard: Matchweek Overview, Match Deep Dive, Value Bets, Player Projections, Bankroll Tracker, and Model Health.

## Models

- **Dixon-Coles (PyMC)**: Bayesian with NUTS sampler, 2000 draws, attack/defence parameters with sum-to-zero constraint, home advantage prior, time decay ξ=0.003
- **XGBoost**: Poisson objective, 21 features including rolling xG, Elo, form, rest days
- **PenaltyBlog**: Fast baseline Dixon-Coles via the `penaltyblog` library
- **Ensemble**: 60% DC + 30% XGB + 10% PB weighted blend
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
- **validate.yml**: Weekly model health check (Sundays 10:00 UTC)

## Key Dependencies

Python: `pymc`, `xgboost`, `penaltyblog`, `shap`, `pandas`, `numpy`, `scipy`, `fbrefdata`
Frontend: `next`, `react`, `recharts`, `tailwindcss`
