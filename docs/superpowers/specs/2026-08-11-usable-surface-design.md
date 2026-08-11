# A surface you can actually use

*Design, 2026-08-11. Written after the owner's verdict on the deployed app: "it's a
horrible website."*

---

## The diagnosis, measured

The app was inspected page by page in a browser rather than reasoned about. What it
showed:

**`/decide` — the page that should answer "what do I do" — opens with four
consecutive `NOT PUBLISHED` panels**, roughly 1,200px of empty bordered boxes, one
of which (`Robustness`) is rendered **twice**. Below all of that sits genuinely
competitive content: a ranked 7-move transfer shortlist with per-move reasoning, 12
alternative multi-transfer plans scored to one decimal, and a 6-gameweek captaincy
plan with vice and confidence.

**`/now` shows three empty panels of five sections.** The one populated section is a
fixture/call/confidence table whose confidences run 39–56% — barely above chance for
a three-way market, and presented without that context.

**`/players` sorts by minutes descending**, so the first twelve rows of the FPL
players page are goalkeepers with `0` goals and `0.00` xG. It shows last season's
actuals. It carries no price, no ownership and no projected points — the three
numbers every FPL decision is actually made with.

**13 of 22 routes are unreachable.** `/transfers`, `/optimizer`, `/captaincy`,
`/rankings`, `/planner`, `/projections`, `/intelligence`, `/table`, `/h2h`,
`/matches`, `/value-bets`, `/accuracy` and `/decisions` are all built and deployed.
The sidebar lists nine.

### The root cause is not missing content

It is **ordering and weight**. This app was built so that absence is a first-class
state, which was the right call — it replaced pages that rendered zeros as though
they were answers. But the implementation gives an absent artifact a large bordered
panel and puts it *above* the content that exists. Every improvement to how
articulately the app explains absence has made the surface worse.

The agent that writes most artifacts is deadline-gated and idle for ~10 days of
every gameweek cycle, so "mostly empty" is the normal state, not an edge case.

## What the named competitors do

