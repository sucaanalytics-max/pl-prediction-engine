# One control room, three teams

*Design, 2026-08-17. Written after a 16-agent audit of the repository and the live APIs,
and after the owner's brief: rethink the site as one stop for the manual team and the two
automated teams. The owner's two verdicts that shape everything below — "restructure the
whole system" and "too complicated and over built" — reconcile only one way:
**restructure by subtraction.** The engine stays. The website is cut to a sixth of its
surface.*

*The owner delegated the open decisions ("you decide for me"). Section 2 records what was
decided and why, so a later reader can overturn a decision on its reasoning rather than
re-deriving it.*

---

## 1. The diagnosis, measured

The full audit is in the published brief; three findings change what gets built, and each
was re-verified by hand against the working tree before being acted on.

**The two automated teams are one team.** `run_decide.py:298` demotes
`objective="weekly"` to `"season"` whenever the field model is uncalibrated. Calibration
is read from `field_calibrated_gameweeks`, which defaults to `0` at `:195` and which
nothing in `pipeline/` passes or computes. The demotion therefore fires on every run,
always. `field.py`'s `effective_ownership`, `sample_rivals` and `score_field` have zero
non-test callers. `/decide` meanwhile labels that mandate *"Maximises the right tail;
variance is the point"* while it is solved on maximum expected points.

**The market anchor is computed, validated by seven blocking checks, then discarded.**
`fixture_specs_from_predictions` (`fpl_inputs.py:333-364`, called at
`run_pipeline.py:1112`) reads the unanchored ensemble from `latest.json`. Measured on the
committed artifacts:

| GW1 fixture | `fixture_xg` (anchored) | `xp_gw01` (used) | Effect |
|---|---|---|---|
| Arsenal v Coventry | 2.472 / 0.661 | 1.802 / 0.971 | home rate 37% low, away 47% high |
| Hull v Man Utd | 0.918 / 2.029 | 1.483 / 1.622 | a rout priced as near-even |
| Everton v Palace | 1.470 / 1.139 | 1.503 / 1.090 | agrees within 2% |

`xp_gw01.json`'s `rate_source` is `null` on every fixture and its rates are byte-identical
to `latest.json`. The anchor is not degraded; it is never applied. Note the pattern: even
fixtures agree, lopsided fixtures diverge violently — and lopsided fixtures are where
captaincy and defence doubles are decided.

**The site describes entry 20945 beside advice solved for a different squad.**
`NEXT_PUBLIC_FPL_ENTRY_ID` is unset so the live surface defaults to the manual team;
grep the frontend for `2561567` and it returns nothing. `PRIVATE_FIELDS` strips
`entry_id`, so the published payload *cannot* identify which team a decision belongs to.
No page states it, so the mismatch is undetectable from the UI.

Three more that bear on sequencing: the 15-minute news poller runs 96×/day and feeds
nothing (all 207 stored claims carry `claim_type: unparsed_news`, absent from
`AVAILABILITY_TYPES`, so `evidence_view.py:121` discards every one); the learning loop is
broken at both ends, so a promotion passing all eight gates would change no projection;
and `run_agent._settled_outcomes` globs `outcomes.json` while settlement writes
`outcome.jsonl`, so accuracy reports zero settled gameweeks forever, indistinguishable
from the honest pre-season state.

---

## 2. Decisions taken

### 2.1 The two-team question: build the field model. Do not drop the gate.

Three options existed. Dropping the calibration gate was rejected: the gate exists for
exactly the right reason, and presenting a modelled tail as a measured one is the specific
failure the rest of this system is scrupulous about. Collapsing to one team was rejected
because the owner, asked what to cut, kept all four engine subsystems — and because the
insight the two teams exist to test is sharp and correct: writing margin over the field as
`D = Σ (m_j − EO_j)·P_j`, the term `Σ EO_j·xP_j` is a constant nobody can influence, so
effective ownership **cannot** change the EV-optimal pick, only `Var[D]`.

