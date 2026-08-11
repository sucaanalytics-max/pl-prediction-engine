"""
Validating the Grok/X feed before anything reaches the claim store.

The schema is `pipeline/data/schemas/grok_x_feed.schema.json` and the contract is
`docs/grok-x-feed-schema.md`. This module is the enforcement, and it exists
because a schema nothing checks is a suggestion.

## What it is defending against

A language model's reading of a post, entering a store whose claims can lower a
real player's projected minutes through R4. Every rule below mirrors a gate that
already exists in `file_claim.py`; the point is to fail here, loudly, with an
item index, rather than to file something that resolution will silently discard.

Two failure modes are specifically anticipated because they are what a model
does when it is unsure rather than wrong:

* **Paraphrase presented as a quote.** Unfixable by validation — we cannot tell
  a real quote from a fluent invention. What we can do is cap what an
  unverifiable claim is allowed to affect, which is why tier 2 requires a
  `quote` at all and why the doc tells Grok to drop to tier 3 without one.
* **A plausible timestamp.** A `claimed_at` in the future is rejected outright,
  because recency decides R2's tie-break and a back-dated or forward-dated claim
  outranks an honest one.

## Deliberately not imported

`jsonschema` is not a dependency of the news poller, which installs `requests`
and `feedparser` only. The checks here are hand-written for that reason — the
same constraint that broke `news_view.write` when it reached for a helper
needing PyYAML. The JSON Schema file is the documentation and the editor
contract; this is the runtime.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

#: Mirrors FILEABLE in file_claim.py. Closed on purpose.
CLAIM_TYPES = (
    "chance_of_playing", "expected_minutes", "return_date",
    "unavailable_until", "permanent_exit", "severity", "unparsed_news",
)

#: Mirrors MANUAL_TIERS. Tier 1 is FPL's own fields.
TIERS = (2, 3)

COMPARATOR_METRICS = ("projected_points", "expected_minutes", "rating", "rank")

EXIT_KINDS = ("transfer", "loan", "free_agent")

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
URL = re.compile(r"^https?://", re.IGNORECASE)

#: A quote shorter than this is not a quote. Chosen to reject `"yes"` and
#: `"out"` without rejecting a genuinely terse one.
MIN_QUOTE = 8


@dataclass
class Rejection:
    """One item that cannot be filed, and why."""

    index: int
    reason: str
    lane: Optional[str] = None

    def __str__(self) -> str:
        return f"items[{self.index}]: {self.reason}"


@dataclass
class Validated:
    """What survived, and what did not."""

    availability: List[Dict[str, Any]] = field(default_factory=list)
    comparator: List[Dict[str, Any]] = field(default_factory=list)
    rejections: List[Rejection] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.rejections


def _parse_stamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def check_value(claim_type: str, value: Any) -> Optional[str]:
    """
    Whether ``value`` has the shape ``claim_type`` requires, or why not.

    Mirrors `file_claim.coerce_value`, which raises on the same conditions. The
    duplication is deliberate: `coerce_value` parses CLI strings, and this
    validates already-typed JSON, so a shared implementation would have to
    accept both and would be looser than either.
    """
    if claim_type == "chance_of_playing":
        # `bool` is an int in Python; True would pass an isinstance check and
        # then compare as 1 against FPL's percentage.
        if isinstance(value, bool) or not isinstance(value, int):
            return f"chance_of_playing must be an integer 0-100, got {value!r} (not '25%')"
        if not 0 <= value <= 100:
            return f"chance_of_playing {value} is outside 0-100"
        return None

    if claim_type == "expected_minutes":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return f"expected_minutes must be a number 0-90, got {value!r}"
        if not 0.0 <= float(value) <= 90.0:
            return f"expected_minutes {value} is outside 0-90"
        return None

    if claim_type in ("return_date", "unavailable_until"):
        if not isinstance(value, str) or not DATE.match(value):
            return f"{claim_type} must be YYYY-MM-DD, got {value!r}"
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError:
            return f"{claim_type} {value!r} is not a real date"
        return None

    if claim_type == "permanent_exit":
        # R0 checks `isinstance(value, Mapping) and "kind" in value` and drops
        # anything else. A bare string would be recorded and then vanish at
        # resolution, which is worse than being rejected here.
        if not isinstance(value, Mapping):
            return (
                f"permanent_exit must be an object like "
                f'{{"kind": "transfer"}}, got {value!r}'
            )
        kind = value.get("kind")
        if kind not in EXIT_KINDS:
            return f"permanent_exit kind must be one of {EXIT_KINDS}, got {kind!r}"
        return None

    # severity and unparsed_news are free text, but not empty text.
    if not isinstance(value, str) or not value.strip():
        return f"{claim_type} must be non-empty text, got {value!r}"
    return None


def _check_availability(item: Mapping[str, Any], now: datetime) -> Optional[str]:
    for required in ("claim_type", "value", "player_surname", "club", "tier",
                     "source", "claimed_at"):
        if required not in item:
            return f"availability item is missing {required!r}"

    claim_type = item["claim_type"]
    if claim_type not in CLAIM_TYPES:
        return (
            f"{claim_type!r} cannot be filed; choose from {CLAIM_TYPES}. "
            f"('status' is FPL's own field and 'predicted_start' belongs to the "
            f"minutes model.)"
        )

    problem = check_value(claim_type, item["value"])
    if problem:
        return problem

    if item["tier"] not in TIERS:
        return (
            f"tier {item['tier']!r} is not available to a filed claim; choose "
            f"from {TIERS}. Tier 1 is reserved for FPL's own fields."
        )

    quote = item.get("quote")
    url = item.get("url")
    has_quote = isinstance(quote, str) and len(quote.strip()) >= MIN_QUOTE
    has_url = isinstance(url, str) and bool(URL.match(url))
    if not (has_quote or has_url):
        return (
            "a tier-2+ claim needs a verbatim quote or a url so it can be "
            "audited; rule R0 drops claims with no provenance digest"
        )
    if isinstance(quote, str) and quote.strip() and not has_quote:
        return f"quote {quote!r} is too short to be a quote"
    if url is not None and not has_url:
        return f"url {url!r} is not an http(s) url"

    stamp = _parse_stamp(item["claimed_at"])
    if stamp is None:
        return f"claimed_at {item['claimed_at']!r} is not an ISO-8601 timestamp"
    if stamp > now:
        return (
            f"claimed_at {item['claimed_at']} is in the future: recency decides "
            f"R2's tie-break, so a forward-dated claim would outrank an honest one"
        )

    for field_name in ("player_surname", "club", "source"):
        if not isinstance(item[field_name], str) or not item[field_name].strip():
            return f"{field_name} is required and must be non-empty"
    return None


def _check_comparator(item: Mapping[str, Any], now: datetime) -> Optional[str]:
    for required in ("metric", "value", "player_surname", "club", "source",
                     "claimed_at"):
        if required not in item:
            return f"comparator item is missing {required!r}"
    if item["metric"] not in COMPARATOR_METRICS:
        return f"metric must be one of {COMPARATOR_METRICS}, got {item['metric']!r}"
    if isinstance(item["value"], bool) or not isinstance(item["value"], (int, float)):
        return f"comparator value must be a number, got {item['value']!r}"
    if "tier" in item:
        # A tier would imply it can win a resolution. It cannot.
        return (
            "a comparator item must not carry a tier: it never enters the "
            "availability store and cannot beat a claim"
        )
    stamp = _parse_stamp(item["claimed_at"])
    if stamp is None:
        return f"claimed_at {item['claimed_at']!r} is not an ISO-8601 timestamp"
    if stamp > now:
        return f"claimed_at {item['claimed_at']} is in the future"
    return None


def validate(payload: Any, now: datetime) -> Validated:
    """
    Split a fetched feed into what can be filed and what cannot.

    Never raises for bad content — a malformed feed must not stop the poll that
    fetched it. The caller logs `rejections`, and every one carries its item
    index so a 60-item file can be corrected without guesswork.
    """
    out = Validated()

    if not isinstance(payload, Mapping):
        out.rejections.append(Rejection(-1, "the feed is not a JSON object"))
        return out
    if payload.get("schema_version") != SCHEMA_VERSION:
        out.rejections.append(Rejection(
            -1,
            f"schema_version must be {SCHEMA_VERSION}, got "
            f"{payload.get('schema_version')!r}",
        ))
        return out

    items = payload.get("items")
    if not isinstance(items, list):
        out.rejections.append(Rejection(-1, "items must be an array"))
        return out

    for index, item in enumerate(items):
        if not isinstance(item, Mapping):
            out.rejections.append(Rejection(index, "item is not an object"))
            continue
        lane = item.get("lane")
        if lane == "availability":
            problem = _check_availability(item, now)
            (out.rejections.append(Rejection(index, problem, lane)) if problem
             else out.availability.append(dict(item)))
        elif lane == "comparator":
            problem = _check_comparator(item, now)
            (out.rejections.append(Rejection(index, problem, lane)) if problem
             else out.comparator.append(dict(item)))
        else:
            # Not inferred. The two lanes have different consequences: one can
            # lower a projection and the other cannot.
            out.rejections.append(Rejection(
                index,
                f"lane must be 'availability' or 'comparator', got {lane!r}",
            ))

    return out


#: Columns a published Google Sheet must carry, in any order.
#:
#: Flat because a spreadsheet is flat. `permanent_exit` needs a Mapping with a
#: `kind` key to survive R0, and `rows_to_items` builds it — asking a human to
#: type `{"kind": "transfer"}` into a cell would produce a broken JSON string
#: far more often than a correct one.
SHEET_COLUMNS = (
    "lane", "claim_type", "value", "player_surname", "club", "tier",
    "source", "quote", "url", "claimed_at", "metric", "horizon_gameweeks",
)


def rows_to_items(rows: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """
    Turn spreadsheet rows into feed items.

    Everything arrives as a string, so this restores the types the validator
    checks: `tier` and `chance_of_playing` to int, `expected_minutes` and a
    comparator `value` to float, `permanent_exit` to `{"kind": ...}`.

    A cell that cannot be converted is left as the original string rather than
    coerced or dropped. The validator then rejects it with a message naming the
    row, which is far more useful than a silent `None` — and silently dropping
    it is how a claim that looks filed goes missing.

    Empty cells are omitted rather than sent as `""`, so a missing required
    field reads as missing rather than as an empty value.
    """
    items: List[Dict[str, Any]] = []
    for row in rows:
        item: Dict[str, Any] = {}
        for key, raw in row.items():
            if key is None:
                continue
            name = str(key).strip().lower()
            if name not in SHEET_COLUMNS:
                continue
            text = "" if raw is None else str(raw).strip()
            if not text:
                continue
            item[name] = text

        if "tier" in item:
            try:
                item["tier"] = int(item["tier"])
            except ValueError:
                pass
        if "horizon_gameweeks" in item:
            try:
                item["horizon_gameweeks"] = int(item["horizon_gameweeks"])
            except ValueError:
                pass

        claim_type = item.get("claim_type")
        if "value" in item:
            if claim_type == "chance_of_playing":
                text = str(item["value"]).rstrip("%").strip()
                try:
                    item["value"] = int(text)
                except ValueError:
                    pass
            elif claim_type == "expected_minutes" or item.get("lane") == "comparator":
                try:
                    item["value"] = float(item["value"])
                except ValueError:
                    pass
            elif claim_type == "permanent_exit":
                # The nesting R0 requires, built here so a cell stays a word.
                item["value"] = {"kind": str(item["value"]).strip().lower()}
        items.append(item)
    return items


def parse_sheet(text: str) -> Dict[str, Any]:
    """
    A published Google Sheet CSV, as a feed payload.

    `csv` is stdlib, so this costs the poller nothing — the same constraint that
    keeps `jsonschema` out of this module.
    """
    import csv
    import io

    reader = csv.DictReader(io.StringIO(text))
    return {
        "schema_version": SCHEMA_VERSION,
        "items": rows_to_items(list(reader)),
    }


def fetch(url: str, config: Mapping[str, Any]) -> Any:
    """
    GET the feed and parse it, as JSON or as a published-sheet CSV.

    The format is decided by what came back, not by the URL: a Google Sheets
    publish link carries no `.csv` extension, and a gist raw URL may. Sniffing
    the body is the only reading that holds for both.

    Size-capped before parsing, like the RSS fetcher: a hostile or broken
    response should not be parsed at all rather than parsed and then rejected.
    """
    import requests

    response = requests.get(
        url,
        timeout=int(config.get("timeout_seconds", 20)),
        headers={"Accept": "application/json"},
    )
    response.raise_for_status()
    cap = int(config.get("max_bytes", 2_000_000))
    body = response.content[: cap + 1]
    if len(body) > cap:
        raise ValueError(f"feed exceeds the {cap}-byte cap; refusing to parse it")
    text = body.decode("utf-8-sig")

    content_type = str(response.headers.get("Content-Type", "")).lower()
    stripped = text.lstrip()
    if "csv" in content_type or not stripped.startswith(("{", "[")):
        return parse_sheet(text)

    import json as _json

    return _json.loads(text)


#: The instruction sent to the API. Kept in the source rather than a config
#: string so it is reviewable in a diff — it is the only thing standing between
#: a model's guess and a store that can lower a projection.
#:
#: Mirrors the human prompt in docs/grok-x-feed-schema.md. When one changes the
#: other must, and `test_grok_feed.py` asserts the load-bearing rules appear in
#: both.
SYSTEM_PROMPT = """You extract Fantasy Premier League team news into CSV. \
You never invent a quote, a URL, a player or a timestamp.

