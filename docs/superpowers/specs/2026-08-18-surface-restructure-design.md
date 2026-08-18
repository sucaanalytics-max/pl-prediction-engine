# The surface, cut to what decides a gameweek

*Design, 2026-08-18. Produced by a four-angle sweep of the SHIPPED frontend (contradicting numbers, unearned claims, information architecture, absence and trust), then synthesised. The owner's brief was two sentences that only reconcile by subtraction: "restructure the whole system" and "too complicated and over built".*

*Scope note: the four must-fix items below were implemented on `main` before this document was written — commits `c3afda3` (one captain, one total, one join, Ronny's banner) and `70092a9` (a quiet agent is not a broken one). What remains here is the structural cut, deliberately held off `main` until after the GW1 deadline (2026-08-21T17:30Z).*

---

## The measure of the cut

Routes 26 → 4 (/, /players, /evidence, /offline); 22 are 410'd, 0 created. Nav destinations 15 (10 sidebar + 5 mobile) → 3, and the second nav is deleted rather than resynced. Nav groups 4 → 0. Provenance/state/absence conventions 16 → 4 (one lowercase word after a number for provenance; one line for absence; the Nil glyph; the Age mark) — deleted: the MODEL and HEURISTIC pills and their two explainer sentences, ProvenanceStrip, the INK not-published banner, the horizon-refusal section, ModeChip, "Next gate in", the sidebar deadline-mini, the sidebar freshness dot, valueBadge, the dead nav badge, the planner's 0.45 "not in the eleven" ink on unsolved weeks, and the second fixture-difficulty grid. Captain render sites 6 → 1. "Projected total" definitions 3 → 1. Squad→projection joins 2 → 1 (elementId). Best-XI solvers 2 → 1 (exhaustive). Gameweek resolvers 4 → 1. Horizon constants 2 → 1. Lines: roughly 4,450 route + 2,270 component + 600 lib deleted; about 30 lines of rewiring and a dozen words of new copy added.

## Headline

Delete the heuristic "the-move" card from /now (components/SquadBoard.tsx:159-198). That single ~40-line cut removes the second captain (MBEUMO, from fpl-ranking-engine.ts:410-416, read at SquadBoard.tsx:155,190), the silently-doubled "8.8 proj" (fpl-ranking-engine.ts:429 `projectedPoints * 2`, rendered beside the model's undoubled 4.6 at SquadBoard.tsx:269-271), the fabricated "0.1% elite ownership" sentence (fpl-ranking-engine.ts:527-529 falls back to FPL's public selected_by_percent because the only eliteOwnership producer is a gitignored FPLReview CSV absent from the deployed Worker), the pseudo-statistic "confidence 73" (fpl-ranking-engine.ts:509-518, a monotone restatement of the delta printed inches away), and the "+3.8 pts over 4 GW" that /margin disowns two clicks later with "THE ENGINE HAS NOT SOLVED A HORIZON" (ScoreView.tsx:359). GameweekCall.tsx:45-49 and :242-246 already state, in the repo's own words, that this app must not suggest transfers because the model publishes one gameweek; deleting the card is that sentence carried out. After it, /now names one captain and every number on the page comes from xp_public_gw01.json.

## Target structure

### / — the call (app/page.tsx, no longer a redirect)

**The one question:** What is my XI, and who is captain, before 23:00 IST Friday.

**Absorbs:** /now, /margin?view=plan, /decide, /decisions, /optimizer, /captaincy, /planner, /transfers, /intelligence — nine paths into one.

**Carries:** GameweekCall rewired to lib/margin/squad.ts:58 `joinProjections` + lib/margin/planner.ts:125 `optimiseXi` — one join (elementId), one solver (exhaustive). One captain: the model argmax over xp_public_gw01.json. One total, labelled `48.20 xP · captain not doubled`. Below it: Planner/PlanGrid retitled `Planner · GW{gameweek}` (Planner.tsx:236) with the 0.45 dimming deleted from unsolved weeks (Planner.tsx:616), and the fixture run beside it. The squad grid from SquadBoard with the heuristic card cut, carrying `captured draft · 18 Aug · not live`. One footnote, already written at GameweekCall.tsx:242-246, saying why no transfer is offered.

### /players — the shortlist (app/players/page.tsx reduced to a four-line route)

**The one question:** Who could I bring in, and how wide is the spread on him.

**Absorbs:** /margin?view=players, /projections, /rankings, and app/players/page.tsx's own 733 lines.

**Carries:** components/margin/ResearchView.tsx verbatim — the only surface reading xp_public end to end with quantiles. Keeps `projectionSourceLabel` (app/players/page.tsx:604-606), the sole honest provenance render in the app, on whatever heuristic columns survive. Deletes the page's own "Projections" (:329-331), "Ranked players" (:489-491, a duplicate of the transfer shortlist) and "Season statistics" (:711, built on player_stats.json's per-90 trap).

