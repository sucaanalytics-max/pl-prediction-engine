# Verified team metrics, and a comparator we can actually read

*Design, 2026-09-04. Prompted by a live exercise the day before: a GW3 "zonal
weakness" thread from @Ghono_FF and four market posts from @robtFPL were read by
hand, transcribed off screenshots, and tested against our own GW3 snapshot. The
comparison was worth doing — it found a real disagreement about the weakest
defence in the gameweek and a systematic fault in our minutes model — and it cost
a full session of manual transcription. This document is about not doing that by
hand again, and about giving the team-strength question a source we can defend.*

---

## The brief

Owner, 2026-09-04: schedule and surface @robtFPL's posts for viewing; build our own
attack and defence ranking from *verified* team data — shots, shot-creating
actions, xG, big chances, big chances created, big chances conceded, open-play
shots, set-piece data; a premium FantasyFootballFix account is available, logged in
to the browser.

## Five decisions, taken 2026-09-04

1. **The ranking is a view, not a model input.** It feeds no projection and no
   stake. This removes the reproducibility burden, keeps FBref and Understat in
   their existing "optional, degrades gracefully" tier, and leaves the
   `market_rates.py` value-bet firewall untouched.
2. **Tabs split by warranty, not by question** — the `/stats` pattern. *Measured*
   (what a provider observed), *Forecast* (what we simulate), *Gap* (the
   difference). The owner initially asked for tabs by question — diagnostic,
   attack-this-week, truer-table — and all three are still answerable, as sorts
   and fixture scopes within the warranty tabs. Mixing warranties in one column
   set is the exact failure `frontend/app/stats/page.tsx` says its tabs exist to
   prevent.
3. **@robtFPL is embedded, not ingested.** An X embedded timeline. No media
   capture, no scheduling, no storage.
4. **FantasyFootballFix stays out of the repo.** Read in-session, stored in a
   gitignored local file, rendered in local dev only; only our own derived delta
   is committed.
5. **Nothing is deleted.** The audit that preceded this (commit `72a0080`) found
   zero orphan modules on either side of the repo. There is no dead code to purge.

## What the audit established, and why it changed the design

Written before the design because two of these would have sent the build in the
wrong direction:

- **`frontend/lib/predictions.ts` does not exist.** CLAUDE.md named it as the
  pipeline↔frontend contract. The contract is `frontend/lib/data/narrow.ts`, whose
  rule 4 is *runtime narrowing, never `as T`* — every `raw.foo` access in the app
  lives in that one file. A new artifact therefore needs a narrower there, not an
  interface somewhere convenient.
- **`/table` returns 410**, along with 21 other retired routes, via the exported
  `GONE` set in `frontend/middleware.ts`. A "team table" page cannot reuse that
  path, and reviving it would contradict a deliberate retirement.
- **`fbrefdata` exposes eleven stat types where `soccerdata` exposes five — but it
  does not install on this machine.** Measured 2026-09-04: every published
  `fbrefdata` caps at Python `<3.13`, the repo venv is 3.14.4, so
  `fetch_fbref_passing_stats` returns `None` locally by design. It installs under
  CI's Python 3.11 only. `goal_shot_creation`, `possession` and `defense` are
  therefore **CI-only tables**, testable locally by fixture and first executed for
  real on a daily pipeline run.

  `soccerdata` is installed, works on 3.14, and `read_team_season_stats` there
  takes `opponent_stats` — which is what makes a *defence* ranking measured rather
  than inferred. Its five types include `shooting`.

  **Revised decision 6, taken 2026-09-04 after that measurement: build phase one on
  `soccerdata`'s `shooting` table alone, both directions.** It yields shots, shots
  on target, xG, npxG, npxG per shot, average shot distance and free-kick shots,
  for and against — which answers "is this attack generating quality chances" and
  "is this defence conceding them", and can be run and verified here. SCA/GCA and
  touches-in-box are deferred to a phase two that adds the `fbrefdata` tables, once
  the artifact, narrower and page are proven. Building the whole thing on code that
  cannot execute locally would repeat today's embed mistake: green fixtures over a
  feature nobody has watched work.
- **Big chances are Opta-defined and licensed.** Not in FBref or Understat at any
  tier we pay for. They will be a labelled proxy or absent, never presented as the
  real metric.

