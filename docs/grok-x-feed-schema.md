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

## The prompt

Paste this to Grok, with your own file location appended.

> Search X for Premier League team news and FPL-relevant posts from the last 24
> hours. For each item, output one JSON object in the array below.
>
> **Rules you must not break:**
>
> 1. `quote` must be **word-for-word from the post**. If you are summarising,
>    omit `quote`, give `url` only, and set `tier` to 3.
> 2. Use `tier: 2` **only** for a direct quote from a manager, club, or
>    press-conference reporter. Everything else is `tier: 3`.
> 3. `claimed_at` is the timestamp **of the post**, not of your search.
> 4. Never invent a `claimed_at`, a `url`, or a player. If you are unsure who a
>    post refers to, use `claim_type: "unparsed_news"` and put the text in
>    `value`.
> 5. Projections and ratings from any account go in `lane: "comparator"`, never
>    `lane: "availability"` — even from a source you trust.
> 6. `chance_of_playing` is an integer like `25`, not `"25%"`.
>    `permanent_exit` is `{"kind": "transfer"}`, not `"transfer"`.
> 7. Give the player's surname as FPL spells it, and the club's full name.
>
> If you find nothing, return `"items": []`. An empty list is a correct answer
> and is more useful than a guess.
>
> ```json
> {"schema_version": 1, "generated_at": "<now, ISO-8601 UTC>", "items": []}
> ```

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