So: build it. The cost is far lower than it looks, because this is mostly wiring code that
already exists plus one free data field.

**But state the timing honestly, because it is the design's most important consequence.**
The gate requires six *consecutive* calibrated gameweeks. GW1's deadline is
2026-08-21T17:30Z. Even with the field model wired this week, Wazza cannot legitimately
run its own objective until roughly GW7. Until then Wazza runs the EV-optimal plan — which
is what happens today, except today it happens silently while the screen claims otherwise.

**This turns the site's biggest lie into its most informative element.** The new surface
shows a live calibration counter — `Wazza · 2 of 6 calibrated gameweeks · running
EV-optimal` — sourced from a real observation count rather than a hardcoded `0`. The gate
working visibly, for the first time, is a feature.

### 2.2 Sequencing: truth before surface

Phase 0 lands before any new screen. The hub's entire value is trust, every finding above
is a way the current site asserts something the engine did not do, and a denser prettier
version of that is worse, not better. Phase 0 is also cheap relative to its impact — the
anchor join is a three-field lookup, the ledger assertion is two lines.

### 2.3 `/margin` wins; the nine routes it was built to replace are deleted

Its own docstring says the workspace exists to supersede nine routes, and all nine are
still in the sidebar. The workspace model is what the owner asked for. Its four tabs
already re-read the same artifacts as `/now`, `/players`, `/evidence` and `/decide`, so
keeping both sides is paying twice for one answer and risking two numbers on screen.

### 2.4 Drop the Cloudflare deploy target

`frontend/` maintains two build paths — `next build` for Vercel and
`opennextjs-cloudflare build`, plus `wrangler.jsonc` and `wrangler.sites.jsonc`. This is a
private single-user tool. A second deploy target maintained for nobody is precisely the
over-building the brief names, and it is the one thing blocking §5's rendering model,
because Cache Components require a Node.js runtime and forbid static export.

**Measured cost of removal: five files, all inside `frontend/`** — `open-next.config.ts`,
`wrangler.jsonc`, `wrangler.sites.jsonc`, and two `package.json` scripts
(`build:cloudflare`, `bundle:sites`, plus `stage:sites`). Nothing outside `frontend/`
references it, and **it appears in no GitHub workflow** — CI has never built the
Cloudflare target. It is maintained for nobody.

### 2.5 Chip selection stays out of scope; its absence gets stated

Chip *scoring* exists and is correct (`plan_eval.py:158-165`). Chip *selection* is
deliberately absent for a stated reason: no defensible reserve-price estimator, and a
discounted max-of-expectations under-prices by Jensen's inequality. That reasoning holds.
It is ~4 decisions a season and does not earn a surface. What it does earn is one honest
line, because today `unmodelled_chips` reaches only a private artifact's metadata and the
committed public artifact has no metadata block at all.

---

## 3. Phase 0 — make the numbers true

Nothing in Phase 0 changes a screen. Each item is independently verifiable and ordered by
value per unit of work.

1. **Anchor the FPL layer.** *(Corrected 2026-08-18 during execution — this item originally
   claimed the horizon too. It does not deliver one; see the correction below.)* These look
   like two bugs and are one architectural fact. `get_upcoming_fixtures` returns *one* gameweek
   (`fpl_api.py:179-183`), so `latest.json` is structurally one week wide and step 10b
   cannot simulate weeks 2–8 whatever else changes. `fixture_xg.json` is the only
   multi-week rate source in the repository. **The change is to make `fixture_xg` the
   daily lane's fixture source, not merely its rate source.** Join on
   `gameweek` + `home_team` + `away_team` — both sides already pass through
   `normalize_team_name`, so only `match_id` differs. Populate `rate_source` in `xp_gw*`
   and fail the artifact contract if it is `null`.

   **CORRECTION (2026-08-18, found in review): the horizon is NOT delivered by this change,
   and the claim above that it is was wrong.** `fixture_xg.json` does carry 8 gameweeks, but
   `simulate_gameweek` accumulates a player's fixtures with `+=` — a mechanism built for
   genuine intra-week double-gameweeks. Feeding it all 80 rows sums eight weeks of points
   into an artifact labelled as one gameweek, and `assert_valid_xp_artifact` has no upper
   bound that would catch it. Every club appears 8 times in that file. So the daily lane
   passes `gameweeks=[gameweek]`. A real horizon requires `simulate_gameweek` called once
   per week emitting per-week artifacts — which `run_agent.py:593-600` already does and the
   daily lane does not — and that is a larger change than Phase 0. **Descoped to a later
   phase.**