Output ONLY a CSV with this exact header and no commentary:
lane,claim_type,value,player_surname,club,tier,source,quote,url,claimed_at,metric,horizon_gameweeks

Rules you must not break:
1. `quote` must be word-for-word from the post. If you are summarising, leave \
quote empty, give the url, and set tier to 3. Never reconstruct a quote.
2. tier is 2 ONLY for a direct quote from a manager, club or press-conference \
reporter. Everything else is 3. If in doubt, 3.
3. Projections, ratings and expected-minutes calls go in lane=comparator, \
never lane=availability - including robtFPL's. Set metric to projected_points, \
expected_minutes, rating or rank, and leave tier, claim_type and quote empty.
4. claimed_at is the timestamp OF THE POST in ISO-8601 UTC. Never invent one. \
If you cannot determine it, skip the item.
5. If you cannot tell who a post is about, use claim_type=unparsed_news and put \
the text in value.
6. chance_of_playing is a bare integer like 25, not 25%. return_date and \
unavailable_until are YYYY-MM-DD. permanent_exit is one word: transfer, loan or \
free_agent. expected_minutes is 0-90.
7. player_surname as FPL spells it (Rogers, not Morgan Rogers); club in full \
(Aston Villa, not Villa).
8. One row per claim. Two doubtful players in one post is two rows.
9. Wrap a field in double quotes if it contains a comma.
10. Prefer a structured claim_type over free text where either fits.