### /evidence — do I believe it (app/evidence/page.tsx)

**The one question:** What has moved since I last looked, and how much of this is guessed.

**Absorbs:** /margin?view=news, /margin?view=now, /inbox, /accuracy, /health.

**Carries:** Its existing evidence_view.json claims (:376-390), plus components/margin/NewsView.tsx (the squad join the pipeline could not do) and components/margin/WatchView.tsx (decay ledger, the perfect-model ceiling from accuracy.json, fixture_xg at :351). Deletes its own CapturedHeadlines (:241-248), which reads the identical NEWS_FEED artifact NewsView reads better. The one line worth keeping from /accuracy — the ceiling and the sealed-gameweek count — is already inside WatchView.

### /offline — not a nav item

**The one question:** Nothing; it is the service-worker fallback.

**Absorbs:** Nothing.

**Carries:** Unchanged (21 lines). Listed only so the public/sw.js SHELL_ROUTES edit is complete and cache.addAll cannot reject.

## Contradictions, and which side survives

- **Two captains on /now: B.Fernandes (model, components/GameweekCall.tsx:143) versus MBEUMO (heuristic, components/SquadBoard.tsx:155,190).**
  - *Survivor:* B.Fernandes — the model argmax over xp_public_gw01.json.
  - *Why:* The model's number is a simulated per-fixture xP from a published artifact carrying quantiles and a producer version. The heuristic's is `projectedPoints * ceilingMultiplier` where projectedPoints descends from a single scalar blended off FPL's own ep_next and a minutes model the repo itself calls dimensionally meaningless (lib/data/heuristics.ts:9-15). The MODEL/HEURISTIC badges name the provenance but do not adjudicate, and the heuristic renders second, so it is the last captain he reads. Delete the loser rather than badge it harder.
- **48.20 xP on /now versus 54.9 projected GW1 on /margin, same squad, same artifact.**
  - *Survivor:* The undoubled XI sum, produced by lib/margin/planner.ts's exhaustive optimiseXi, rendered on both surfaces with the words `captain not doubled`.
  - *Why:* 48.20 + 6.6562 (B.Fernandes) = 54.86 → 54.9, so the XIs are identical and only the counting rule differs; both were correct under an unstated definition, which is the defect. The undoubled sum survives because /margin's own label says "projected GW1" and says nothing about an armband. The doubling stays inside optimiseXi (planner.ts:169-172) where it is a comparison key that selects a formation and is never rendered. GameweekCall's greedy solver loses to the exhaustive one because the doubling rule changes which formation wins — the two XIs can genuinely differ, not merely be labelled differently.
- **Mbeumo at 4.6 xP in the squad grid and 8.8 proj in the heuristic line, on one card stack.**
  - *Survivor:* 4.6 — `projection.xp.toFixed(1)` from the artifact.
  - *Why:* Two axes diverge at once: different engine and different doubling convention (fpl-ranking-engine.ts:429 doubles a heuristic 4.4). Compared against 6.66 the 8.8 wins the armband; compared against 13.31 it loses. The screen gives no way to know which comparison is valid. Deleting the heuristic card removes the 8.8 at all three of its render sites (SquadBoard.tsx:192, ScoreView.tsx:230, decide/page.tsx:410).
- **/now claims "+3.8 pts over 4 GW"; /margin says "THE ENGINE HAS NOT SOLVED A HORIZON".**
  - *Survivor:* The refusal — and then the refusal's copy is deleted too, because with the claim gone there is nothing left to refuse.
  - *Why:* /margin is factually right: xp_public_gw01.json's top-level keys are schema_version, gameweek, season, generated_at, n_draws, producer_version, players, fixtures — no horizon key at all, so Horizon is null everywhere. The 4-GW delta is one scalar times four fixture-difficulty constants (fpl-ranking-engine.ts:77-89), or else it is a paid competitor's CSV rendered with the attribution stripped — and that CSV is gitignored and absent from the deployed Cloudflare Worker, so in the shipped app it is the extrapolation. GameweekCall.tsx:45-49 already states the policy. Once the claim is deleted, ScoreView.tsx:350-380 is 75 words arguing with a design document the reader has never seen; both sides of the contradiction go.