| Product | Its shape |
|---|---|
| [Solio](https://fpl.solioanalytics.com/) | Branching decision tree across gameweeks, **risk appetite as a control**, customisable projections |
| [FPL Review](https://fplreview.com/access-the-massive-data-planner/) | Hourly projections, **14-gameweek horizon**, editable penalties, kits/faces, Elite-1000 benchmark |
| [FantasyFootballFix](https://www.fantasyfootballfix.com/web_features/) | **Price-change predictor with bandwagon alerts**, push notifications, instant squad optimisation |

The pattern all three share: **they open with your squad and an answer.** This app
opens with disclaimers.

## What the data actually supports

Verified against the live deployment and the committed artifacts, not assumed.

**Available now**

- **The 15-man squad** — `/api/fpl/state` returns `squad.players` with name,
  position, team and price, plus `formation`, `value` and `bank`. Source is
  `captured` (a draft read from the authenticated FPL UI), which the artifact
  already labels.
- **577 players** with price on 577 and ownership on 498, plus position, team,
  form and availability.
- **Rankings** — overall, captaincy, value, differentials and per-position, ten
  players each with price and ownership.
- **The heuristic engine's output** — the shortlist, the 12 alternatives and the
  captaincy plan, already wired through `useHeuristics`.
- **80 fixtures with our own fitted goal rates** — `lambda_home` / `mu_away` from
  the Dixon-Coles posterior blended with the market anchor.

**Not available**

- **Per-player model projections.** `xp_gw` is written by the agent;
  `projections.coveragePercent` is `0` and `source` is `fallback`. Until a deadline
  approaches, per-player numbers can only come from the heuristic.
- Player photos and kits (no licensed source).
- Price-change predictions (needs transfer-flow data we do not collect).

**The waste worth naming:** we compute per-fixture goal rates for 80 fixtures and
display them **nowhere**. Every competitor's fixture ticker is coloured by FPL's
official 1–5 FDR. Ours can be coloured by our own fitted rates. That is a real edge,
already built and currently invisible.

---

## The design

### One principle

> **Absence never occupies more space than substance.**

An empty section is **one line of prose**, placed **after** the content that exists,
never a bordered panel above it. This does not weaken the honesty rule — the state
is still declared, still typed, still refuses to be charted. It stops being the
loudest thing on the page.

### Screen 1 — `/` — "What do I do"

```
┌────────────────────────────────────────────────────────────────────┐
│ GW1 · deadline Fri 21 Aug 23:00 · 3d 4h    1 FT · £0.0 ITB · £100.1│
├────────────────────────────────────────────────────────────────────┤
│ ▶ THE MOVE    Truffert → Collins    +1.3 pts / 4GW    conf 67ᴴ    │
│   Captain     Rice  (COV home)      8.4ᴴ proj         conf 64      │
│   why: 1 favourable fixture in the run · 2.0% elite ownership      │
│                                          [why not?] [alternatives] │
├────────────────────────────────────────────────────────────────────┤
│                         GKP                                        │
│                    Alisson 5.5 LIV                                 │
│                    ▓▓░▓▓   (next 5)                                │
│         DEF                                                        │
│   O'Reilly 6.5   Tarkowski 6.0   Guéhi 6.0   Lacroix 6.0           │
│   ▓░▓▓▓            ░▓▓░▓         ▓▓░░▓        ▓░░▓▓                │
│         MID  ...                                                   │
│         FWD  ...                                                   │
│                                                                    │
│   ▓ our goal-rate model, not FPL's FDR        [explain the colours] │
├────────────────────────────────────────────────────────────────────┤
│ Since you last looked: nothing changed. Poller ran 4 minutes ago.  │
└────────────────────────────────────────────────────────────────────┘
```

Formation comes from `squad.formation`; the pitch is not hardcoded to 3-4-3.

### Screen 2 — `/decide`

Reorder only — the content is already there and already correct. Shortlist,
alternatives, captaincy plan. Then **one line** at the bottom naming what is idle and
until when. Delete the duplicated `Robustness` section.

### Screen 3 — `/players`

Default sort **projection descending**, not minutes. Columns: player · team · pos ·
**price** · **own%** · proj next-N · fixture run. Filters for position, price band,
team and availability, plus a search box. The goalkeeper wall disappears as a
side-effect of the default sort no longer being "who played most last season".

### Navigation

Restore all 22 routes, grouped:

- **Decide** — now, decide, transfers, captaincy, planner
- **Research** — players, projections, rankings, evidence, intelligence
- **Match model** — matches, table, h2h
- **Betting** — value-bets, bankroll
- **Ops** — health, accuracy, inbox, decisions

Drop **Other sports** (F1 · Darts · Cricket). CLAUDE.md rule 7 puts those providers
out of scope for this repo.

### Source badges

Every projection carries its provenance **inline as a superscript glyph** — `ᴹ`
model, `ᴴ` heuristic — with one legend line per page. This replaces the current
paragraph-long amber disclaimer, which is accurate and unreadable. The badge must be
adjacent to the number, because that is where the reader's eye is when they decide
whether to trust it.

The `HEURISTIC — NOT A MODEL` block stays on `/decide` in reduced form: one sentence,
not a panel.

---

## Build order

Small and high-impact first, so the surface improves before anything is rebuilt.

1. **Empty-state weight** — a one-line variant of `WhenProven`'s fallback; reorder
   sections so populated content precedes absent; delete the duplicate section.
2. **Navigation** — restore the 13 orphans, grouped; drop other sports.
3. **`/players`** — default sort, price and ownership columns, filters, search.
4. **Squad pitch + THE MOVE** on the landing screen, with fixture runs coloured by
   our own goal rates.
5. **Source badges** applied everywhere a projection is rendered.

## Testing

Each step keeps the existing net green: 1651 Python, 759 frontend, 0 lint errors.
New assertions:

- **The ordering rule as a test.** For every page, no absent section may render
  before a populated one. This is the invariant the whole redesign turns on, so it
  is asserted rather than reviewed.
- **A one-line empty state renders one line**, not a panel — asserted on height or
  element count, not a class name.
- **Every route in the nav resolves**, and every route that exists is either in the
  nav or explicitly listed as intentionally unlinked. The current state — 13
  unreachable routes — must be impossible to reach again silently.
- **`/players` default sort is projection**, and a goalkeeper with zero minutes is
  not in the first ten rows.
- **The fixture colour derives from `fixture_xg`**, not from a hardcoded FDR table.
  Mutation: swap in FPL's FDR and the test fails.
- Six states per changed screen, as the existing suite already requires.

## What this does not claim

- **It does not add model projections.** The pitch's per-player numbers are
  heuristic until the agent runs, and they say so. The redesign makes the honesty
  legible; it does not manufacture confidence.
- **It does not match FPL Review's horizon.** Fourteen gameweeks of projections
  needs `xp_gw` published across that horizon; we have four to six from the
  heuristic.
- **It does not add kits, faces or price predictions.** Two lack a licensed source,
  one lacks the data.
- **It does not touch the staking or model paths.** This is a surface change.
