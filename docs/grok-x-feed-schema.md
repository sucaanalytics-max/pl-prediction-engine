# The Grok/X feed schema

A file **you** control, which Grok appends to and the news poller reads as a
seventh feed. This document is the contract, and the section marked
[PROMPT](#the-prompt) is meant to be pasted to Grok verbatim.

## Why the file is yours and not X's API

X's free tier has no tweet-read access and the pay-per-use route is ~£35/mo,
which the £0 decision excludes. Reading a file you maintain sidesteps that: we
are not calling X, and we are not redistributing anything — we are reading your
notes, which is what `pipeline/learning/file_claim.py` was built for.

That also means the honesty burden sits on the file. Everything below exists to
stop a language model's paraphrase entering a store whose claims can lower a
real player's projected minutes.

## The two lanes, and why they are separate

**Do not mix these.** They have different consequences.

| Lane | What it is | Effect |
|---|---|---|
| `availability` | Team news: fitness, suspension, a return date, a departure | Can push availability **down** via R4 |
| `comparator` | Someone else's projections or ratings | Never touches availability; compared against ours |

@robtFPL belongs in `comparator`, and this is not a technicality. His content is
market-derived projections, and `pipeline/models/market_rates.py` already inverts
no-vig prices itself. Filing it as availability evidence would double-count the
market — once through our own inversion and again through his — and the model
would then agree with itself and call that confirmation. As a comparator it
answers a different and useful question: does an independent reading of the same
prices land where ours does.

---

## File format

One JSON object per file, UTF-8, at a URL the poller can GET without auth.

```json
{
  "schema_version": 1,
  "generated_at": "2026-08-11T09:00:00Z",
  "items": []
}
```

`generated_at` is when the file was written. It is not a claim timestamp and is
never used for recency.

---

## An `availability` item

Every field below is **required**. There are no optional fields in this lane,
because each one is load-bearing for a gate that already exists.

```json
{
  "lane": "availability",
  "claim_type": "chance_of_playing",
  "value": 25,
  "player_surname": "Rogers",
  "club": "Aston Villa",
  "tier": 2,
  "source": "robtFPL",
  "quote": "Rogers is a doubt for the weekend, Emery confirmed in the presser",
  "url": "https://x.com/robtFPL/status/1234567890",
  "claimed_at": "2026-08-11T08:42:00Z"
}
```

### `claim_type` and the exact shape of `value`

Taken from `FILEABLE` in `file_claim.py`. Anything else is rejected.

| `claim_type` | `value` | Validated as |
|---|---|---|
| `chance_of_playing` | `25` | integer 0–100. Not `"25%"` |
| `expected_minutes` | `62.5` | number 0–90 |
| `return_date` | `"2026-09-14"` | exactly `YYYY-MM-DD` |
| `unavailable_until` | `"2026-09-14"` | exactly `YYYY-MM-DD` |
| `permanent_exit` | `{"kind": "transfer"}` | object with `kind` ∈ `transfer\|loan\|free_agent` |
| `severity` | `"hamstring, 4-6 weeks"` | free text |
| `unparsed_news` | `"Emery on Rogers: ..."` | free text |

`permanent_exit` must be an **object**, not the string `"transfer"`. R0 checks
`isinstance(value, Mapping) and "kind" in value` and silently drops anything
else — the claim would be recorded successfully and then vanish at resolution,
which is worse than being rejected.

Two claim types are deliberately **not** fileable: `status` is FPL's own field,
and `predicted_start` belongs to the minutes model rather than the availability
view.

### `tier` — 2 or 3 only

Tier 1 is reserved for FPL's own fields and our parse of its own text. A filed
claim taking tier 1 would outrank FPL under R3 while carrying less authority than
the press conference it came from.

- **tier 2** — a direct quote from a manager, club, or press-conference reporter.
- **tier 3** — an aggregator, a summary, or a well-sourced report without a
  direct quote.

**If Grok is paraphrasing rather than reproducing, the item is tier 3 at best.**
A paraphrase attributed to a manager is a claim about the paraphraser.

### `quote` and `url` — at least one, and prefer both

R0 requires a provenance digest for every tier-2+ claim, and
`build_claim` raises without one:

> a tier-2+ claim needs `--quote` or `--url` so it can be audited; rule R0 drops
> claims with no provenance digest

`quote` must be **verbatim from the source**, not Grok's summary of it. This is
the single most important rule in this document. A claim with an invented quote
is indistinguishable from a real one at the point it is stored, and R4 lets it
lower a real player's availability.

If Grok cannot produce the original wording, it must omit `quote` and supply
`url` alone, and drop to tier 3.

### `player_surname` and `club`

Grok will not know FPL element ids, so resolution happens our side via
`resolve_element`, which matches on surname within a club and **refuses
ambiguity rather than guessing** — two Silvas at one club escalate instead of
one being picked.

Give the surname as it appears in FPL (`"Rogers"`, not `"Morgan Rogers"`), and
the club in full (`"Aston Villa"`, not `"Villa"` or `"AVL"`). Names are
canonicalised through `pipeline/data/team_mapping.py`.

### `claimed_at`

When the **source** said it, in ISO-8601 UTC — the timestamp of the tweet, not
when Grok read it. Recency is judged on `claimed_at` under R2's tie-break, so a
wrong value here lets a stale claim outrank a fresh one.

A `claimed_at` in the future is rejected outright: it is the one check that stops
a back-dated claim winning.

---

## A `comparator` item

```json
{
  "lane": "comparator",
  "metric": "projected_points",
  "value": 6.4,
  "horizon_gameweeks": 1,
  "player_surname": "Rogers",
  "club": "Aston Villa",
  "source": "robtFPL",
  "url": "https://x.com/robtFPL/status/1234567890",
  "claimed_at": "2026-08-11T08:42:00Z"
}
```

No `tier`, because it is not evidence and cannot win a resolution. No `quote`
requirement, because nothing it says will move a projection.

`metric` ∈ `projected_points | expected_minutes | rating | rank`.

---

## What gets rejected, and why

Rejection is loud. An item that fails is reported with its index and reason
rather than skipped, because a silently dropped claim is indistinguishable from
a poller that has stopped.

| Rejected | Reason |
|---|---|
| `claim_type` not in the table | `FILEABLE` is closed |
| `tier` 1, 0, or absent on an availability item | Tier 1 is FPL's own |
| Neither `quote` nor `url` | R0 drops claims with no digest |
| `claimed_at` in the future | Stops a back-dated claim outranking a fresh one |
| `chance_of_playing` as `"25%"` | Must be an integer; a string compares wrongly against FPL's integer |
| `permanent_exit` as `"transfer"` | R0 needs a Mapping with `kind` |
| Surname ambiguous within the club | Escalates; never guesses |
| Surname not found | Becomes club-level `unparsed_news`, never a guessed player |
| `lane` absent | The two lanes have different consequences and are not inferred |


---

## Google Sheets (recommended)

The poller accepts either a JSON file or a **published Google Sheet**, decided by
sniffing the response rather than the URL — a Sheets publish link carries no
`.csv` extension and a gist raw URL may.

A sheet is the recommended shape for one reason above the others: **you can see
and correct the rows.** Nothing in this system can tell a real quote from a
fluent invention, so the last line of defence is a human glancing at a table.
That is worth more than the tidiness of JSON.

### Setting it up

1. New Google Sheet. Paste the header row below into row 1, exactly.
2. **File → Share → Publish to web → Entire document → Comma-separated values (.csv)**.
3. Copy the URL it gives you.
4. Add it as a repository secret named `GROK_FEED_URL`
   (Settings → Secrets and variables → Actions).

Do not paste that URL into a chat window. A published sheet is readable by anyone
holding the link, so keep the sheet to public tweets and public team news and put
nothing private in it.

### The header row

```
lane,claim_type,value,player_surname,club,tier,source,quote,url,claimed_at,metric,horizon_gameweeks
```

Columns may be in any order and unknown columns are ignored, so you can add your
own notes column without breaking anything. Empty cells are treated as absent
rather than as an empty value.

`value` stays a plain word for `permanent_exit` — write `transfer`, not
`{"kind": "transfer"}`. The nesting R0 requires is built for you; asking anyone
to type JSON into a cell produces a broken string far more often than a correct
one.

`metric` and `horizon_gameweeks` are for `comparator` rows only. `tier`, `quote`
and `claim_type` are for `availability` rows only.

### A worked sheet

| lane | claim_type | value | player_surname | club | tier | source | quote | url | claimed_at | metric |
|---|---|---|---|---|---|---|---|---|---|---|
| availability | chance_of_playing | 25 | Rogers | Aston Villa | 2 | robtFPL | Rogers is a doubt, Emery confirmed in the presser | https://x.com/... | 2026-08-11T08:42:00Z | |
| availability | permanent_exit | transfer | Solomon | Tottenham | 3 | BBC Sport | | https://bbc.co.uk/... | 2026-08-11T07:10:00Z | |
| availability | return_date | 2026-09-14 | Gudmundsson | Leeds | 3 | FFScout | | https://... | 2026-08-11T06:00:00Z | |
| comparator | | 6.4 | Salah | Liverpool | | robtFPL | | https://x.com/... | 2026-08-11T08:00:00Z | projected_points |

---

## Cadence, and the overlap problem it creates

Set this up as a **Grok scheduled task running every 3 hours**, which matches the
agent's own cadence. The poller reads the sheet every fifteen minutes, so a row
is picked up within minutes of appearing.

Three hours of overlap would be a problem if it were not handled. `claim_id` is
a content hash of `[source, element_id, claim_type, value, claimed_at]` — it
excludes `observed_at`, so **an identical re-report deduplicates to one claim.**
What does *not* deduplicate is a re-worded one: "hamstring, 4-6 weeks" and
"hamstring — four to six weeks" are two claims about one injury.

So the prompt does two things about it. It asks for a **3-hour window** matching
the cadence, so consecutive runs barely overlap; and it asks that anything
carried over be repeated **byte-identically**, so the hash collides and the
duplicate collapses.

Structured claim types (`chance_of_playing`, `return_date`, `permanent_exit`)
deduplicate reliably because their values are canonical. Free text (`severity`,
`unparsed_news`) does not, which is why the prompt prefers the structured ones
where either would do.

The sheet itself grows. `GROK_FEED["max_age_days"] = 3` means anything older than
three days is ignored regardless, so an unpruned sheet costs bytes rather than
correctness — but clearing rows older than a week keeps it readable, which is the
whole reason for choosing a sheet.

---

## The prompt

Set this as a **recurring Grok task, every 3 hours**.

> **Run this every 3 hours as a scheduled task.**
>
> You are collecting Fantasy Premier League team news for **Gameweek {GW}**,
> whose deadline is **{DEADLINE}**. Search X and the open web for posts from the
> **last 3 hours** — the window matches how often you run, so you neither miss
> news nor repeat yourself.
>
> **Cover, in this order of priority:**
>
> 1. **Injury and availability news** — press-conference quotes from managers,
>    club statements, and reliable reporters. This is the most valuable category
>    and the only one that can change a projection.
> 2. **@robtFPL** — his projections, ratings and expected-minutes calls.
> 3. **Other high-signal FPL accounts** — @FPLGeneral, @FPL_Salah,
>    @OfficialFPL, @FFScout_Az and similar, plus anything with unusually high
>    engagement about a specific player's fitness or minutes.
> 4. **Confirmed transfers and loans** that remove a player from the league.
>
> **Output a CSV** with exactly this header, one row per item, and nothing else
> — no commentary before or after, so it can be pasted straight into a sheet:
>
> ```
> lane,claim_type,value,player_surname,club,tier,source,quote,url,claimed_at,metric,horizon_gameweeks
> ```
>
> **Rules you must not break:**
>
> 1. **`quote` must be word-for-word from the post.** If you are summarising in
>    your own words, leave `quote` empty, give the `url`, and set `tier` to 3.
>    Never write a quote you have reconstructed.
> 2. **`tier` is 2 only for a direct quote** from a manager, club, or
>    press-conference reporter. Everything else is 3. If in doubt, 3.
> 3. **Projections and ratings go in `lane=comparator`, never
>    `lane=availability`** — including robtFPL's. Set `metric` to
>    `projected_points`, `expected_minutes`, `rating` or `rank`, leave `tier`,
>    `claim_type` and `quote` empty.
> 4. **`claimed_at` is the timestamp of the post**, not of your search, in
>    ISO-8601 UTC like `2026-08-11T08:42:00Z`. Never invent one. If you cannot
>    determine it, skip the item.
> 5. **Never invent a URL or a player.** If you cannot tell who a post is about,
>    use `claim_type=unparsed_news`, put the text in `value`, and still give the
>    club if you know it.
> 6. **Formats:** `chance_of_playing` is a bare integer like `25`, not `25%`.
>    `return_date` and `unavailable_until` are `YYYY-MM-DD`. `permanent_exit` is
>    one word: `transfer`, `loan` or `free_agent`. `expected_minutes` is 0-90.
> 7. **`player_surname` as FPL spells it** (`Rogers`, not `Morgan Rogers`), and
>    the club's full name (`Aston Villa`, not `Villa`).
> 8. **One row per claim.** If a post says two players are doubtful, that is two
>    rows sharing a url and a quote.
> 9. **If a quote contains a comma, wrap the field in double quotes.**
> 10. **If you carry an item over from your previous run** — because it is still
>     the latest word on a player — reproduce that row **exactly as you wrote it
>     before**: same `value` wording, same `claimed_at`, same `source`. Those
>     four fields are hashed to deduplicate, so an identical row collapses to one
>     claim and a re-worded one becomes two claims about one injury.
> 11. **Prefer a structured claim type over free text** where either would fit.
>     `chance_of_playing=25` deduplicates reliably across runs;
>     `severity=doubtful for the weekend` does not, because you will phrase it
>     differently next time. Use `severity` and `unparsed_news` only when nothing
>     structured fits.
>
> **Do not include:** transfer rumours with no source, "X is a great captain
> pick" opinions, or anything you inferred rather than read. An empty result is
> a correct answer and more useful than a guess — if you find nothing, output
> the header row alone.


Paste this to Grok, with your own file location appended.

---

## Where it plugs in

The poller fetches the file, validates every item, and files the survivors
through the existing lane. Nothing new touches resolution:

```
your file  ──►  validate  ──►  file_claim.build_claim  ──►  availability store
                    │                                            │
                    └── rejections logged with index & reason     └── R0–R8 unchanged
```

Comparator items go to a separate artifact and are rendered beside our own
numbers on `/players`. They never enter the availability store.

## What this cannot fix

Grok's output is a model's reading of a post. A verbatim quote plus a working URL
makes it **auditable** — you can click through and check — but it does not make
it verified, and nothing in this schema verifies it. That is why tier 2 requires
a real quote and why the ceiling for a paraphrase is tier 3: the design assumes
the file can be wrong and limits what a wrong entry can do.

An item that turns out to be fabricated is removable by claim id, because the
store is append-only and content-addressed.