Do not include transfer rumours with no source, captaincy opinions, or anything \
you inferred rather than read. If you find nothing, output the header row alone \
- an empty result is correct and more useful than a guess."""


def build_request(
    config: Mapping[str, Any], gameweek: int, deadline: Optional[str],
) -> Dict[str, Any]:
    """The API payload. Separated so a test can read it without a network call."""
    window = int(config.get("window_hours", 3))
    deadline_text = f", whose deadline is {deadline}" if deadline else ""
    return {
        "model": str(config.get("model", "grok-4-latest")),
        "temperature": float(config.get("temperature", 0.0)),
        "max_tokens": int(config.get("max_tokens", 4000)),
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Collect Fantasy Premier League team news for Gameweek "
                    f"{gameweek}{deadline_text}. Search X and the open web for "
                    f"posts from the last {window} hours.\n\n"
                    f"Priority order: (1) injury and availability news, "
                    f"especially press-conference quotes; (2) @robtFPL's "
                    f"projections and expected-minutes calls; (3) other "
                    f"high-signal FPL accounts; (4) confirmed transfers and "
                    f"loans that remove a player from the league."
                ),
            },
        ],
    }


def _upstream_error(response: Any) -> str:
    """
    The provider's own sentence, when there is one.

    Falls back to the truncated body: a JSON error shape is not guaranteed, and
    an error message that says "could not read the error" is worthless.
    """
    try:
        body = response.json()
    except Exception:
        return (response.text or "")[:200] or "no body"
    if isinstance(body, Mapping):
        detail = body.get("error") or body.get("message") or body.get("detail")
        if isinstance(detail, Mapping):
            detail = detail.get("message")
        if detail:
            return str(detail)[:300]
    return str(body)[:200]


def ask(
    api_key: str,
    config: Mapping[str, Any],
    gameweek: int,
    deadline: Optional[str] = None,
) -> Any:
    """
    Call the xAI API and parse the reply as a feed payload.

    The reply is CSV, which goes through the same `parse_sheet` and the same
    validator as a published spreadsheet. That is deliberate: an API answer is
    no more trustworthy than a hand-maintained sheet, and giving it a shorter
    path would mean the route with the least human review had the fewest checks.
    """
    import requests

    response = requests.post(
        str(config.get("api_url", "https://api.x.ai/v1/chat/completions")),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=build_request(config, gameweek, deadline),
        timeout=int(config.get("timeout_seconds", 20)),
    )
    if response.status_code == 401:
        raise ValueError("xAI rejected the key (401); it may be wrong or revoked")
    if response.status_code == 429:
        raise ValueError("xAI rate-limited or out of credit (429)")
    if response.status_code == 403:
        # Measured against a real key: a valid `xai-…` key on a team with no
        # credits returns 403 `permission-denied` with the console URL in the
        # body. Bare `403 Client Error` sent someone looking for a code bug for
        # an hour; the upstream sentence names the actual fix, so relay it.
        raise ValueError(
            "xAI refused the key (403). This is usually billing, not the key: "
            "an xAI API key does not inherit X Premium, and a new team starts "
            f"with no credits. Upstream said: {_upstream_error(response)}"
        )
    response.raise_for_status()

    payload = response.json()
    choices = payload.get("choices") or []
    if not choices:
        raise ValueError("xAI returned no choices")
    text = ((choices[0].get("message") or {}).get("content") or "").strip()
    if not text:
        raise ValueError("xAI returned an empty reply")

    # Models wrap CSV in a fence often enough to be worth handling rather than
    # failing on: the alternative is a run lost to three backticks.
    if text.startswith("```"):
        lines = [line for line in text.splitlines() if not line.startswith("```")]
        text = "\n".join(lines).strip()

    return parse_sheet(text)


def poll(
    url: Optional[str],
    config: Mapping[str, Any],
    now: datetime,
    api_key: Optional[str] = None,
    gameweek: int = 1,
    deadline: Optional[str] = None,
) -> Tuple[Validated, Optional[str]]:
    """
    Fetch and validate, or explain why nothing happened.

    Returns ``(validated, skipped_reason)``. A skip is not an error: with no
    URL configured — the state today — every other news source is unaffected,
    which is the same contract the YouTube connector has.
    """
    # A key means we ask directly; a URL means we read what you maintain. The
    # key wins when both are set, because it is the fresher of the two.
    try:
        if api_key:
            payload = ask(api_key, config, gameweek, deadline)
        elif url:
            payload = fetch(url, config)
        else:
            return Validated(), (
                "Neither GROK_API_KEY nor GROK_FEED_URL is configured, so no "
                "X-sourced claims were read. Every other news source is "
                "unaffected."
            )
    except Exception as error:  # noqa: BLE001 - one feed must not sink the poll
        logger.warning("grok feed unreadable: %s", error)
        return Validated(), f"the feed could not be read: {error}"

    result = validate(payload, now)
    for rejection in result.rejections:
        # Logged individually with an index, so a 60-item file can be corrected
        # without guesswork. A silently dropped claim is indistinguishable from
        # a poller that has stopped.
        logger.warning("grok feed rejected %s", rejection)
    return result, None