## A — @robtFPL on `/evidence`

A section on the existing page, beside `news_view`. `/evidence` already absorbed
`/inbox`, `/accuracy` and `/health`, which makes it the surface for "what outside
sources are saying".

**Component**: `frontend/components/evidence/TimelineEmbed.tsx`.

- Loads X's `widgets.js` through `next/script` with `strategy="lazyOnload"`, so a
  blocked or slow third party never delays the page the owner actually came for.
- `data-dnt="true"` on the embed, and the section renders a titled, linked
  fallback if the script does not resolve — a silent empty box is
  indistinguishable from "he has not posted".
- Height-capped with its own scroll, per the repo's overflow rule.

**Why not capture.** Considered and rejected: capturing his images means
re-hosting another author's copyrighted work on a public site with his attribution
and view count stripped. The embed keeps both intact. `scripts/x_scan.mjs` stays
text-only and unchanged, and continues to feed claims — a different job.

**What this does not give us.** No diffable history of his projections. If that is
later wanted, the answer is to extract *numbers* into our own artifact, not to
store his images. Deliberately deferred.

## B — team metrics and the ranking

### Ingestion

Generalise, rather than duplicate. `pipeline/data/fbref.py` currently has
`fetch_fbref_passing_stats`, hardcoded to `stat_type="passing"`. It becomes:

```
fetch_fbref_team_stats(stat_type, *, opponent_stats=False, season=None, force=False)
```

with `fetch_fbref_passing_stats` kept as a thin wrapper so existing callers and
their tests do not move. Stat types wired: `shooting`, `goal_shot_creation`,
`possession`, `defense`, each fetched both ways for the for/against pair. Caching
follows the existing parquet-per-season pattern; the cache key gains the stat type
and the opponent flag, or the four tables overwrite one another.

Understat supplies the open-play/set-piece split, which FBref does not carry
cleanly. `pipeline/data/understat.py` is player-level by design; team situation
splits go in `fbref.py` beside the existing Understat team fetch.

### Derivation

`pipeline/learning/team_view.py`, following `news_view.py` and `evidence_view.py` —
this repo already puts view-builders in `learning/`, and a view-builder is what
this is. It emits `predictions/team_metrics.json`.

Publishing it is a **second, explicit change**: the "Sync predictions to frontend"
step in `.github/workflows/pipeline.yml` uses hardcoded file lists and says why —
*"A glob silently publishes every new artifact the pipeline learns to write."*
`team_metrics.json` goes in the **OPTIONAL** list, guarded by `[ -f ... ]`, because
decision 1 makes it best-effort: an absent one must emit a notice, not fail the
run. Putting it in the REQUIRED list would make a bad FBref response stop the
daily pipeline.

Per club, per direction (for / against), per 90: shots, shots on target, npxG,
npxG per shot, SCA, GCA, touches in the attacking penalty area, set-piece share of
shots, and a **labelled** proxy for chance quality: `shots_over_xg_030`, a count of
shots with xG above 0.30. The threshold is in the field name deliberately, so the
number can never be read as Opta's "big chances"; 0.30 is the common public proxy
and is `quant-modeller`'s to confirm or move.

### Uncertainty is structural, not a footnote

The exercise that prompted this measured the cost of ignoring it: across the six
columns of Ghono's matrix, only **16% of the 720 team pairs** were separable at 95%
from two matches of data, and the centre column separated 2% — a rank attached to
noise. Our own pipeline already concedes the point by listing Coventry City and
Hull City in `fixture_xg.json`'s `prior_only_clubs`.

So every rate is shrunk toward the league mean by `n / (n + k)`, and every club
below a match threshold renders as **"not yet measurable"** rather than as a rank.
The page shows the interval, not just the point. **The shrinkage constant `k` and
the threshold are for `quant-modeller`** — they are statistical choices even
though nothing downstream consumes them, and a number picked by eye here would
undermine the one thing this page exists to demonstrate.

### Surface

`frontend/app/teams/page.tsx` — a new path, because `/table` is retired and
`/stats` is player-level and says so in its own docstring. Tokens from
`frontend/lib/margin/tokens.ts` (`FLOODLIT`, `SANS`); table component at
`frontend/components/teams/TeamTable.tsx`.