2. **Emit a typed availability claim.** The parser is the missing piece, not the resolver:
   84 of 207 stored claims already carry a real `element_id`. Parse `unparsed_news` into
   the existing `AVAILABILITY_TYPES` vocabulary and the whole 15-minute lane starts
   feeding projections. Then pass `evidence=` from the daily lane
   (`run_pipeline.py:1117-1119` omits it while `run_agent.py:320` passes it).

3. **Stop the three silent-forever defects.** Rename to `outcome.jsonl` at
   `run_agent.py:224`; add the kickoff assertion so `is_upcoming` cannot return true on a
   null `kickoff_time` and the ledger cannot absorb a post-hoc forecast; set
   `allow_stale=False` on the daily lane's bootstrap fetch, honouring the contract
   `fpl_api.py:56-62` already states in writing.

4. **Take the free official fields.** All zero-request reads of a payload already
   downloaded: `price_change_percent` (FPL's own new 2026/27 predictor, 15-minute
   refresh), `events[].chip_plays` + `most_selected` + `ranked_count` (the field-variance
   observable §4 needs — captured per gameweek, because FPL overwrites `events[]` in place
   and the public archive does not retain it), `transfers_in/out_event` differenced for
   velocity, `can_select`/`can_transact` replacing the hand-maintained exclusion list,
   `scout_news_link` as the top availability tier, `element-summary/{id}` (already
   declared at `config.py:51`, imported at `fpl_api.py:13`, zero call sites — and it
   **disproves** the assumption at `priors/snapshot.py:11-13`), and `teams[].pulse_id` to
   join the keyless PL fixture API so rest-days stop scoring a midweek European tie as
   7 days rested.

5. **Add per-run and per-fixture provenance.** Today a run with no xG features, no odds
   and a 3-day-old stale bootstrap is indistinguishable from a fully-sourced one, and
   `/health` shows a hardcoded green tick either way (`run_pipeline.py:1198` writes
   `"status": "healthy"` as a literal). The remedy is already written and unwired:
   `fetch_bootstrap_static_with_provenance` and `fetch_fixtures_with_provenance` return
   `(data, Provenance)` with `source ∈ {network, cache, stale_cache}` and `age_seconds`,
   and their only callers discard it.

6. **Delete the FBref path; rewrite Understat.** FBref's advanced stats are gone at
   source — verified, the 2026/27 page renders one basic table — and the "degrades
   gracefully" path returns nothing while recording nothing. Understat's JSON routes work
   but need an `X-Requested-With: XMLHttpRequest` header; the legacy embedded-JSON layout
   every parser targets no longer exists. Its unique value is npxG: FPL's
   `expected_goals` is Opta xG *with* penalties, so any model also crediting the taker
   from `penalties_order` double-counts spot-kick value. Add row-count assertions so the
   next layout change fails loudly.

7. **Rewrite `CLAUDE.md`.** It omits the entire agent subsystem — the largest thing in the
   repository and the whole product for both automated teams — three of six workflows
   including the 15-minute poller, eleven real routes, and eight of eleven data modules
   including the injury parser. Its route list sends a reader to nine redirect stubs, the
   frontend data path it names does not exist, and the Kelly guards it names are dead code.