- **Three quantities labelled "Projected" across five render sites: bare XI sum, XI sum + captain, and decision.mean_points.**
  - *Survivor:* `mean_points` keeps the word "projected" in the vocabulary — but only where a decision for the owner's own entry exists, which today is nowhere.
  - *Why:* mean_points is the only one of the three that is a simulated total of what FPL will actually score, including autosub probability. But every current render of it reads a bot's mandate: ScoreView.tsx:245 hardcodes "season" (Ronny), and /decide renders both ENTRY_LABELS so it shows two disagreeing "Projected" figures by design. So in this phase the word survives and its screen presence does not: the planner's figure is labelled `xP · captain not doubled`, GameweekCall shows the same number from the same solver, and the /inbox and /decide sites go with their routes.
- **Sidebar "GW1 planning" with its own IST deadline (FPL bootstrap via /api/fpl/state) versus Margin's countdown (agent_status.json).**
  - *Survivor:* agent_status.deadline, rendered once, labelled `GW{n} deadline`.
  - *Why:* They agree today at 2026-08-21T17:30Z but have independent staleness budgets (useHeuristics.ts:38 allows 30 minutes), and the sidebar derives its gameweek from live.event.id while the mode chip derives from agent_status.phase — so on Friday the sidebar can say "GW1 planning" beside a chip saying the week is settled. agent_status wins because app/margin/page.tsx:39-46 already ranks it primary and it is the file the phase resolver owns. One clock; the copy in the chrome is deleted.
- **Sidebar "Live FPL · draft captured" sitting directly above "Updated 18m ago".**
  - *Survivor:* Neither line. The capture date itself survives, moved onto the squad.
  - *Why:* "18m ago" is latest.json's producedAt — the daily betting pipeline — placed under a sentence about the squad, so a five-day-old hand capture reads as eighteen minutes fresh. The server already builds the true sentence (lib/fpl-live-server.ts:485-489) and the narrower drops it. Delete the misleading pair, narrow `capturedAt` through HeuristicView, and render `captured draft · 18 Aug` on components/SquadBoard.tsx:219-221 where the claim already lives. One element deleted, three words added, and the claim finally carries the fact that makes it checkable.
- **Four gameweek resolvers (event.id, agent_status.gameweek, matches.gameweek, and a `?? 1` fallback) feeding a function that builds a fetch path.**
  - *Survivor:* `agent_status.gameweek ?? heuristics.event.id`, exported once as currentGameweek().
  - *Why:* agent_status is written by the phase resolver that owns the deadline and app/margin/page.tsx:39-46 already names it primary. matches.gameweek is deleted outright — deriving an FPL gameweek from a match-odds artifact is a coincidence, not a source. The `?? 1` goes at all four sites: a hardcoded 1 is wrong for 37 weeks of 38, and because lib/data/projections.ts:289-292 turns the number into `fpl/xp_public_gw{NN}.json`, a wrong resolver does not mislabel a number — it fetches a different file.

## Deletions

