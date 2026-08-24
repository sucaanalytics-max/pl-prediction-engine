# One team, one week ahead: the dashboard cut to a planner

*Design, 2026-08-23. Supersedes the structural half of
`2026-08-18-surface-restructure-design.md`, which prescribed a 26 → 4 route cut,
was deliberately held off `main` until after the GW1 deadline (2026-08-21T17:30Z),
and was never executed. Two further surfaces — `/control-room` and `/capture` —
were added after it was written. This document takes the same measure and supplies
the two decisions it was missing: which product the dashboard is, and how many
teams it serves.*

---

## The brief

Benchmarked by the owner against solioanalytics, fplreview, fplteam and
livefpl.net: *"our interface is too complex and difficult to use compared to
theirs."*

Four decisions, taken 2026-08-23:

1. **Product — the fplreview/Solio shape.** A pre-deadline planner: land on a
   rolling multi-gameweek expected-points view with the squad and one call. Not
   livefpl's in-gameweek tracker.
2. **Teams — one.** The dashboard serves entry `20945` only. Ronny (`2561567`) and
   Wazza (`2561099`) detach to a separate project which will run them for the
   season on scheduled workflows.
3. **Deletion — yes.** Superseded routes are deleted and their URLs `410`'d. They
   are not kept for comparison.
4. **Device — desk-first.** Dense analyst panels. The 2026-08-17 decision stands.

## Why the interface is complex, mechanically

Not taste, and not incremental drift. The cause is written in the shipped tree's
own docstrings, in three files:

- `frontend/app/page.tsx:37-39` — *"`/now`, `/margin`, `/decide` and the six other
  paths this is meant to absorb all still work, unchanged, so the two surfaces can
  be compared before anything is destroyed… rescue precedes deletion."*
- `frontend/components/Navigation.tsx:80` — *"…compared before anything is
  retired."*
- `frontend/app/control-room/page.tsx:8-12` — *"It ships alongside `/`, `/now` and
  `/margin`, unchanged, so the two surfaces can be compared before anything is
  replaced."*

Each redesign shipped a new surface beside the old ones pending a comparison that
never concluded. Five routes now answer *who do I captain this week* — `/`,
`/now`, `/margin`, `/decide`, `/control-room` — and nine more are redirect stubs.

**The rule this document adopts instead: a surface is re-mounted and its
predecessor deleted in the same commit.** Deletion is not deferred to a later
session, because it has been deferred three times.

## The measure of the cut

Routes 28 → 5. Nav destinations 12 → 3; nav groups 4 → 0. FPL entries 2 → 1;
entry labels 2 → 0. Lines deleted: **5,041 route** + **4,698 component** =
**9,739**, plus their tests, against 51,085 in `frontend/{app,components,lib}`.
Routes created: 0.

## Target structure

### `/` — the call and the horizon

**The one question:** What is my XI, who is captain, and what do the next seven
weeks look like.

**Absorbs:** `/now`, `/margin`, `/decide`, `/decisions`, `/control-room`, and the
stubs `/captaincy`, `/optimizer`, `/planner`, `/transfers`, `/intelligence`.