**Exit criterion.** `xp_gw*` carries a non-null `rate_source` on every fixture, and the
artifact contract FAILS when it is null; every fixture simulated belongs to one gameweek; at least one stored claim carries a
type in `AVAILABILITY_TYPES`; `health.json` distinguishes "no key" from "no edge"; the
Python and frontend suites are green.

**One thing to verify rather than build.** The distribution glyph needs `q25`/`q75`, and
the committed `xp_gw01.json` carries only `q10, q50, q90, q99` — but this is a stale
artifact, not missing code. `gameweek_sim.py:186-198` computes all six,
`public_xp.py:56` already publishes `q25`/`q75`, and the commit that added them
(`4bca1b8`, 2026-08-17 12:11) landed *after* the committed artifact was generated
(06:30 the same day). Confirm on the next run. It matters twice over: the glyph's
interquartile box must be drawn from real quartiles rather than derived from a standard
deviation, and `artifacts.py:145` guards the quantile-monotonicity check on
`all(value is not None)` — so while `q25`/`q75` are absent that contract check silently
does not run.

---

## 4. Phase 1 — make Wazza real

Mostly wiring. `field.py` is written and orphaned; `field_observations.py` has a wired
writer and no reader.

- **A producer for `field_calibrated_gameweeks`.** `field_observations` already captures
  `average_entry_score` and `highest_score`; extend it with `chip_plays`, `most_selected`
  and `ranked_count` from §3.4. Capture per gameweek — this data exists on the live
  bootstrap for the current season only, so an unrecorded gameweek is gone permanently.
- **Pass it.** `run_agent._decide_for_entries` must pass the count into `solve`; today it
  never passes the argument at all.
- **Pre-deadline effective ownership.** Measured EO is structurally impossible before a
  deadline — the picks endpoint 404s before a gameweek is active and captaincy is never
  exposed pre-deadline. LiveFPL's `predictedEOs/{gw}.json` is the only pre-deadline source
  that exists (keyless, ~9KB, verified regenerating four days before the GW1 deadline).
  Treat it as fragile: an undocumented static path on a site mid-migration. Degrade to
  transfer-velocity-derived estimates, and calibrate it post-deadline against tiered
  ownership rather than trusting it.
- **Persist the `(draws × players)` matrix.** This is the binding constraint on Phase 3
  and it must land here. It is the only object either objective can be computed from, it
  currently exists for one process's lifetime, and nothing on disk can reconstruct it —
  `summary_rows` emits per-player marginals and `sim_params` deliberately carries no
  binaries. Without it there is no what-if, no relocated optimiser and no after-the-fact
  decision scoring, which are most of what an approval surface is for. Store it
  compressed, per gameweek, keyed to the sealed decision.

**Exit criterion.** A decision artifact for Wazza shows `objective: weekly` *or* shows
`season` with a real calibration count and a stated reason. The count is never a
hardcoded zero again.

---

## 5. Phase 2 — six surfaces

Twenty-six routes become six. Fifteen are real pages, ten are redirect stubs, and one
workspace duplicates four others. Betting surfaces go entirely — odds ingestion stays,
because bookmaker prices feed the market-blended rates behind every FPL projection.

| Surface | The one question it answers | Absorbs |
|---|---|---|
| **Now** | What needs me, across all three teams? | `/`, `/now`, `/inbox`, `/decisions` |
| **Squad** | What do these three teams currently hold? | new — plus the capture path of §6 |
| **Decide** | What should this team do, and why? | `/decide`, `/margin?view=plan`, 4 stubs |
| **Players** | Who is worth owning, and how sure are we? | `/players`, `/evidence`, `/rankings`, `/projections`, `/intelligence` |
| **Fixtures** | What does the match model say? | `/matches`, `/matches/[id]`, `/table`, `/h2h` |
| **Ledger** | Is this system actually any good? | `/accuracy`, `/health`, `/margin?view=now` |

