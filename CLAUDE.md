# PL Prediction Engine

Premier League match prediction and value-betting engine, plus an FPL decision-support frontend.

**This repo is public** (`sucaanalytics-max/pl-prediction-engine`) and so is the deployed
site (`pl2627.vercel.app`). Anything committed under `predictions/` is published to the
world. That rules out committing licensed third-party data — see *Third-party data* below.

## Architecture

```
Python pipeline (GitHub Actions, daily 06:00 UTC)
  → predictions/*.json
  → copied to frontend/public/predictions/ + uploaded to Supabase Storage
  → Next.js 14 frontend (Vercel + Cloudflare)
```

There is **no runtime coupling between Python and Node**. The only contract is the shape
of the JSON — produced by `pipeline/run_pipeline.py`, consumed by the narrowers in
`frontend/lib/data/narrow.ts`. Nothing enforces it, so drift is silent until a page
renders blank. Changing one side means changing the other.

`narrow.ts` carries the repo's **rule 4: runtime narrowing, never `as T`.** Every
`raw.foo` access in the app lives in that one file, because a field read outside a
narrower is a field the fixture tests cannot protect. Its predecessor,
`frontend/lib/predictions.ts`, did `return await res.json()` inside a generic — an
implicit cast that let `HealthData` drift to a producer emitting no metrics with no
error anywhere. That file is gone; do not reintroduce the pattern.

### Pipeline

`pipeline/run_pipeline.py` — one `run_pipeline()` function, **14 steps** marked
`# ── Step N`: fetch data → referee profiles → feature engineering → PenaltyBlog
baseline → PyMC Dixon-Coles → XGBoost → sub-models → optional stacking → live odds →
Monte Carlo (10k sims, 7×7 scoreline grid) → export JSON → Supabase upload.

- `pipeline/config.py` — **all** hyperparameters, URLs, env vars, ensemble weights, risk
  limits, `X_SCAN_ACCOUNTS`. Put configuration here, not inline in modules.
- `pipeline/models/` (17) — `dixon_coles.py` (PyMC/NUTS), `dc_mle.py`,
  `xgboost_model.py`, `penaltyblog_baseline.py`, `ensemble.py` (60/30/10 DC/XGB/PB),
  `market_rates.py`, `devig.py`, `fixture_rates.py`, `minutes.py`, `player_events.py`,
  `fpl_inputs.py`, `corners_negbin.py`, `cards_zip.py`, `player_cards.py`,
  `goalscorer.py`, `calibration.py`
- `pipeline/data/` (16) — `football_data.py`, `fpl_api.py`, `fbref.py`, `understat.py`,
  `odds_api.py`, `market_snapshots.py`, `referee_profiles.py`, `team_mapping.py`,
  `news_feeds.py`, `news_extract.py`, `availability_news.py`, `grok_feed.py`,
  `x_scan.py`, `x_relevance.py`, `youtube.py`, plus `priors/` and `schemas/`
- `pipeline/learning/` (28) — **the largest package.** Phase machine and seal
  (`schedule.py`, `ledger.py`, `outcomes.py`, `run_agent.py`), the manual claim lane
  (`file_claim.py`), evidence and conflicts (`availability_evidence.py`,
  `minutes_conflicts.py`, `availability_conflicts.py`), views (`news_view.py`,
  `evidence_view.py`, `messages.py`), and the learning loop (`accuracy.py`,
  `backtest.py`, `walk_forward.py`, `fit_market_blend.py`, `sensitivity.py`,
  `calibration_check.py`, `scoring.py`, `gates.py`)
- `pipeline/decide/` (7), `pipeline/fpl/` (10), `pipeline/knowledge/` (1)
- `pipeline/features/engineer.py`, `pipeline/simulation/montecarlo.py`,
  `pipeline/risk/kelly.py`, `pipeline/explainability/shap_explain.py`
- `pipeline/validation/` — `run_validation.py`, `metrics.py`, `ledger.py`, `artifacts.py`

### Frontend

Next.js 14 App Router. **Eight live pages**, all `"use client"` except
`app/offline/page.tsx`:

`/` · `/capture` · `/evidence` · `/offline` · `/phases` · `/players` · `/review` · `/stats`

- `/stats` — "what is this player actually doing": a dozen columns across three sources
  with three different warranties (FPL's record, our simulation, Understat's own xG
  model). **Tabs are split by warranty, not by question**, precisely so incomparable
  columns are never read against each other. Follow this pattern for new data surfaces.
- `/evidence` — absorbed the former `/inbox`, `/accuracy` and `/health`.
- `/capture` — records the squad actually submitted to FPL, via `/api/hub/position`.
  Nothing to do with capturing posts.