**Carries:** `GameweekCall` (one captain: the model argmax over `xp_public`; one
total, labelled `captain not doubled`); `SquadBoard` (the fifteen, each with its
own xP, carrying the capture date); `ScoreView` → `Planner` (per-week expected
points from the projection's `horizon` block); and **`PlanGrid`**, newly mounted —
players × gameweeks with per-week start / bench / captain / not-in-squad marks.
A link to `/capture`, not a nav entry.

### `/players` — the shortlist

**The one question:** Who could I bring in, and how wide is the spread on him.

**Absorbs:** `/margin?view=players`, `/projections`, `/rankings`, and
`app/players/page.tsx`'s own 763 lines.

**Carries:** `components/margin/ResearchView.tsx` re-mounted — the only surface
reading `xp_public` end to end with quantiles. Keeps `projectionSourceLabel`
(`app/players/page.tsx:604-606`), the app's sole honest provenance render, on
whatever heuristic columns survive.

### `/evidence` — do I believe it

**The one question:** What moved since I last looked, and how much of this is
guessed.

**Absorbs:** `/margin?view=news`, `/inbox`, `/accuracy`, `/health`.

**Carries:** its existing `evidence_view.json` claims, plus
`components/margin/NewsView.tsx` (the squad join the pipeline could not do) and
`components/margin/WatchView.tsx` (decay ledger, and the perfect-model
calibration ceiling from `accuracy.json`, which is what makes `/accuracy` and
`/health` redundant rather than the reverse).

### `/capture` — the position

**The one question:** What do I actually hold, and at what purchase prices.

**Carries:** unchanged. Reached from `/`, absent from the nav. It is the input
`_read_entry` reads first (`run_agent.py:1015-1027`), so it is what lets the agent
decide for the owner's own team at all.

### `/offline` — not navigable

Service-worker fallback, unchanged. Listed only so the `public/sw.js`
`SHELL_ROUTES` edit is complete.

## The detachment

### Pipeline

`pipeline/config.py:453` `FPL_ENTRIES` becomes one entry: `20945`, objective
`season`. Both bot entries are removed.

Three properties make this cheap, and all three were verified rather than assumed:

- **`FPL_ENTRIES` has exactly two consumers in the whole pipeline** —
  `run_agent.py:1093` (the import) and `:1111` (the loop). Nothing else reads it,
  and the loop is generic over whatever it is given.
- **The seal is entry-independent.** `seal_forecast` (`run_agent.py:766`) seals
  `artifact["players"]` over `resolve_universe(bootstrap)` — the 499-row universe,
  not a squad — and runs *before* `_decide_for_entries`. Its own comment: *"The
  forecast is sealed BEFORE any decision is attempted, and stays sealed even if the
  decision fails."* GW1's sealed record stays valid and measurable. **No seal risk.**
- **The owner's squad is already wired.** `_read_entry` reads the committed capture
  first, then FPL live, then config.

`decide()` is **not** simplified to a single entry. Its parameters — `objective`,
`held`, `bank`, `free_transfers`, `purchase_prices`, `entry_label` — are already
generic, so leaving them alone costs nothing and lets the agent-teams project
vendor `pipeline/decide/` instead of reimplementing a MILP.

**Artifacts lose their label suffix:** `decision_public_gw{NN}_season.json` →
`decision_public_gw{NN}.json`, and the same for `sensitivity_gw{NN}_*.json`. One
consumer, so this is a coordinated rename, not a migration.

### A gate that stops mattering

`_field_calibrated_gameweeks` (`run_agent.py:1044`) is hardcoded 0 because no
per-gameweek calibration verdicts are persisted, and `run_decide.py:298` refuses
the **weekly** objective while it is 0. That is what silently demoted Wazza to
Ronny's season plan on every run — so no weekly-variance strategy has ever
actually run here.

With one entry on the season objective the gate never fires. The field model moves
from *blocker* to *optional future work*. This closes the open question recorded on
2026-08-17, which was: build the field model, drop the gate with a caveat, or
collapse to one team. The owner chose collapse.

### Frontend

`ENTRY_LABELS` (`lib/data/narrow.ts:1493`), the `entry_label` narrowing
(`:889`, `:975`, `:1180`, `:1431-1447`) and the two-argument
`decisionDescriptor(gameweek, label)` (`:1505`) all collapse to label-free. Their
only real users are routes being deleted: `ENTRY_LABELS.map` at
`app/decide/page.tsx:605`, and `ronnyResult` / `wazzaResult` at
`app/control-room/page.tsx:152-154`.

## Feeding the planner — the only real build

The planner is empty today, and the cause is not what it appeared to be.
`refresh_expected_points` calls `_project_horizon` **unconditionally**
(`run_agent.py:528`) and threads the result into `_publish_public_xp` (`:575`), so
the horizon is published on *every* refresh run. The machinery is proven: the GW1
sealed record (`predictions/fpl/ledger/gw01/forecast.jsonl`, header `horizon`)
carries **eight real weeks**, ten fixtures each, `market_blend` for GW1 and
`dixon_coles_posterior+level` for GW2-8, with mean expected minutes declining
29.99 → 24.15 across the horizon. Red-team finding #3 in
`docs/fplreview-replacement.md` — "a scalar on finished totals" — has already been
fixed: the availability haircut now enters as role probabilities before
simulation, so it crosses the 60-minute and appearance gates correctly.

Two defects starve it, and both are code-provable:

1. **Refresh does not run outside a 48-hour window.** `REFRESH_WINDOW =
   timedelta(hours=48)` (`schedule.py:44`), gated at `:379`. Today the GW2 deadline
   is 126 hours away, `agent_status.json` reports `phase: idle`, and no
   `xp_public_gw02.json` exists anywhere in the tree. The frontend resolves GW2
   correctly (`useCurrentGameweek` = `agent_status.gameweek`) and fetches
   `fpl/xp_public_gw02.json`, which has never been written. Retention is keyed per
   gameweek (`useArtifact.ts:167-168`), so nothing falls back. **The captain, the
   XI, the squad's xP and the planner are all absent for roughly 4.5 days of every
   7.** This is the largest single cause of "difficult to use", and it is a cadence
   defect, not a layout one.

2. **`_project_horizon` breaks at offset 0.** The loop
   (`run_agent.py:661-688`) starts at `target = gameweek` and `break`s when a
   target week has no unplayed fixtures. Once the current gameweek's fixtures are
   finished, `weeks` is empty, `len(weeks) < 2` returns `None` (`:733`), and weeks
   1-7 — which do have fixtures — are discarded with them. The `break`'s comment is
   right about a genuinely blank gameweek and wrong about a finished one.

**Changes:**

- Publish a projection for the next gameweek continuously rather than only inside
  48 hours. Cadence to be chosen by measurement, not by preference: time one
  `_project_horizon` (8 × `simulate_gameweek` at `n_draws_horizon = 5_000`) before
  committing. If it is minutes rather than seconds, the honest answer is a daily
  horizon, and the spec says daily.
- Distinguish *finished* from *genuinely empty* in the horizon loop: skip a played
  week, `break` only past the published schedule. Preserve the existing refusal to
  pad with zeros — an invented zero tells the optimiser every player blanks.
- Leave `n_draws_horizon` alone. A horizon number and a decision number are
  different statements about precision, and `build_horizon_block` already carries
  `n_draws` so a screen can say which it is showing.

Nothing in the read path needs building. `lib/data/projections.ts:237` already
narrows the xP horizon; `lib/data/narrow.ts:1488` already narrows the decision
horizon; `Planner` already consumes the first and `PlanGrid` the second.

## The seam to the agent-teams project

What that project needs from this repo, and nothing more:

- **`xp_public_gw{NN}.json` including the `horizon` block** — per-player xP for the
  forward weeks. Already in Supabase Storage and committed to the repo, and
  described by `pipeline/fpl/public_xp.py` as a *stable contract*, deliberately
  decoupled from the private artifact whose shape follows the model.
- **The two identities and their semantics** — Ronny `2561567` (season: maximise
  expected points, variance is a cost); Wazza `2561099` (weekly: maximise
  P(score ≥ threshold), variance is an asset).
- **One inherited problem, stated plainly.** The weekly objective requires a
  calibrated field model. `field_observations.consecutive_calibrated` exists and is
  tested, but nothing persists per-gameweek calibration verdicts, so the gate reads
  0 and always will until scoring writes them. That project does not get a working
  weekly agent for free.

**One hard rule:** it must never write into `predictions/fpl/ledger/` or any
`_seal` / `_settle` path in this repo. Read projections; keep its own ledger. A
seal is irrecoverable and there are 38 in a season.

## Rescue before deletion — the ordering that is not optional

Three components are imported **only** by `app/margin/page.tsx`, the route being
deleted. Deleting it first strands all three, which is the failure this repo has
already had once.

| Component | Lines | Only importer today | Re-mount at |
|---|---|---|---|
| `margin/ResearchView.tsx` | 591 | `app/margin/page.tsx` | `/players` |
| `margin/NewsView.tsx` | 365 | `app/margin/page.tsx` | `/evidence` |
| `margin/WatchView.tsx` | 406 | `app/margin/page.tsx` | `/evidence` |
| `margin/PlanGrid.tsx` | 295 | **none** | `/` |

`PlanGrid` is the discovery. 295 lines plus a 170-line test, rendering players ×
gameweeks with per-week start/bench/captain marks — the fplreview view — built,
tested and mounted nowhere. It is rescued, not deleted.

`ScoreView` → `Planner` already reaches `/` and needs no move.

**Also note a duplicate pair:** `components/SquadBoard.tsx` (285) is used by `/`
and survives; `components/squad/SquadBoard.tsx` (399) is imported only by
`components/control-room/Squad.tsx` and dies with it.

## Deletions

**Routes (23, 5,041 lines).** `/now` (206), `/margin` (129), `/decide` (613),
`/decisions` (205), `/control-room` (596), `/inbox` (291), `/accuracy` (273),
`/health` (384), `/bet` (102), `/markets` (354), `/bankroll` (576), `/matches`
(215), `/matches/[id]` (612), `/h2h` (330), and the nine stubs `/captaincy`,
`/optimizer`, `/planner`, `/transfers`, `/rankings`, `/projections`,
`/intelligence`, `/table`, `/value-bets`.

**Components (4,698 lines).** `margin/DecideView` (885), `control-room/Matrix`
(787), `control-room/parts` (268), `control-room/Queue` (273),
`control-room/Ambient` (236), `margin/Shell` (255, the whole tab shell, its
`ModeChip` and its `?view=` alias table), `FixtureTable` (279),
`margin/SquadInterval` (163), `BetTable` (110), `HistoricalMatchDetails` (181),
`PnLChart` (109), `ScorelineHeatmap` (100), `DistributionChart` (83),
`SHAPWaterfall` (75), and their tests.

Plus one four-link chain that dies together, verified rather than assumed:
`app/control-room/page.tsx` → `control-room/Squad` (164) → `squad/SquadBoard`
(399) → `squad/SquadRow` (331). Each has exactly one importer, the one above it.

**Chrome.** `Navigation.tsx`: `NavGroup`, all four groups, `badge`/`valueBadge`,
the `REGISTRY.latest` fetch and `valueBetCount` (computed on every page load of
every route, rendered nowhere), the second deadline clock, and the status block
that reports `latest.json`'s age under the words "draft captured".

**Registry.** `REGISTRY` entries `table`, `h2h`, `latest`, `blendWeight` —
`blendWeight` already has no consumer; the rest lose theirs with the match and
betting screens. `n_value_bets` (`narrow.ts:111,148`), narrowed, never rendered,
and null on every row of the shipped `latest.json`.

**Not deleted: odds ingestion.** It is pipeline-side and feeds the market-blended
fixture rates behind FPL expected points — `market_blend` is the GW1 rate source
in the sealed record. Killing the feed would silently degrade the projection. The
Odds API's 500-request monthly ceiling and the 30-minute cache are untouched.

**How the 410 is served.** There is no `middleware.ts` in the tree today and no
`410` anywhere in the frontend, so this needs building rather than assuming. One
`frontend/middleware.ts` holding the 23 gone paths as a `matcher` array and
returning `new NextResponse(null, { status: 410 })`. Not `next.config.js`
`redirects`, which can only produce 307/308; not a `route.ts` per path, which
would be 23 files to avoid 23 files.

The file is `middleware.ts`, **not** `proxy.ts` — this frontend is on Next.js
14.2 (`frontend/package.json`), and the `proxy.ts` rename is a Next.js 16 change.
Verify it survives `npm run build:cloudflare` as well as the Vercel target, since
both are shipped.

**Service worker, same commit.** Drop the deleted routes from `public/sw.js`
`SHELL_ROUTES` and bump `CACHE_NAME` **in the same commit**, or `cache.addAll`
rejects atomically and every installed PWA precaches nothing.

## The enforcer

`frontend/test/route-allowlist.test.ts`: the set of `app/**/page.tsx` files equals
exactly `{/, /players, /evidence, /capture, /offline}`. Adding a sixth surface is
then a red build.

This is the piece all three prior plans lacked. Aug 11, Aug 17 and Aug 18 each
prescribed deletions and relied on intent; the intent lost three times. The repo
already trusts this pattern elsewhere — `test/no-untracked-imports.test.ts` guards
the sync-duplicate class of defect the same way.

`test/nav-coverage.test.tsx` shrinks to one assertion: the nav links exactly `/`,
`/players`, `/evidence`. Its `NOT_IN_NAV`, `BEHIND_BETTING_INDEX`, `isRedirect()`
and the three betting-boundary tests go.

## Sequencing

Each step is a commit that leaves `main` green.

1. **Pipeline: entries.** `FPL_ENTRIES` → one entry. Rename the decision and
   sensitivity artifacts. Update `pipeline/tests`.
2. **Pipeline: the horizon.** Fix the offset-0 break; measure
   `_project_horizon`; choose and implement the refresh cadence. Verify a
   `horizon` block appears in `xp_public_gw{NN}.json` for the *next* gameweek.
   This lands before any frontend deletion, so the surviving screen has data.
3. **Frontend: rescue.** Mount `ResearchView` at `/players`, `NewsView` +
   `WatchView` at `/evidence`, `PlanGrid` at `/`. Nothing deleted yet; the tree
   is briefly redundant and always green.
4. **Frontend: delete.** All 23 routes, the orphaned components, the chrome, the
   registry entries, `sw.js` + `CACHE_NAME` — one commit, with the allow-list test
   added in it.
5. **Frontend: entry labels.** Collapse `decisionDescriptor` and drop
   `ENTRY_LABELS`.

Step 2 before step 4 is the point. Deleting first would leave one screen that is
blank four days a week, and the temptation to restore a deleted route rather than
fix the cadence.

## Verification

```bash
PYTHONPATH=. .venv/bin/python -m unittest discover -s pipeline/tests -v
cd frontend && npm run test && npm run lint && npm run build
```

Redirect output and check `$?`; piping to `tail` reports tail's status and a
failing suite reads as a pass. Use the repo venv — bare `python3` is a Homebrew
3.14 without scipy and degrades to 56 import errors that look like a regression.

Per-step gates beyond the suites:

- Step 1: a decision artifact is written for `20945` and none for the two bot
  entries. `predictions/fpl/ledger/gw01/` is byte-identical afterwards.
- Step 2: `xp_public_gw{next}.json` exists outside the 48-hour window and carries
  a `horizon` block with ≥ 2 weeks. The measured `_project_horizon` runtime is
  recorded in the commit message.
- Step 4: `curl` each deleted URL → 410. The PWA reinstalls and precaches the
  three shell routes.

## Out of scope, deliberately

- **Live in-gameweek surfaces** — live points, live rank, effective ownership,
  price-change tracking. These are livefpl's product, they need the uncalibrated
  field model, and the owner chose the planner.
- **The field model and its calibration verdict store.** No longer a blocker; it
  becomes the prerequisite for a weekly objective, wherever that is next attempted.
- **Match prediction as a browsable surface.** `/matches`, `/matches/[id]`, `/h2h`
  and `/table` are deleted. The models keep running and keep feeding FPL expected
  points; they stop having screens.
- **Auto-submission to FPL.** Rejected previously as fragile and against FPL's
  terms. `/capture` plus an approve/override/veto flow remains the write path.

## Risks

- **The horizon cadence cost is unmeasured.** Mitigated by measuring before
  choosing, and by the fallback of a daily rather than hourly horizon.
- **`provisional` weeks currently carry `objective: 0.0`** in
  `decision_public_gw01_season.json` while their XIs and captains differ per week.
  The per-week plans are real; the per-week objective figure is unpopulated. Do not
  render that field until it is traced — `PlanGrid`'s own docstring already refuses
  to print the producer's `objective` under a heading that says "points", and that
  refusal is correct.
- **Deleting 23 routes at once is a large diff.** Mitigated by the rescue step
  landing first, by the allow-list test landing in the same commit, and by three
  bots pushing to `main` — rebase and use the `push-and-watch` procedure.