Deleted outright: `/bet`, `/markets`, `/value-bets`, `/bankroll`, `/optimizer`,
`/transfers`, `/captaincy`, `/planner`, `/offline` (the service worker keeps working;
`SHELL_ROUTES` never referenced the stubs), `/margin` as a distinct route once its content
is promoted.

**Team identity becomes first-class.** A global team switcher across manual / Ronny /
Wazza. This requires a pipeline change, not a frontend hack: add `team_name` and
`entry_id` to the published decision payload. Hardcoding the mapping in the frontend
reintroduces exactly the split source of truth the canonicalisation rule exists to
prevent. Every surface states which entry it is describing; no figure appears beside a
team it was not solved for.

**Promote the distribution glyph.** `Marks.tsx`'s `Distribution`/`describeGlyph` — drawing
a player as a distribution rather than a mean — is the best idea in the frontend and is
locked inside `/margin` by its `PAPER`/`INK` tokens. Re-token it and make it the app-wide
primitive for showing a player.

**Collapse the duplicated derivations.** One gameweek resolver, not three that can fetch
three different gameweeks' projections in one session. One squad-total rule, not two that
disagree on whether to double the captain. One absence vocabulary, not two complete
systems sharing nothing. Zero Kelly implementations, not three for one number — they leave
with the betting surfaces, and with them goes the documented 1000× fraction-versus-currency
hazard.

**Rescue before deleting.** `BetTable.tsx` and `FixtureTable.tsx` are unrendered and hold
the *only* two links to a 612-line match page carrying the scoreline heatmap, SHAP
waterfall and distribution charts. Fold that content into **Fixtures** before deleting the
components. `DecideView.tsx` — 885 lines, the deepest justification UI in the app,
currently imported only by a test — becomes the core of **Decide**.

**Rendering model.** With Cloudflare dropped (§2.4), move to Next.js 16 App Router with
`cacheComponents: true`. This is done *during* Phase 2 rather than after, because Phase 2
rewrites these files anyway and upgrading twice is waste. The shape: a static prerendered
shell, and genuinely per-request state (which team is selected, live FPL state) behind
Suspense boundaries. Client components shrink to the interactive leaves — today 16 files
carry `"use client"` and the app ships its artifact-parsing logic to the browser.

**Scope `use cache` deliberately — it is not free ceremony.** It earns its place over
*remote* reads: Supabase-backed squad state (§6) and artifacts once the mirror covers
them, tagged per artifact with `cacheTag` and invalidated with `updateTag` when an
approval writes. It earns nothing over the git-committed JSON under `public/` — Next and
the CDN already serve those, and wrapping a static asset in a cache directive adds a
cache key to reason about and buys no request. Artifacts that stay in `public/` stay
plain fetches.

**Preserve the absence envelope.** The five-state envelope, per-artifact `isEmpty`,
freshness budgets and four enforcing test suites are good work — build on them, never
around them. `/decisions`, `/inbox` and `/bankroll` bypass them and are exactly where the
defects are. Never raw-fetch an artifact path: a 404 serves 30KB of Next.js HTML, which is
why `load.ts:22-30` checks status before reading the body.

One correction to inherit: several `isEmpty` docstrings are stale in ways that flip UI
behaviour — `registry.ts:125-139` claims every fixture is predicted home (measured 7 home
/ 3 away, so the predicate no longer fires), `registry.ts:115-124` claims minutes are zero
across `player_stats` (measured 400 of 587 non-zero). The file's own rule — "a predicate
that passes on the fixture and fails in production is worse than none, because it will be
trusted" — has been violated by the file that states it. Re-measure every predicate
against committed artifacts and add a test that fails when a predicate never fires.

---

## 6. Phase 3 — the write path

Today there is exactly one mutating endpoint in the app and it dispatches the X scan. This
is the largest architectural change in the design.

- **Auth**: single user, Supabase (already a dependency). One session; no roles, no
  sharing, no public tier. Service-role keys never go behind `NEXT_PUBLIC_`.
