# PL Prediction Engine

Premier League match prediction and value-betting engine, plus an FPL decision-support frontend.

## Architecture

```
Python pipeline (GitHub Actions, daily 06:00 UTC)
  → predictions/*.json
  → copied to frontend/public/predictions/ + uploaded to Supabase Storage
  → Next.js 14 frontend (Vercel + Cloudflare)
```

There is **no runtime coupling between Python and Node**. The only contract is the shape of the JSON — produced by `pipeline/run_pipeline.py` step 10, consumed by the TypeScript interfaces in `frontend/lib/predictions.ts`. Nothing enforces it, so drift is silent until a page renders blank. Changing one side means changing the other.

### Pipeline

`pipeline/run_pipeline.py` — one 12-step `run_pipeline()` function, steps marked `# ── Step N`: fetch data → referee profiles → feature engineering → PenaltyBlog baseline → PyMC Dixon-Coles → XGBoost → sub-models (corners/cards/player cards) → optional stacking → live odds → Monte Carlo (10k sims, 7×7 scoreline grid) → export JSON → Supabase upload.

- `pipeline/config.py` — **all** hyperparameters, URLs, env vars, ensemble weights, risk limits. Put configuration here, not inline in modules.
- `pipeline/models/` — `dixon_coles.py` (PyMC/NUTS), `xgboost_model.py`, `penaltyblog_baseline.py`, `ensemble.py` (60/30/10 DC/XGB/PB), `corners_negbin.py`, `cards_zip.py`, `player_cards.py`, `goalscorer.py`, `calibration.py`
- `pipeline/data/` — `football_data.py`, `fpl_api.py`, `fbref.py`, `odds_api.py`, `referee_profiles.py`, `team_mapping.py`
- `pipeline/features/engineer.py`, `pipeline/simulation/montecarlo.py`, `pipeline/risk/kelly.py`, `pipeline/explainability/shap_explain.py`
- `pipeline/validation/` — `run_validation.py`, `metrics.py`, `ledger.py` (forward-validation ledger), `artifacts.py`

### Frontend

Next.js 14 App Router, all pages `"use client"`. Routes grouped in `frontend/components/Navigation.tsx`: FPL (`/`, `/transfers`, `/optimizer`, `/captaincy`, `/rankings`, `/planner`, `/evidence`, `/intelligence`, `/players`), Matches (`/h2h`, `/table`, `/matches/[id]`), Betting (`/value-bets`, `/bankroll`), Ops (`/health`).

Two separate data paths:
- **Predictions** — `frontend/lib/predictions.ts` (interfaces + loaders + derived helpers) via `frontend/lib/PredictionsContext.tsx`. Fetches Supabase Storage when `NEXT_PUBLIC_SUPABASE_URL` is set, **falling back to local `/predictions/`** on any failure. Keep that fallback.
- **Live FPL** — `frontend/app/api/fpl/state/route.ts` → `frontend/lib/fpl-live-server.ts` → Supabase snapshot table via `fpl-snapshot-store.ts`.

## Commands

```bash
# Pipeline tests (unittest, NOT pytest — no pytest config exists)
# Use the repo venv. Bare `python3` is a Homebrew 3.14 WITHOUT scipy, and the
# suite degrades misleadingly under it: 56 import errors and 1187 tests instead
# of 1309, which reads as a code regression rather than a missing interpreter.
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v

# Piping to `tail`/`head` masks the exit code — `cmd | tail` reports tail's
# status, so a failing suite looks like a pass. Redirect, then check `$?`.

# Frontend
cd frontend && npm run test    # vitest run
cd frontend && npm run lint
cd frontend && npm run build   # Vercel target; build:cloudflare for the other
```

CI: `.github/workflows/pipeline.yml` (daily), `validate.yml` (Sundays, writes `health.json`), `frontend.yml` (test → lint → build, Node 24).

## Hard constraints

