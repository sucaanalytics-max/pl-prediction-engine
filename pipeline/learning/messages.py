"""
The agent's outbox: everything it has to say, published to the app.

There is no email. The site is the only channel, which makes one thing
load-bearing: a message that fails to publish has not been delivered, and the
run must say so rather than completing green. With email there was a second
chance; without it there is not.

**Why a feed rather than just the decision artifact.** The decision says what to
do. It does not say "the field model is still uncalibrated so this is the EV
fallback", or "GW8 was never sealed and is permanently unmeasurable", or "a
parameter was promoted on Tuesday". Those are the things a human needs in order
to trust or distrust the recommendation, and burying them inside a decision blob
means they are read only by someone already looking at that gameweek. A feed is
read in order, and a critical message from three weeks ago is still visible.

Messages are append-only and content-addressed by ``id``, so re-running a phase
republishes rather than duplicating. That matters because the scheduler is
deliberately state-derived and will re-enter a phase after a missed cron.

Severity drives nothing here except presentation. The agent does not decide how
alarming its own news is — ``critical`` means an observation was permanently
lost or a decision could not be made, and nothing else earns it.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

FEED_FILENAME = "messages.json"

# Kept small on purpose. Every extra kind is one more branch the page has to
# render and one more thing that can be silently mis-tagged.
KINDS = ("decision", "status", "warning", "result")
SEVERITIES = ("info", "warning", "critical")

# Fields that must never reach the published feed. The app is world-readable.
PRIVATE_FIELDS = ("entry_id", "manager_name", "counterfactuals", "runners_up",
                  "selection_stream")


class PublicationError(RuntimeError):
    """A message could not be published. With no email, this is a real failure."""


@dataclass
class Message:
    """One thing the agent needs to tell the human."""

    id: str
    gameweek: int
    kind: str
    severity: str
    title: str
    body: str
    created_at: str
    detail: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"unknown message kind {self.kind!r}; expected {KINDS}")
        if self.severity not in SEVERITIES:
            raise ValueError(
                f"unknown severity {self.severity!r}; expected {SEVERITIES}"
            )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "gameweek": self.gameweek,
            "kind": self.kind,
            "severity": self.severity,
            "title": self.title,
            "body": self.body,
            "created_at": self.created_at,
            "detail": strip_private(self.detail),
        }


def strip_private(payload: Any) -> Any:
    """
    Recursively drop anything that should not be world-readable.

    The feed is published to the app, so entry identifiers and the
    counterfactual block — which reveals every alternative the optimiser
    considered — are removed rather than trusted to obscurity.
    """
    if isinstance(payload, Mapping):
        return {
            key: strip_private(value)
            for key, value in payload.items()
            if key not in PRIVATE_FIELDS
        }
    if isinstance(payload, (list, tuple)):
        return [strip_private(item) for item in payload]
    return payload


def decision_messages(
    decision: Mapping[str, Any], hours_left: Optional[float], created_at: str
) -> List[Message]:
    """
    Turn one entry's decision into the messages a human actually needs.

    The decision itself, plus one message per warning. Warnings are separated
    rather than listed inside the decision because they are the part most likely
    to change what someone does, and a caveat inside a blob of numbers is a
    caveat nobody reads.
    """
    gameweek = int(decision.get("gameweek", 0))
    label = str(decision.get("entry_label", "team"))
    plan = (decision.get("decision") or {}).get("plan") or {}

    deadline_note = (
        f" Deadline in {hours_left:.1f} hours." if hours_left is not None else ""
    )
    messages = [
        Message(
            id=f"gw{gameweek:02d}-decision-{label}",
            gameweek=gameweek,
            kind="decision",
            severity="info",
            title=f"GW{gameweek} — {label} team ready",
            body=(
                f"{len(plan.get('transfers_in') or [])} transfer(s), "
                f"{plan.get('hits', 0)} hit(s) taken."
                f"{deadline_note} Nothing has been submitted for you — the agent "
                f"has no write access to FPL by design."
            ),
            created_at=created_at,
            detail=dict(decision),
        )
    ]

    for index, warning in enumerate(decision.get("warnings") or []):
        text = str(warning)
        messages.append(
            Message(
                id=f"gw{gameweek:02d}-warning-{label}-{index}",
                gameweek=gameweek,
                kind="warning",
                # A warning the agent raised about its own output is worth
                # surfacing at warning level; nothing here is ever critical,
                # because a decision WAS produced.
                severity="warning",
                title=f"GW{gameweek} — caveat on the {label} team",
                body=text,
                created_at=created_at,
            )
        )
    return messages


def status_message(
    gameweek: int,
    title: str,
    body: str,
    created_at: str,
    severity: str = "info",
    kind: str = "status",
    detail: Optional[Mapping[str, Any]] = None,
    suffix: str = "",
) -> Message:
    """A phase outcome: sealed, settled, scored, or a phase that could not run."""
    return Message(
        id=f"gw{gameweek:02d}-{kind}{('-' + suffix) if suffix else ''}",
        gameweek=int(gameweek),
        kind=kind,
        severity=severity,
        title=title,
        body=body,
        created_at=created_at,
        detail=dict(detail or {}),
    )


def load_feed(predictions_dir: Path) -> List[Dict[str, Any]]:
    """Every message published so far, newest first."""
    path = Path(predictions_dir) / "fpl" / FEED_FILENAME
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        raise PublicationError(f"message feed is unreadable: {path} ({exc})") from exc
    if not isinstance(payload, Mapping):
        # A file containing `[]` or `null` parses fine and then fails on .get,
        # raising AttributeError past every handler — re-wedging publish through
        # a different door than the truncation case. Typed as PublicationError so
        # the recovery path catches it.
        raise PublicationError(
            f"message feed is not an object: {path} holds {type(payload).__name__}"
        )
    return list(payload.get("messages", []))


def publish(
    messages: Sequence[Message],
    predictions_dir: Path,
    public_dir: Optional[Path] = None,
    dry_run: bool = False,
) -> Dict[str, Path]:
    """
    Merge messages into the feed and write it, then verify it landed.

    Verification is not ceremony. The site is the ONLY channel now, so a write
    that silently failed would mean the agent decided and told nobody — the
    exact failure the email path used to cover for.

    Re-publishing an existing id REPLACES it rather than appending. The
    scheduler is state-derived and re-enters phases after a missed cron, so
    without this a caught-up run would fill the feed with duplicates.
    """
    if not messages:
        raise PublicationError("refusing to publish an empty message set")

    # A corrupt feed must not stop the agent from speaking.
    #
    # load_feed raises on unreadable input, which is right for a READER — better
    # to fail loudly than render a truncated history as though it were complete.
    # But a WRITER that refuses to write because the previous write was bad is a
    # deadlock, and with email gone there is no second channel to fall back on:
    # one truncated file would silence the agent permanently. Measured — a single
    # bad write wedged every subsequent publish until a human deleted the file.
    #
    # So the corrupt feed is QUARANTINED rather than deleted (it may be partly
    # recoverable, and silently discarding history is its own failure), a fresh
    # feed is started, and the loss is announced at critical severity so nobody
    # mistakes a short feed for a quiet agent.
    messages = list(messages)
    try:
        prior = load_feed(predictions_dir)
    except PublicationError as exc:
        quarantined = _quarantine(predictions_dir)
        prior = []
        logger.error("message feed was corrupt (%s); quarantined to %s", exc, quarantined)
        messages.append(
            Message(
                id="feed-recovered",
                gameweek=messages[0].gameweek,
                kind="status",
                severity="critical",
                title="Message history was lost",
                body=(
                    "The message feed was unreadable and has been set aside so the "
                    "agent could keep publishing. Messages before this point are no "
                    "longer shown here. The damaged file was kept, not deleted: "
                    f"{quarantined}"
                ),
                created_at=messages[0].created_at,
            )
        )

    existing = {m.get("id"): m for m in prior}
    for message in messages:
        existing[message.id] = message.as_dict()

    ordered = sorted(
        existing.values(),
        key=lambda m: (int(m.get("gameweek", 0)), str(m.get("created_at", ""))),
        reverse=True,
    )
    payload = {
        "generated_at": messages[0].created_at,
        "n_messages": len(ordered),
        "messages": ordered,
    }

    if dry_run:
        logger.info("dry run: would publish %d message(s)", len(messages))
        return {}

    # The two directories follow DIFFERENT conventions, and conflating them put
    # the public feed one level too deep — at predictions/fpl/fpl/messages.json,
    # while the page fetches /predictions/fpl/messages.json. The inbox was dark
    # 100% of the time and _verify could not see it, because it re-read the same
    # wrong path publish had just written.
    #
    # predictions_dir is the repo's predictions/ root, so "fpl" is appended.
    # public_dir is passed already pointing at frontend/public/predictions/fpl,
    # which is the same asymmetry write_decision uses.
    written: Dict[str, Path] = {}
    targets = [("private", Path(predictions_dir) / "fpl")]
    if public_dir is not None:
        targets.append(("public", Path(public_dir)))

    for key, target in targets:
        target.mkdir(parents=True, exist_ok=True)
        path = target / FEED_FILENAME
        path.write_text(json.dumps(payload, indent=2, allow_nan=False))
        written[key] = path

    _verify(written.values())
    logger.info(
        "published %d new message(s); feed now holds %d", len(messages), len(ordered)
    )
    return written


def _quarantine(predictions_dir: Path) -> Path:
    """
    Move a corrupt feed aside, keeping it.

    Deleting would be simpler and is wrong: the file may be partly recoverable,
    and a system that silently discards its own history when that history
    becomes inconvenient is not auditable. The suffix is derived from the file's
    own mtime rather than the wall clock, so re-running the same recovery does
    not scatter a new copy each time.
    """
    path = Path(predictions_dir) / "fpl" / FEED_FILENAME
    if not path.exists():
        return path.with_name(f"{FEED_FILENAME}.corrupt.0")

    stamp = int(path.stat().st_mtime)
    target = path.with_name(f"{FEED_FILENAME}.corrupt.{stamp}")
    # Two corruptions inside the same second would otherwise collide, and
    # Path.replace overwrites — so the second rescue would destroy the first.
    # Found by testing recovery twice in a row.
    counter = 1
    while target.exists():
        target = path.with_name(f"{FEED_FILENAME}.corrupt.{stamp}-{counter}")
        counter += 1
    path.replace(target)
    return target


def _verify(paths: Iterable[Path]) -> None:
    """
    Confirm each written feed exists and parses.

    Existence alone is not enough: a truncated file is present on disk and
    unreadable by the page, which to someone trying to act before a deadline is
    the same as no message at all.
    """
    checked = 0
    for path in paths:
        if not Path(path).exists():
            raise PublicationError(f"message feed was not written: {path}")
        try:
            json.loads(Path(path).read_text())
        except (json.JSONDecodeError, OSError) as exc:
            raise PublicationError(f"message feed is corrupt: {path} ({exc})") from exc
        checked += 1
    if not checked:
        raise PublicationError("no message feed was written anywhere")