- **This does NOT breach the no-runtime-coupling rule, and that was checked.** The
  pipeline already carries a Supabase client (`run_pipeline.py:1234-1235`, `supabase>=2.0`
  in `pipeline/requirements.txt`) and already writes artifacts through it. The forbidden
  thing is the pipeline depending on the *Node application*; a shared database both sides
  reach over HTTP is not that, and the mechanism exists today.
- **But the mirror must first carry what Phase 3 leans on.** It currently uploads 6 of
  ~20 artifacts and **every `fpl/*` file — the ones both automated teams depend on — is
  never uploaded**. Worse, a 404 falls through to local while recording
  `provenance.source: 'local'`, so the signal designed to reveal a failing remote is the
  permanent expected state. Fix mirror coverage before any surface treats Supabase as the
  fresher source.
- **Squad state becomes owned by the hub.** `FPL_ENTRIES` currently ships `squad: []`,
  `bank: None`, `purchase_prices: None` for both automated teams. The hub becomes the
  source of truth. Note the constraint that makes this non-trivial: selling price is
  purchase plus half the rise, so `purchase_prices` cannot be recovered from `now_cost`
  alone. `entry_api.replay_purchase_prices` already walks transfers back to the opening
  squad and *flags* an untraceable player rather than guessing — keep that refusal, and
  surface the flag for manual correction rather than hiding it.
- **Approve / override / veto before a seal.** Execution stays `propose_only`. The human
  lever moves from a shell command to the product. Invalidate with `updateTag` on the
  affected artifact tag so the approving request sees fresh data rather than a stale read.
- **The seal is untouchable.** `TooLateToSealError` past the deadline,
  `AlreadySealedError` over an existing file, no repair path, 38 chances a season. The
  ordering *seal first, decide second, deliver last* stands: a decision can be recomputed
  tomorrow; proof a forecast predated kickoff cannot. **An approval UI must never be able
  to block or delay a seal** — it approves the decision that follows the seal, never the
  seal itself. If the human does not respond, the agent's own plan stands and says so.
- **Fix the agent's channel.** `messages.py` states "there is no email; the site is the
  only channel" and the run exits non-zero if publication fails — yet `messages.json` has
  never reached the site, and `/inbox` turns the normal empty state into "feed unavailable
  (404)". Until this works, a human who disagrees has no in-product action *and* no way to
  learn there is something to disagree with.

---

## 7. What must not break

Load-bearing behaviour that looks like a defect. A redesign that "fills in the blanks"
here makes the system worse while making it look better.

- **Honest refusals.** Sensitivity publishing `measurable: false` with a reason rather
  than inventing a sigma. `run_decide` raising rather than defaulting a weekly
  `tail_threshold` to 0.0. `resolve_element` refusing surname ambiguity rather than
  picking — 441 of 663 surname keys are ambiguous. `entry_api` flagging an untraceable
  purchase price. `news_view.basis` stating in the artifact that nothing there has moved a
  projection. `MISSED_SEAL` checked last for a measured livelock reason.
- **Learning may never touch staking.** Enforced twice — `gate_not_risk`
  (`gates.py:146-158`) and a disjointness assertion (`config.py:495-496`). Preserve both.
  If the learning loop is wired at one end only, the failure shape is the worst available:
  a gated, committed promotion that changes the sealed record and the audit trail while
  changing no projection. Both ends land together or neither does.
- **The odds quota.** 500 requests/month, consumed by the daily run, and *observed but
  never enforced* — `x-requests-remaining` is parsed and read only by the module's own
  `__main__`. Never shorten the 30-minute cache, add a region, or enable
  `ODDS_FETCH_ADDITIONAL` without a budget calculation.