- **The Odds API free tier is 500 requests/month** and the daily pipeline run consumes it (`pipeline/data/odds_api.py`, 30-min cache, per-event markets opt-in via `ODDS_FETCH_ADDITIONAL`). Never add an unbounded fetch loop or shorten the cache.
- **Team names must be canonicalised** through `pipeline/data/team_mapping.py`. Every provider spells clubs differently; never join on raw provider strings.
- **Kelly staking is real money.** `pipeline/risk/kelly.py` and `getHalfKellyPct`/`effectiveEdge` in `predictions.ts`. Never widen stake sizing or drop a risk cap as a side effect.
- **The pipeline runs unattended**, so a swallowed error yields confidently wrong predictions. Optional scraped sources (FBref/Understat) degrade gracefully by design; sources the models depend on must fail loudly.
- **Only `predictions/forecast_ledger.json` proves a prediction predated kickoff.** Never source an accuracy claim from `latest.json`.
- **Secrets**: `ODDS_API_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `FOOTBALL_DATA_TOKEN`. Service-role keys never go behind `NEXT_PUBLIC_`.

## Sync-conflict duplicates

Files named `foo 2.ts` appear in this working tree periodically — **743 at once** on
one occasion, including `pipeline/risk/kelly 2.py`, a byte-identical copy of the
real-money staking module. Editing the wrong copy is silent, and a stale duplicate
of a test file shadows the real one.

**The cause was investigated and not found.** Ruled out by measurement, so do not
re-check these:

| Suspect | Verdict |
|---|---|
| iCloud Desktop & Documents | OFF — `~/Documents` is a real directory and there is no `CloudDocs/Documents` |
| OneDrive | Running and backs up *a* Documents folder, but not this one: different inode, unrelated contents |
| Google Drive | Running; its root has `My Drive`/`Shared drives` and no Documents mirror |
| `npm run build` | Zero duplicates, over both a clean and an existing `.next` |
| Shell-written files | Not duplicated (canary) |
| Editor/tool-written files | Not duplicated (canary) |

The events are **episodic** — 743, then 3, then 9 — which looks like a bulk
reconcile rather than a per-file watcher, and it did not reproduce under two canary
tests several minutes long.

So the impact is managed rather than the cause fixed:

- **Detector**: `frontend/test/no-untracked-imports.test.ts` fails on any duplicate
  that shadows a real file, and its message names the remedy.
- **Remedy**: `scripts/clean_sync_duplicates.sh --apply`. It removes only copies
  that are byte-identical to their original or live in a build directory, and
  **reports anything that differs rather than deleting it** — a differing copy may
  hold the only version of some work.

There is deliberately **no `.gitignore` rule**: `* [0-9].*` would also hide a
legitimate `step 2.tsx`, trading a visible problem for an invisible one.

## Ignore these directories

Build artifacts, present on disk but not source — exclude from searches: `frontend/.open-next/`, `frontend/.wrangler/`, `frontend/dist/`, `frontend/.sites-bundle/`, `frontend/.openai/`, `node_modules/`, and generated `frontend/public/predictions/*.json`.

## MCP football data servers

Four servers are configured at user scope (`~/.claude.json`). Three are stdio via npx; `x-api` is
remote HTTP.

| Server | Tools | Auth | Use for |
|---|---|---|---|
| `matchday` | 6 (`get_standings`, `get_matches`, `get_top_scorers`, `find_team`, `get_team_matches`, `compare_teams`) | `FOOTBALL_DATA_TOKEN` | **First choice** for league tables, fixtures, results, form, scorers |
| `sports-hub` | 57 across 6 providers — football-relevant: `espn_*` (10), `footballdata_uk_*` (2), `sportsdb_*` (13), `sportsrc_*` (7) | none | Live/in-play scores, squads, player detail, news; cross-checking the Football-Data.co.uk CSVs the pipeline ingests; **team-name aliases and cross-provider IDs** via `sportsdb_search_teams` |
| `footballbin` | 1 (`get_match_predictions`) | none | **Benchmark only** — third-party PL/UCL predictions |
| `x-api` | posts, full-archive search, users/timelines, trends | `X_BEARER_TOKEN` | @robtFPL and FPL team news — **dormant, see below** |

Rules:

1. **`matchday` before ESPN** for tables and fixtures — cleaner, purpose-built output. ESPN for live state, rosters, and player bios.
2. **`footballbin` is a comparator, never a data source.** Its predictions must never feed our models. It is for asking whether our engine agrees with an outside forecaster.
3. **MCP is for development-time verification, not production code paths.** The pipeline runs in GitHub Actions where no MCP server exists — never make a pipeline module depend on MCP data. Model training inputs come from the pipeline's own sources so runs stay reproducible.
4. **Never route The Odds API through MCP.** `sports-hub` can be configured with a The Odds API provider; do not give it `ODDS_API_KEY`, as it would spend the production quota.
5. **Rate limits**: football-data.org free tier is ~10 req/min. Make the fewest calls that answer the question.
6. **Canonicalise MCP team names** via `pipeline/data/team_mapping.py` conventions before joining with pipeline data. `sportsdb_search_teams` is a useful *aid* here — it returns `strTeamAlternate` alias lists plus `idESPN`/`idAPIfootball` cross-provider IDs — but it is not authoritative (its Wolves alias list contains the typo `Wolverhapton`). Use it to propose mappings, never to auto-generate them.
7. **`sports-hub` also carries non-football providers** (`f1_`, `openf1_`, and darts/other sports via `sportsdb_`). Those are there for the user's personal interests and are **out of scope for this repo** — never wire them into the pipeline, the frontend, or this project's agents.

### The football-data.org token

`matchday` is registered with `FOOTBALL_DATA_TOKEN=${FOOTBALL_DATA_TOKEN}`, which Claude Code expands from the **process environment** — not from this repo's `.env`.

The token is exported from **`~/.zshenv`**, deliberately not `~/.zshrc`: `.zshrc` is only sourced by *interactive* shells, so a token placed there is invisible to non-interactive shells, scripts, and any tooling not launched from a terminal. `.zshenv` is sourced by every zsh invocation. Verify with `claude mcp list` — no `Missing environment variables` warning means the expansion resolved.

If that warning ever reappears (for example if the editor launches Claude Code without going through zsh at all), the guaranteed fallback is to store the literal value in the server's `env` block in `~/.claude.json` instead of the `${...}` reference.

### The X server (`x-api`) — what it can and cannot do

X's own hosted MCP, `https://api.x.com/mcp`, live since 30 June 2026. Preferred over the community
X servers for the same reason `matchday` beats ESPN here: maintained by the data's owner, nothing to
deploy, and no scraper whose terms position is unresolved.

**Registered dormant.** The header expands `${X_BEARER_TOKEN}`, which is not set, so `claude mcp list`
reports `Missing environment variables` — the intended state, not a fault. Export it from `~/.zshenv`
(same reasoning as the football-data token above) to activate.

Two constraints decide what this is worth, and neither is obvious:

- **It cannot feed the news poller.** Rule 3 above is not a style preference here: `news.yml` runs
  every 15 minutes in GitHub Actions, where no MCP server exists and no MCP client is running. An MCP
  tool is available to a Claude Code *session* and nowhere else. So `x-api` does not automate
  anything — the 3-hourly automated lane needs an HTTP API the poller can call itself, which is what
  `pipeline/data/grok_feed.py` is for.
- **The MCP layer is free; the X API underneath is not.** Every call bills pay-per-use — $0.005 per
  post read, $0.010 per user read. X discontinued its free tier for new developers in February 2026,
  so a new account must buy credits before the first call returns anything.

The route from something read here into the model is **`pipeline/learning/file_claim.py`** — the
manual claim lane. It stamps source, tier, verbatim quote, URL and `claimed_at`, and the row then goes
through R0–R8 exactly like an RSS claim. Never let an MCP-read post reach a projection any other way:
that path has no provenance and no conflict adjudication.

### Quirks confirmed against the live APIs

These bite silently, so check them before joining MCP data with pipeline data:

- **Season labels differ.** football-data.org labels a season by its *start year*: the 2025-26 season reports as `2025`. The pipeline uses `"2526"`, with `CURRENT_SEASON="2627"` (see `SEASON_LABELS` in `pipeline/config.py`). Never compare these strings directly.
- **Club names carry legal suffixes.** `matchday` returns `Arsenal FC`, `Manchester United FC`, `Wolverhampton Wanderers FC`, `Brighton & Hove Albion FC`, `AFC Bournemouth` — whereas Football-Data.co.uk uses `Arsenal`, `Man United`, `Wolves`. Everything must go through `pipeline/data/team_mapping.py`.
- **Off-season is genuinely empty.** As of the 2026-27 pre-season, `matchday get_matches` with `status: "SCHEDULED"` returns "No matches found" and `footballbin` errors out (below). Completed-season data (final tables, results, form) works fine. Empty results right now are correct, not a bug to chase.

Notes on current state:
- `sports-hub` is scoped to **keyless** providers via `SPORTS_HUB_PROVIDERS=espn,footballdatauk,sportsdb,sportsrc,f1,openf1` (57 tools of the 396 it can expose). Every one of these works with no credentials. Do **not** switch to the `soccer` or `all` preset — those pull in key-gated providers that fail without credentials: `API_FOOTBALL_KEY`, `SPORTMONKS_API_KEY`, `HIGHLIGHTLY_API_KEY`, `CRICKETDATA_API_KEY`, `ENTITY_SPORT_KEY`, and `FOOTBALL_DATA_API_KEY` (sports-hub's own name for the football-data.org token — distinct from matchday's `FOOTBALL_DATA_TOKEN`, though the same value works).
- **Highest-value providers still un-enabled**, should we ever want them (each needs a free-tier signup): `apifootball_` (15 tools — real **injury** data, predicted **lineups**, transfers; the `/evidence` and `/captaincy` pages currently have no injury/lineup source) and `oddsio_`/`sgo_` (alternate books with their own quotas, so they can cross-check `/value-bets` without touching our 500-req/month `ODDS_API_KEY`).
- `footballbin` returns an unparseable plain-text `"No matches"` from its upstream between seasons, surfacing as a JSON parse error. Expected in the off-season — re-test once fixtures resume.

## Subagent delegation

Seven agents in `.claude/agents/`, tiered by model. Route work to the cheapest agent that can do it properly.

| Task | Agent | Model |
|---|---|---|
| Model maths, priors, ensemble weights, Monte Carlo, calibration, Kelly | `quant-modeller` | opus |
| Reviewing a diff before commit/PR | `code-reviewer` | sonnet |
| Data ingestion, API fetching, quota handling, name mapping | `data-integrator` | sonnet |
| Next.js pages, components, frontend data flow, vitest | `frontend-dev` | sonnet |
| Comparing our predictions vs market/competitor/results | `benchmark-analyst` | sonnet |
| Fetching real football facts via MCP | `football-data-scout` | haiku |
| Running test suites, checking the JSON contract | `contract-guardian` | haiku |

Guidance:
- Send **anything that changes a predicted probability or a stake size** to `quant-modeller`. That work justifies the strongest model.
- Send **raw data lookups** to `football-data-scout` rather than making MCP calls in a reasoning-heavy context — it is far cheaper and returns structured data without analysis. `benchmark-analyst` should delegate its fetching this way.
- Send **verification** to `contract-guardian` before committing. It runs commands and reports; it does not fix, so route its findings to the owning agent.
- Launch independent agents in parallel in a single message. `data-integrator` and `frontend-dev` rarely conflict; `quant-modeller` and `contract-guardian` should run sequentially since the latter verifies the former.