- components/SquadBoard.tsx:159-198 — the HEURISTIC `the-move` card. One cut removes the second captain, the doubled "8.8 proj", "+3.8 pts over 4 GW", "confidence 73" and "0.1% elite ownership".
- components/GameweekCall.tsx:53-117 — private fold/rate/bestEleven/total. Replaced by lib/margin/squad.ts:58 and lib/margin/planner.ts:125,192-198.
- components/SquadBoard.tsx:77-98 and :100-123 — the second copy of the name-join workaround and the docstring claiming elementId is unavailable (it is narrowed at lib/data/heuristics.ts:326).
- components/margin/Planner.tsx:456 — the `+ captain` in projectedTotal, so "projected GW1" means what its label says. Planner.tsx:616 — the 0.45 opacity that paints five unsolved weeks in the ink reserved for "does not make the eleven". Planner.tsx:236 retitled `Planner · GW{gameweek}`.
- components/margin/DecideCard.tsx:69-105 — the black "THE CALL · NOT PUBLISHED" banner. components/margin/ScoreView.tsx:245,:293 — the read of Ronny's decision_public_gw01_season.json from the owner's screen.
- components/margin/ScoreView.tsx:350-380 — "THE ENGINE HAS NOT SOLVED A HORIZON", its 75-word essay and the third state line about the same absent file. ScoreView.tsx:197-241 and :401-406 — the six-week heuristic Captaincy panel sitting directly under that refusal. ScoreView.tsx:48-49, :92-195, :388-399 — the second fixture-difficulty grid at a second horizon.
- components/margin/Shell.tsx (255 lines) — the whole tab shell: PLAN/PLAYERS/NEWS/NOW, ModeChip "IDLE · ENGINE GATED", the clock, the 1-4 key bindings, the ?view= alias table. lib/margin/mode.ts:38-45 — clockLabel's mode branching, which renames the owner's own deadline "Next gate in".
- components/margin/DecideView.tsx (885), components/margin/SquadInterval.tsx (147), components/FixtureTable.tsx (278), components/BetTable.tsx (110) — zero route importers; DecideView's only importer in the tree is app/margin/page.test.tsx:22. Strike the docstrings claiming otherwise at app/margin/page.tsx:30-32 and components/margin/DecideCard.tsx:15-17.
- components/MobileBottomNav.tsx (38), its mount at app/layout.tsx:5 and :117, and app/globals.css:767, :798-810 — a five-item bar of which four items are redirect stubs and two land on the same page, guarded by no test.
- components/Navigation.tsx:43-44 (badge/valueBadge), :47-50 (NavGroup), :76-121 (the four groups), :155 (REGISTRY.latest fetch), :170-173 (valueBetCount — computed on every page load of every route, rendered nowhere), :229, :240, :255-259 (the second deadline clock), :259-278 (the status block reporting latest.json's age under the words "draft captured").
- Routes 410'd (22): app/now (206), app/margin (127), app/decide (609), app/decisions (205), app/inbox (283), app/accuracy (273), app/health (384), app/bet (102), app/markets (354), app/bankroll (576), app/matches (215), app/matches/[id] (612), app/h2h (330), plus the ten stubs app/captaincy, app/optimizer, app/planner, app/transfers, app/rankings, app/projections, app/intelligence, app/table, app/value-bets and app/page.tsx's redirect — roughly 4,450 lines.
- components/PnLChart.tsx (109), components/ScorelineHeatmap.tsx (100), components/SHAPWaterfall.tsx (75), components/DistributionChart.tsx (83), components/HistoricalMatchDetails.tsx (181) — betting-only, orphaned with their routes. Odds ingestion is untouched: it is pipeline-side and reaches the FPL app through fixture_xg.json (components/margin/WatchView.tsx:351).
- lib/fpl-ranking-engine.ts:185-189, :378-380, :389-394, :406-407, :429, :450-452, :506-552 — projected4/delta4, all three confidence formulas, buildCaptaincyPlan, differentialScore, the "% elite ownership" string and the Differential flag. lib/data/heuristics.ts:47 (`differentials` category), :100, :111, :122 (confidence), :260-263, :443-518, :549-562 (transfers/plans/captaincy narrowing).
- lib/data/narrow.ts:111, :148 — `n_value_bets`, narrowed, never rendered, and null on every row of the shipped latest.json. REGISTRY entries `table`, `h2h`, `latest`, `blendWeight` — blendWeight already has no consumer, the rest lose theirs with the betting screens.
- components/data/Artifact.tsx:151-178 ProvenanceStrip and its four call sites at app/now/page.tsx:33,52,90,129 — on an absent artifact it can only ever print "update time unknown · version unknown". Make Section render nothing but children when the artifact carries no value, so an absence is one line with no heading.
- Every per-site `what=` string that restates a registry descriptor — app/now/page.tsx:37,56,94,132 and components/margin/WatchView.tsx:231,234-241 (a 55-word paragraph explaining the same silence /now explains in 25). Move the sentence onto the descriptor in lib/data/narrow.ts:1565-1578 and have StateCard and MarginState read it.
- app/decide/page.tsx:563 and app/players/page.tsx:694 — the matches.gameweek resolver chain; the `?? 1` last resort at components/GameweekCall.tsx:123, components/SquadBoard.tsx:137, app/margin/page.tsx:115, components/MinutesConflicts.tsx:64; the literal `title="Your GW1 call"` at app/now/page.tsx:186.
- public/sw.js:8-27 — drop /margin, /bet, /now, /decide and /accuracy from SHELL_ROUTES and bump CACHE_NAME to "suca-fpl-shell-v7" IN THE SAME COMMIT, or cache.addAll rejects atomically and every installed PWA precaches nothing.
- test/nav-coverage.test.tsx:32-70 and :144-201 — NOT_IN_NAV, BEHIND_BETTING_INDEX, isRedirect() and the three betting-boundary tests. With three routes and zero stubs the file shrinks to one assertion: the nav links exactly /, /players and /evidence.
- lib/fpl-live-server.ts:120 — the "13 August 2026" in the comment, which already disagrees with CAPTURED_DRAFT_AT at :140.

## What must survive the cut

- lib/margin/planner.ts — optimiseXi (:114-125) and pointsFrom (:192-198): exhaustive over formations, captain-aware, joined on FPL's own elementId, blank-aware, and tested. This is the solver everything else should call. Its internal captain doubling at :169-172 is correct because it is a comparison key, never a rendered figure.
- components/margin/ResearchView.tsx — the only surface that reads xp_public end to end with quantiles, and the reason /players survives as a route at all.
- components/margin/NewsView.tsx — it performs the squad join the pipeline could not, and its copy is the model for how a claim should carry its source.
- components/margin/WatchView.tsx — the decay ledger, the perfect-model calibration ceiling from accuracy.json, and fixture_xg. It is the only honest "do I believe this" surface, and it makes /accuracy and /health redundant rather than the reverse.
- The absence vocabulary in lib/data/artifact.ts:242-249 and StateCard's weight="line" demotion. The mechanism is right; only its placement and its per-site copy are wrong. Keep the machinery, move the sentence onto the registry descriptor.
- lib/data/sensitivity.ts:4-12 and :123-135 — publishing `measurable: false` with a mandatory stated reason rather than substituting an invented number. This is the standard the rest of the app should be judged against, and it is exactly what `confidence` violates.
- components/GameweekCall.tsx:41-49 and :242-246 — the written policy that this app must not suggest transfers because the model publishes one gameweek. Do not delete it; it is the justification for the largest cut in this proposal.
- app/players/page.tsx:604-606 — the sole render of projectionSourceLabel ("No FPLReview export available — official FPL fields only"). It is the one place a heuristic number carries the caption that makes it safe to read; keep it wherever heuristic columns survive.
- The idea behind test/nav-coverage.test.tsx: a test asserting the nav reaches every route. Keep one assertion of it. The failure was scope — it reads Navigation.tsx only — not concept.
- docs/superpowers/specs/2026-08-11-usable-surface-design.md:36-40 and :94 — "absence never occupies more space than substance". It is correct, and it is the rule this proposal enforces; it just needs an enforcer that covers the Margin surface and not only /decide.

## Must-fix items (already shipped to `main`)

### One captain on the front page. Delete the heuristic transfer/captain card.

**Why it mattered:** He sets an armband on Friday. The shipped page names two different captains as peers, badged but unreconciled, with the heuristic one LAST in reading order — so the final thing he reads before acting is the weaker engine. A wrong recommendation on the front page is worse than none.

**Change:** Delete components/SquadBoard.tsx:159-198 (the whole `data-testid="the-move"` block including its badge and explainer at :162-167). Then delete the now-unread narrowing: lib/data/heuristics.ts:260-263 (transfers, plans, captaincy), :443-518, :549-562. Delete the producers: fpl-ranking-engine.ts:378-380, :389-394 (buildCaptaincyPlan), :406-407 (projected4/delta4), :429, :450-452, :506-552, and the `differentials` entry in RANKING_CATEGORIES (lib/data/heuristics.ts:47). SquadBoard becomes what its title claims: the fifteen. Update components/SquadBoard.test.tsx to drop the-move assertions.

**Evidence:**

- `components/SquadBoard.tsx:155 — `const captain = view?.captaincy?.[0] ?? null;``
- `components/SquadBoard.tsx:190-193 — `{captain.captain.name}` … `{captain.projectedCaptainPoints.toFixed(1)} proj``
- `components/GameweekCall.tsx:143 — `captain: [...best].sort((a,b) => (b.xp ?? 0) - (a.xp ?? 0))[0]` — the model argmax, the survivor`
- `lib/fpl-ranking-engine.ts:429 — `projectedCaptainPoints: rounded(captain.projectedPoints * 2)` — doubled, never labelled doubled`
- `lib/fpl-ranking-engine.ts:527-529 — `eliteOwnership ?? ownership`, then the literal string "% elite ownership adds differential upside"`
- `lib/fpl-ranking-engine.ts:509-518 — `Math.round(max(48, min(88, 56 + selectedDelta*2.4 + min(10, expectedMinutes/12))))``
- `lib/data/heuristics.ts:9-15 — the repo's own note that the minutes model is `minutes / totalPoints * 4.5`, "dimensionally meaningless"`
- `app/now/page.tsx:189,196 — GameweekCall then SquadBoard, stacked, both unconditional`

### One XI, one total. 48.20 and 54.9 must become the same number with a stated convention.

**Why it mattered:** He compares screens to sanity-check the engine. Two totals six points apart for one squad reads as a broken model and costs him trust in the one surface that is actually model-backed.

**Change:** Delete components/GameweekCall.tsx:53-117 (private `fold`, `rate`, `bestEleven`, `total`) and call `joinProjections` (lib/margin/squad.ts:58) plus `optimiseXi` / `pointsFrom` (lib/margin/planner.ts:125,192-198) instead — the exhaustive, captain-aware, elementId-keyed, already-tested solver. Delete the `+ captain` term at components/margin/Planner.tsx:456 so `projectedTotal` matches its own label. Keep the doubling inside optimiseXi (planner.ts:169-172) where it is a comparison key and never rendered. Copy: Planner.tsx:281 stays `projected GW{gameweek}`; GameweekCall.tsx:219 becomes `{current} → {best} xP · captain not doubled`, and the captain line at :190-191 keeps its explicit `· doubled {x2}`.

**Evidence:**

- `components/GameweekCall.tsx:115-117 — `total()` is a bare reduce over xp`
- `components/margin/Planner.tsx:451-457 — `const captain = Math.max(0, ...scored); return scored.reduce((a,b)=>a+b,0) + captain;``
- `components/margin/Planner.tsx:278-281 — rendered as "{n} projected GW{gameweek}" with no armband mentioned`
- `public/predictions/fpl/xp_public_gw01.json — element_id 426 B.Fernandes xp 6.6562; 48.20 + 6.6562 = 54.856 → 54.9, closing the gap arithmetically`
- `lib/margin/planner.ts:114-125 — "Exhaustive over formations rather than greedy"`
- `components/GameweekCall.tsx:92-113 — the greedy second solver being deleted`

### Join the squad to projections on elementId, not on folded name + position.

**Why it mattered:** The shipped GW1 artifact already contains two colliding (name, position) pairs — kamara/MID x2 and sangare/MID x2. If either is in his fifteen this week, /now silently drops that player from the XI, or collapses the whole call card to "The projection does not cover enough of the squad to pick an XI", while /margin solves the identical squad one route away. This is a live failure mode this gameweek, not a hypothetical.

**Change:** Deleted with the previous item — components/GameweekCall.tsx:55-81 and components/SquadBoard.tsx:100-123 both go, replaced by `pointsFrom` keyed on `p.elementId` with its `!p.blank` guard (which /now currently lacks entirely, so in a blank gameweek it would start a fixture-less player). Also delete the stale docstring at components/SquadBoard.tsx:77-98 asserting "The squad shape carries no `element_id` to join on" — lib/data/heuristics.ts:326 narrows it.

**Evidence:**

- `components/SquadBoard.tsx:100-111 — `return hits.length === 1 ? hits[0] : null;` — refuses on collision`
- `components/GameweekCall.tsx:72-81 — the same join duplicated in a second component`
- `components/GameweekCall.tsx:93 — `rated.filter((p) => p.xp !== null)` silently drops him`
- `components/GameweekCall.tsx:101 — `if (keeper.length < 1 || defs.length < 3 || fwds.length < 1) return [];` — the collapse path`
- `lib/margin/planner.ts:192-198 — `pointsFrom`, on `p.elementId`, excluding `p.blank``
- `lib/data/heuristics.ts:326 — `elementId: optNumber(item.elementId) ?? undefined``
- `public/predictions/fpl/xp_public_gw01.json — 2 ambiguous folded (name, position) pairs today`

### Stop the owner's screens reading, or announcing the absence of, a bot's artifact.

**Why it mattered:** The loudest element on /margin — a near-black full-width bar on a paper page, above everything — announces that decision_public_gw01_season.json is not published. That file is Ronny's plan (entry 2561567), not his (20945). He is being alarmed, on his planning screen, about a cron gate for a team he cannot see, three days before his own deadline. And if it ever publishes it renders as "out X · in Y · (C) Z" above his squad — a bot's transfer advice styled as his answer.

**Change:** Delete the `decisionDescriptor(gameweek, "season")` read and the DecideCard mount (components/margin/ScoreView.tsx:245, :293). Delete the entire absent branch of components/margin/DecideCard.tsx:69-105. Delete the horizon-refusal section wholesale: components/margin/ScoreView.tsx:350-380 (eyebrow, 75-word essay, and a third MarginState line about the same absent file). Delete ModeChip (components/margin/Shell.tsx:118-156, :248) and clockLabel's mode branching (lib/margin/mode.ts:38-45) — the clock always reads `GW{n} deadline`, never "NEXT GATE IN", which renames his own deadline in the scheduler's vocabulary.

**Evidence:**

- `pipeline/config.py:455-457 — `# "Ronny" — .../entry/2561567/`, `"team_name": "Ronny"``
- `lib/data/narrow.ts:1408 — `ENTRY_LABELS = ["season", "weekly"]`, "as pipeline/config.py::FPL_ENTRIES names them"`
- `components/margin/DecideCard.tsx:34 — `const S = INK;` against components/margin/ScoreView.tsx:46 `const S = PAPER;` — highest-contrast element on the screen`
- `components/margin/ScoreView.tsx:359-376 — refusal eyebrow, essay, and MarginState, all on one absent artifact`
- `lib/margin/mode.ts:38-45 — `case "idle": return "Next gate in";``
- `components/margin/Shell.tsx:249 — the Clock is fed `status.deadline`, i.e. the gameweek deadline itself`
- `docs/superpowers/specs/2026-08-11-usable-surface-design.md:36-40,94 — absence must never outweigh substance`

### Collapse ten nav destinations and 26 routes to three surfaces on three existing paths.

**Why it mattered:** He has four doors to one question (/now, /margin?view=plan, /decide, /decisions) and they disagree. Two of them read decision files that are not on disk and that this repo says nothing writes. The mobile bar he uses on a phone points at four redirect stubs, two of which land on the same page. Fewer doors is the owner's stated verdict executed literally.

**Change:** `/` stops redirecting (app/page.tsx:21) and renders the call directly: GameweekCall (rewired), Planner + PlanGrid, and the fixture run from ScoreView. `/players` becomes a four-line route rendering components/margin/ResearchView.tsx. `/evidence` keeps its evidence_view claims and absorbs NewsView + WatchView. 410 the other 22 routes. Delete components/margin/Shell.tsx (tab bar, mode pill, clock, 1-4 keys, ?view= alias table) — the four views become three bookmarkable routes. Delete components/MobileBottomNav.tsx, its mount at app/layout.tsx:5,:117, and app/globals.css:767,:798-810. Navigation.tsx loses NavGroup (:47-50), all four NAV_GROUPS (:76-121), badge/valueBadge (:43-44,:229,:240), the REGISTRY.latest fetch (:155) and valueBetCount (:170-173). SAME COMMIT: public/sw.js SHELL_ROUTES becomes ["/","/players","/evidence","/offline",…icons] and CACHE_NAME goes to "suca-fpl-shell-v7" — cache.addAll is atomic, so leaving /margin,/now,/decide,/bet,/accuracy in the list makes every installed PWA fail install and precache nothing.

**Evidence:**

- `find app -name page.tsx → 26 files, 10 of them redirect stubs`
- `components/Navigation.tsx:76-121 — ten items in four groups`
- `components/MobileBottomNav.tsx:7-13 — "/", /optimizer, /projections, /captaincy, /evidence; four are stubs and /optimizer and /captaincy both redirect("/decide")`
- `app/globals.css:799-808 — `repeat(4, 1fr)` against five ITEMS`
- `lib/data/narrow.ts:1415-1418 — decision_latest.json "is written by nothing", yet app/decisions/page.tsx:67 fetches it`
- `ls public/predictions/fpl → accuracy, agent_status, deltas.jsonl, evidence_view, minutes_conflicts_gw01, news_view, xp_public_gw01 — no decision_* file, no messages.json`
- `app/margin/page.tsx:7-8 — "a single workspace rather than as nine routes"; all nine are still in the sidebar`
- `public/sw.js:8-34 — SHELL_ROUTES + `cache.addAll`, and :3-7 on CACHE_NAME being the only evictor`
- `test/nav-coverage.test.tsx:29,144-161 — the redirect-stub guard reads Navigation.tsx only, so it is blind to the mobile bar`

### One gameweek resolver.

**Why it mattered:** The GW1 deadline passes this Friday. On that boundary four independent resolvers can disagree, and the gameweek is not a label — it builds the fetch path, so two screens can quote the same week while reading different files.

**Change:** Export one `currentGameweek()`: `agent_status.gameweek ?? heuristics.event.id`, with no `?? 1`. Replace it at components/GameweekCall.tsx:123, components/SquadBoard.tsx:137, app/margin/page.tsx:112-115, components/MinutesConflicts.tsx:64. Delete the `matches.gameweek` chain at app/decide/page.tsx:563 and app/players/page.tsx:694 outright — those derive an FPL gameweek from a match-odds artifact. Delete the literal `title="Your GW1 call"` at app/now/page.tsx:186; the heading becomes "Your call" and GameweekCall.tsx:181 stays the single place the gameweek is named. Delete `HORIZON = 8` (components/margin/ScoreView.tsx:49) and feed the fixture run the planner's `weeks` so one constant governs both horizons.

**Evidence:**

- `components/GameweekCall.tsx:123 and components/SquadBoard.tsx:137 — `view?.event?.id ?? 1``
- `app/margin/page.tsx:112-115 — `status.gameweek ?? heuristics.event.id ?? 1``
- `app/decide/page.tsx:563 and app/players/page.tsx:694 — `proven(matches)?.gameweek ?? null``
- `components/MinutesConflicts.tsx:64 — a fourth chain`
- `lib/data/projections.ts:289-292 — the gameweek becomes `fpl/xp_public_gw{NN}.json`, a path not a label`
- `app/margin/page.tsx:39-46 — a docstring ranking three sources that only this one page obeys`
- `components/margin/ScoreView.tsx:49 vs components/margin/Planner.tsx:69 — HORIZON 8 against weeks 6 on one screen`

### Put the capture date on the squad line and delete the sidebar clock that reports a betting file's age.

**Why it mattered:** The squad is a hand-captured draft, hardcoded, ageing every day toward Friday. The only freshness number on screen — "Updated 18m ago" — is latest.json's age, the daily odds pipeline, and it reads reassuringly recent directly beneath the words "draft captured". That is precisely the 28-July failure this repo already documented, now worse: the capture date is not even in a tooltip.

**Change:** Add `capturedAt` to HeuristicView (lib/data/heuristics.ts:219-262; the server already emits it at lib/fpl-live-server.ts:519) and render it once, on the line that already makes the claim: components/SquadBoard.tsx:219-221 becomes `captured draft · 18 Aug · not live`. Delete the sidebar status block components/Navigation.tsx:259-278 keeping only ThemeToggle, and the second deadline at :255-259. Delete the date from the comment at lib/fpl-live-server.ts:120 (it says 13 August; the constant at :140 says 18 August) and tighten lib/captured-draft.test.ts:157-165 to fail beyond 3 days.

**Evidence:**

- `components/Navigation.tsx:155,161-164 — `useArtifact<Latest>(REGISTRY.latest)`, `lastUpdated = latest.provenance.producedAt``
- `lib/data/narrow.ts:1501-1505 — latest.json "describes: match probabilities, value bets and explanations"`
- `components/Navigation.tsx:265-275 — "Live FPL · draft captured" directly over "Updated {ago}"`
- `lib/fpl-live-server.ts:479-491 — the capture sentence is built server-side and thrown away by the narrower`
- `lib/fpl-live-server.ts:120 vs :140 — comment says 13 August 2026, `CAPTURED_DRAFT_AT = "2026-08-18T00:00:00.000Z"``
- `lib/fpl-live-server.ts:124-130 — the repo's own account of the stale 28 July capture: "the only tell was a capturedAt date in a tooltip"`

### Delete the dead second implementation of the decision surface.

**Why it mattered:** It changes nothing on screen this week, which is why it ranks last — and precisely why it should go. 1,420 lines of unreachable code, including a third render of mean_points and a duplicate decisionDescriptor read, is why any question of the form "where does this number come from" takes twice as long to answer under deadline pressure.

**Change:** Delete components/margin/DecideView.tsx (885), components/margin/SquadInterval.tsx (147), components/FixtureTable.tsx (278), components/BetTable.tsx (110). DecideView's only importer in the entire tree is app/margin/page.test.tsx:22 — a test pinning a component no route renders; delete that block with it. Strike the two docstrings asserting DecideView is live: app/margin/page.tsx:30-32 and components/margin/DecideCard.tsx:15-17.

**Evidence:**

- `grep for `from ".*DecideView"` across app/, components/, lib/ → one hit: app/margin/page.test.tsx:22`
- `components/margin/SquadInterval.tsx:43 — imported only at components/margin/DecideView.tsx:64`
- `components/FixtureTable.tsx and components/BetTable.tsx — zero importers anywhere in the tree`
- `components/margin/DecideView.tsx:123 — a third `decision.mean_points.toFixed(1)``
- `components/margin/DecideView.tsx:826 — a duplicate `useArtifact(decisionDescriptor(gameweek, "season"))``
- `components/margin/SquadInterval.tsx:20-22 — a "Drop in…" wiring instruction shipped in a dead file`