**22 routes were deliberately retired** and return **410 Gone** via
`frontend/middleware.ts` (410 not 404: they were real destinations, several precached by
`public/sw.js`, some bookmarked). The `GONE` set is exported so one test exercises the
real handler. Before proposing a page, check that set — `/table`, `/h2h`,
`/intelligence`, `/rankings`, `/captaincy`, `/optimizer`, `/planner`, `/transfers`,
`/value-bets`, `/bankroll`, `/matches` and `/health` are all gone.

Two separate data paths:
- **Predictions** — `frontend/lib/data/narrow.ts` (narrowers + descriptor table),
  `lib/data/load.ts` and `lib/data/registry.ts`. Fetches Supabase Storage when
  `NEXT_PUBLIC_SUPABASE_URL` is set, **falling back to local `/predictions/`** on any
  failure. Keep that fallback.
- **Live FPL** — `frontend/app/api/fpl/state/route.ts` → `frontend/lib/fpl-live-server.ts`
  → Supabase snapshot table via `fpl-snapshot-store.ts`.

Design tokens live in `frontend/lib/margin/tokens.ts` (`FLOODLIT`, `SANS`). Use them.

## Commands

```bash
# Pipeline tests (unittest, NOT pytest — no pytest config exists)
# Use the repo venv. Bare `python3` is a Homebrew 3.14 WITHOUT scipy, and the
# suite degrades misleadingly under it — import errors read as a code regression
# rather than a missing interpreter.
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v

# Piping to `tail`/`head` masks the exit code — `cmd | tail` reports tail's
# status, so a failing suite looks like a pass. Redirect, then check `$?`.

# Frontend
cd frontend && npm run test    # vitest run
cd frontend && npm run lint
cd frontend && npm run build   # Vercel target; build:cloudflare for the other
```

**Green baseline, measured 2026-09-04:** 2158 python tests (5 skipped), 1081 frontend
tests across 70 files. If you see materially fewer python tests, you are on the wrong
interpreter.

CI: `.github/workflows/pipeline.yml` (daily), `validate.yml` (Sundays, writes
`health.json`), `frontend.yml` (test → lint → build, Node 24), `news.yml` (15-minute
poller), `fpl_agent.yml`, `x_scan.yml` (dispatch-only), `python.yml`.

## Hard constraints

- **The Odds API free tier is 500 requests/month** and the daily pipeline run consumes
  it (`pipeline/data/odds_api.py`, 30-min cache, per-event markets opt-in via
  `ODDS_FETCH_ADDITIONAL`). Never add an unbounded fetch loop or shorten the cache.
- **Team names must be canonicalised** through `pipeline/data/team_mapping.py`. Every
  provider spells clubs differently; never join on raw provider strings.
- **Kelly staking is real money.** `pipeline/risk/kelly.py` sizes it. On the frontend,
  the hazard is *units*: `latest.json` carries four Kelly fields per bet and two are
  currency while two are fractions, a 1000× difference that one copy-paste renders as
  "5000%". `frontend/lib/data/units.ts` closes this with branded types — keep the
  brands. Never widen stake sizing or drop a risk cap as a side effect.
- **The value-bet firewall.** `pipeline/models/market_rates.py` inverts no-vig prices
  into goal rates *for the FPL projection layer only*. The value-bet path must keep
  computing edge against a lambda **not** derived from those prices, or the "edge" is a
  readout of the price and Kelly stakes real money on a circularity.
- **The pipeline runs unattended**, so a swallowed error yields confidently wrong
  predictions. Optional scraped sources (FBref/Understat) degrade gracefully by design;
  sources the models depend on must fail loudly.
- **Only `predictions/forecast_ledger.json` proves a prediction predated kickoff.**
  Never source an accuracy claim from `latest.json`.