- **`schedule.py` stays standard-library only.** The phase gate runs 8×/day all year with
  no `pip install`. This is *why* `BOOTSTRAP_URL` is duplicated there. Any URL
  consolidation must not break it — and note it is the dominant FPL caller, pulling
  ~1.5MB eight times daily while bypassing the cache, TTL and retry, so any sizing of FPL
  request volume that misses it is wrong.
- **Path ownership between the three git-write lanes**, enforced by POSIX-ERE
  `FORBID_PATHS` because `grep -E` has no negative lookahead. Two lanes must never own one
  path.
- **iCloud conflict copies.** Never treat a `foo 2.ts` as source; no `.gitignore` rule,
  because `* [0-9].*` would also hide a legitimate `step 2.tsx`. Keep the detector and
  `clean_sync_duplicates.sh --apply`, which reports differing copies rather than deleting
  them.
- **No runtime Python/Node coupling**, with one deliberate exception that fails closed
  (`/api/x-scan` returns 501 when unconfigured). Any new coupling fails closed the same
  way.

---

## 8. Testing

The Python↔TypeScript JSON contract is the system's central unenforced seam — drift is
silent until a page renders blank. Phase 0 widens it, so it gets enforced first.

- **Contract fixtures.** Every artifact the six surfaces read gets a committed fixture and
  a test asserting the TypeScript narrower accepts it. A schema change that breaks a
  surface must fail in CI, not in a browser.
- **A test per Phase 0 defect**, written before the fix: `rate_source` non-null; a stored
  claim carrying a real `AVAILABILITY_TYPES` type; `is_upcoming` false on null
  `kickoff_time`; settled-outcome discovery finding a written file.
- **A predicate-liveness test.** Every `isEmpty` predicate must fire on at least one
  committed fixture and not fire on another. This is what would have caught the stale
  predicates in §5.
- **Nav coverage that actually covers.** The current test enumerates only top-level
  `app/*` directories, so it guards neither dynamic segments nor the mobile nav — which is
  why an unrendered component could strand a 612-line page undetected.
- **Local development is currently broken and must be fixed first.** The venv cannot
  import `soccerdata`, `fbrefdata`, `pyarrow`, `sklearn`, `xgboost`, `pymc` or `shap`, so
  the model layer, the scraped-source path and SHAP are unverifiable outside CI. `CLAUDE.md`
  presents this venv as the working interpreter and blames Homebrew Python instead.

---

## 9. Risks

- **Wazza still will not differ until ~GW7.** Phase 1 makes the mechanism real; arithmetic
  makes the outcome slow. If the owner expects two visibly different teams sooner, the only
  honest lever is dropping the calibration gate, which §2.1 rejects.
- **The draws matrix may be large.** Size it before designing the what-if surface; if
  per-gameweek storage is impractical, Phase 3's approval surface loses its
  counterfactuals and must say so rather than approximating them from marginals.
- **LiveFPL is a single fragile dependency** for the one input Wazza cannot get elsewhere.
  It must degrade, and its absence must be visible.
- **Deployed behaviour is unconfirmed.** There is no `.env` under `frontend/`, so Next.js
  never sees the root `.env`: locally the Supabase base resolves to null and everything
  reads local JSON. The FPLReview snapshot is gitignored three ways, so deployed ranked
  lists are likely heuristic-only while the page still claims otherwise. **Confirm
  production before drawing any conclusion about what a visitor sees.**
- **Never sealed.** 48 "Agent status" commits and zero "FPL agent —" commits, no ledger,
  no decisions. But two artifacts carry timestamps requiring at least one real agent run.
  The Actions history for `fpl_agent.yml` settles whether Phase 0 fixes a live system or
  commissions a cold one.

---

## 10. Sequencing

Phase 0 → 1 → 2 → 3, strictly. Phase 0 has no visible output and is the phase most likely
to be skipped under impatience; skipping it means the new hub's every panel displays a
number the audit already proved wrong. Phase 1 must precede Phase 2 because a team
switcher is only worth building if the teams differ. Phase 3 depends on the draws matrix
from Phase 1.