Three tabs, by warranty:

| Tab | Columns | Answers |
|---|---|---|
| **Measured** | FBref/Understat primitives, for and against, shrunk, with intervals | "who is actually good" — the truer table |
| **Forecast** | our per-fixture goal rates from `fixture_xg.json` and the xP artifact | "what do we predict" |
| **Gap** | forecast minus measured, sortable, fixture-scoped to the current GW | "where do we disagree with the stats", and "which defence to attack" |

A narrower for `team_metrics.json` goes in `frontend/lib/data/narrow.ts` with a
descriptor-table entry, per rule 4. No `as T`.

## C — FantasyFootballFix as a verification lane

**Not scheduled, and it cannot be.** The pipeline runs 06:00 UTC in GitHub Actions:
no browser, no session, no login. This is CLAUDE.md's MCP rule 3 generalised — a
session tool exists in a session and nowhere else.

**Not committed, and it must not be.** The repo and `pl2627.vercel.app` are both
public, so a commit publishes licensed Opta data to the world.

What it is instead: the Stats Sandbox is a real HTML table in the DOM — confirmed
by structural extraction on 2026-09-04, no OCR — with a player/team toggle,
gameweek-range and venue filters, and metric groups for Set Pieces, Defending,
Involvement and Distribution. So on request, in-session, the figures are read
structurally and written to `predictions/local/fffix_reference.json`.

**That path is not currently ignored, and the ignore rule is the first thing built
in sub-project C** — `predictions/local/` added to `.gitignore`, with the reason in
a comment. Without it the lane commits the exact data this decision exists to keep
out of a public repo. A test asserting the path is ignored is cheap and worth
having, because the failure is silent and permanent: once pushed, it is in the
history.

`/teams` reads the file only when present, and labels every value with its source
and read date. What reaches `predictions/` is our own delta and that date.

Column choice is the owner's: enabling extra Opta columns changes a saved account
setting, which is not ours to change.

## Error handling

The governing constraint is CLAUDE.md's: optional scraped sources degrade
gracefully, sources the models depend on fail loudly. Everything here is optional,
because decision 1 makes it a view.

- FBref or Understat unavailable → the affected columns render **"unavailable"**
  with the reason, and `team_metrics.json` records which tables were fetched. A
  blank cell must never be mistakable for a measured zero. This is the
  `HealthData` lesson from `narrow.ts` — the drift was invisible because a cast
  hid it.
- `team_metrics.json` absent → `/teams` renders the Forecast tab alone and says
  the Measured side is missing.
- FFFix file absent → the reference column is omitted entirely, not zeroed. This is
  the normal state in production and must look deliberate.
- X embed blocked → linked fallback, as above.

## Testing

- **Ingestion**: fixture-driven unit tests for `fetch_fbref_team_stats` — the
  cache key includes stat type and opponent flag; an empty upstream returns `None`
  rather than an empty frame typed as success. Per CLAUDE.md, `unittest`, not
  pytest.
- **Derivation**: `team_view.py` gets tests for the per-90 conversion, the
  shrinkage weight at n=0, n=k and n→∞, and the "not yet measurable" boundary.
  A club with zero matches must not produce a rank.
- **Narrower**: tested against the committed artifact, following the existing
  narrower tests — including the null-tolerance cases `narrow.ts` documents.
- **Component**: `TeamTable` renders the unavailable state, the interval, and the
  proxy label; `TimelineEmbed` renders its fallback when the script is absent.
- **Gate before push**: both suites plus lint and build. Baseline to beat, measured
  2026-09-04: 2143 python, 1081 frontend.

## Out of scope

Named, so it does not creep in:

- No model coupling. The ranking feeds no xP, no lambda, no stake.
- No scheduled FFFix access, no credential storage, no automated login.
- No re-hosting of anyone's images.
- No auth layer on the site.
- No revival of `/table`, `/h2h` or `/intelligence`.
- No diffable archive of @robtFPL's projections in this pass.

## Sequencing

A, then C, then B. A is independent and small; C is mostly a gitignore entry plus a
read procedure; B carries the ingestion, the statistics and the surface. B's
shrinkage constants go to `quant-modeller` before the page is built, since the
page's whole claim is that it handles small samples honestly.