- **Secrets**: `ODDS_API_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `FOOTBALL_DATA_TOKEN`. Service-role keys never go behind `NEXT_PUBLIC_`.

## Third-party data

The repo and the site are both public, which makes redistribution the binding
constraint rather than access:

- **Reading a paid source to inform a decision is fine. Committing it is not.**
  Premium products (e.g. a FantasyFootballFix Opta subscription) may be read in-session
  through the browser to check our numbers. Their figures must stay in a **gitignored
  local file**, render in local dev only, and reach `predictions/` only as *our own
  derived delta* plus a checked-on date — never as their values.
- **Opta-defined metrics are licensed.** Big chances, big chances created and big
  chances conceded are not obtainable from FBref or Understat at any tier we pay for.
  Use npxG-per-shot or a labelled per-shot proxy instead, and say on the page that it
  is a proxy.
- **Other people's images are theirs.** Render an X post through X's own embed, which
  keeps attribution and their analytics intact. Do not download and re-host media.
- **What FBref actually exposes here, and where**: `soccerdata` (installed, works on
  3.14) offers five stat types — standard, keeper, shooting, playing_time, misc — and
  takes `opponent_stats=True` for the conceded side. `fbrefdata` offers eleven,
  including `passing`, `goal_shot_creation`, `possession` and `defense`.

  **`fbrefdata` does not install locally.** Every published version caps at
  `<3.13` and the repo venv is Python 3.14.4, so `from fbrefdata import FBref`
  raises ImportError here and `fetch_fbref_passing_stats` returns `None` by design.
  It is declared in `pipeline/requirements.txt` and installs under CI's Python 3.11
  (`pipeline.yml`), so those four tables exist **only in CI**. Anything built on them
  cannot be run or verified on this machine — fixtures are the only local test, and
  the first real execution is a daily pipeline run. Prefer `shooting` via
  `soccerdata` for work that needs local verification.

## Repo hygiene

`~/Documents` was backed by an iCloud File Provider domain, whose conflict-copy naming
(`foo 2.ts`) produced up to **743 duplicate files at once** — including a byte-identical
copy of the real-money staking module — and eventually corrupted `.git` refs.

**Fixed 2026-08-13 by moving the repo to `~/dev/pl-prediction-engine`**, which is not
file-provider backed. Verified clean again 2026-09-04: zero duplicates, zero `.git`
duplicates, zero untracked files, both suites green.

The detector and remedy remain, because the rest of `~/Documents` still syncs:
- `frontend/test/no-untracked-imports.test.ts` fails on any duplicate shadowing a real file.
- `scripts/clean_sync_duplicates.sh --apply` removes only byte-identical or build-dir
  copies and **reports anything that differs** rather than deleting it.
- `find .git -name "* 2*" -delete` if a git operation ever reports a bad object.

There is deliberately **no `.gitignore` rule**: `* [0-9].*` would also hide a legitimate
`step 2.tsx`, trading a visible problem for an invisible one.

Diagnosing this again: `xattr -p com.apple.file-provider-domain-id ~/Documents`. Looking
for `~/Library/Mobile Documents/CloudDocs/Documents` is the **wrong** test — under the
File Provider API the synced folder stays in place and stats as an ordinary directory.

## Ignore these directories

Build artifacts, present on disk but not source — exclude from searches:
`frontend/.open-next/`, `frontend/.wrangler/`, `frontend/dist/`,
`frontend/.sites-bundle/`, `frontend/.openai/`, `node_modules/`, and generated
`frontend/public/predictions/*.json`.

## MCP football data servers

Four servers at user scope (`~/.claude.json`). Three are stdio via npx; `x-api` is
remote HTTP.

| Server | Tools | Auth | Use for |
|---|---|---|---|
| `matchday` | 6 | `FOOTBALL_DATA_TOKEN` | **First choice** for league tables, fixtures, results, form, scorers |
| `sports-hub` | 57 across 6 providers | none | Live/in-play scores, squads, player detail, news; cross-checking the Football-Data.co.uk CSVs; team-name aliases via `sportsdb_search_teams` |
| `footballbin` | 1 | none | **Benchmark only** — third-party PL/UCL predictions |
| `x-api` | posts, search, users | `X_BEARER_TOKEN` | @robtFPL and FPL team news — **not currently working, see below** |

Rules:

1. **`matchday` before ESPN** for tables and fixtures. ESPN for live state, rosters, bios.
2. **`footballbin` is a comparator, never a data source.** Its predictions must never
   feed our models.
3. **MCP is for development-time verification, not production code paths.** The pipeline
   runs in GitHub Actions where no MCP server exists — never make a pipeline module
   depend on MCP data. The same applies to anything read through the browser in a
   session: it is available to a *session* and nowhere else.
4. **Never route The Odds API through MCP.** `sports-hub` can be configured with a The
   Odds API provider; do not give it `ODDS_API_KEY`.
5. **Rate limits**: football-data.org free tier is ~10 req/min.
6. **Canonicalise MCP team names** via `team_mapping.py` conventions.
   `sportsdb_search_teams` proposes mappings (its Wolves alias list contains the typo
   `Wolverhapton`); never auto-generate from it.
7. **`sports-hub` also carries non-football providers** (`f1_`, `openf1_`, darts). Out
   of scope for this repo.

### Known state, measured 2026-09-04

- **`x-api` fails with HTTP 401** (`AUTH_HEADER_REJECTED`) — the configured
  `Authorization` header is rejected, and OAuth fallback is disabled when a header is
  set. This is a *different* failure from the earlier "Missing environment variables"
  (unset `${X_BEARER_TOKEN}`). Export a valid token from `~/.zshenv`, not `~/.zshrc`:
  `.zshrc` is only sourced by interactive shells, so a token there is invisible to
  scripts. Billing is pay-per-use: $0.005/post read, $0.010/user read.
- **`matchday get_standings` returned HTTP 400** for the Premier League, with and
  without `season: "2026"`. Unresolved; the free tier may not cover 2026-27.
- **The route from a session-read post into the model is
  `pipeline/learning/file_claim.py`** — the manual claim lane. It stamps source, tier,
  verbatim quote, URL and `claimed_at`, and the row then goes through R0–R8 exactly like
  an RSS claim. Never let a session-read post reach a projection any other way.
- **`minutes_conflicts_gwNN.json` is evidence-gated**: it only fires where a scanned
  claim exists to compare against, so a short list means a stale claim feed, not a
  healthy minutes model. Check the `claimed_at` dates on whatever did fire.

### Quirks confirmed against the live APIs

- **Season labels differ.** football-data.org labels a season by its *start year*
  (2026-27 → `2026`). This repo uses `"2627"`, with `CURRENT_SEASON="2627"`
  (`SEASON_LABELS` in `pipeline/config.py`). Never compare these strings directly.
- **Club names carry legal suffixes.** `matchday` returns `Arsenal FC`,
  `Wolverhampton Wanderers FC`, `AFC Bournemouth`; Football-Data.co.uk uses `Arsenal`,
  `Man United`, `Wolves`. Everything goes through `team_mapping.py`.
- `sports-hub` is scoped to **keyless** providers via
  `SPORTS_HUB_PROVIDERS=espn,footballdatauk,sportsdb,sportsrc,f1,openf1`. Do **not**
  switch to the `soccer` or `all` preset — those pull in key-gated providers that fail
  without credentials.
- **Highest-value un-enabled providers** (each needs a free signup): `apifootball_`
  (real injury data, predicted lineups — `/evidence` has no injury/lineup source) and
  `oddsio_`/`sgo_` (alternate books with their own quotas, so they can cross-check
  value bets without touching our 500-req/month `ODDS_API_KEY`).

## Subagent delegation

Ten agents in `.claude/agents/`, tiered by model. Route work to the cheapest agent that
can do it properly.

| Task | Agent | Model |
|---|---|---|
| Model maths, priors, ensemble weights, Monte Carlo, calibration, Kelly | `quant-modeller` | opus |
| Reviewing a diff before commit/PR | `code-reviewer` | sonnet |
| Data ingestion, API fetching, quota handling, name mapping | `data-integrator` | sonnet |
| Next.js pages, components, frontend data flow, vitest | `frontend-dev` | sonnet |
| Comparing our predictions vs market/competitor/results | `benchmark-analyst` | sonnet |
| Fetching real football facts via MCP | `football-data-scout` | haiku |
| Running test suites, checking the JSON contract | `contract-guardian` | haiku |
| Phase machine, ledger, seal, settlement, `fpl_agent.yml` | `seal-warden` | opus |
| Effective ownership, rank tiers, sampling error | `field-analyst` | opus |
| Live routes, cache policy, in-gameweek freshness | `live-surface` | sonnet |

Guidance:
- Send **anything that changes a predicted probability or a stake size** to
  `quant-modeller`.
- Send **raw data lookups** to `football-data-scout` rather than making MCP calls in a
  reasoning-heavy context. `benchmark-analyst` should delegate its fetching this way.
- Send **verification** to `contract-guardian` before committing. It reports; it does not
  fix, so route findings to the owning agent.
- Send **anything under `pipeline/learning/{schedule,ledger,outcomes}.py` or the
  `_seal`/`_settle` paths** to `seal-warden`, whatever the task was called. A seal is
  irrecoverable and there are 38 a season.
- Send **any number whose meaning depends on what other managers did** to
  `field-analyst`. A cheaper model will emit a confident figure without stating which
  population it describes.
- Launch independent agents in parallel in a single message. `quant-modeller` and
  `contract-guardian` run sequentially, since the latter verifies the former.

**Paths own agents, not topics.** Where a path appears above, it wins over the
description of the task.

## Skills

Procedures in `.claude/skills/`, for the things worth doing the same way every time:

- **`rehearse-phase`** — execute the real REFRESH or SEAL against a scratch directory
  before shipping a change to it.
- **`verify-seal`** — check a sealed forecast is real (`dry_run: false`), complete
  (`rows_written` equals `universe_size`) and carries all four provenance fields.
- **`push-and-watch`** — land a commit where three bots also push: rebase, confirm the
  active `gh` account, then watch whichever CI gate the changed paths trigger. The
  active `gh` account is not always the repo owner; check before pushing.

## Saved workflows

Fan-outs in `.claude/workflows/`, invoked by name via the Workflow tool:

- **`seal-audit`** — find ways a seal could be lost, then have three skeptics try to
  refute each finding. Takes an optional scope argument.
- **`field-feasibility`** — re-measure what FPL's API makes affordable. Carries a hard
  request budget, because the same host serves the `bootstrap-static` call the seal
  depends on.
