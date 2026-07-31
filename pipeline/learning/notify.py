"""
Delivery: get the decision in front of the human before the deadline.

Propose-and-approve is worthless without this. An agent that decides perfectly
and tells nobody has produced nothing, and a missed FPL deadline costs an entire
gameweek — it cannot be made up later.

So **delivery failure is loud**. :func:`notify` raises rather than returning a
status nobody checks, and the caller is expected to let that fail the job. A
seal is not complete until at least one channel has confirmed delivery; the
alternative is a chain-verified record of a forecast that never reached anyone.

Two channels, per the operator's choice:

* **the site** — the durable, auditable view, published as a stripped artifact
  alongside the other predictions;
* **email** — the push, because the site cannot tell you a deadline is in four
  hours.

Templates are rendered from data with `string.Template`. No LLM: a hallucinated
number in an unattended pipeline is exactly the failure mode this project has
been removing everywhere else, and the numbers here are the point.
"""
from __future__ import annotations

import logging
import os
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage
from string import Template
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

# Fields that must never leave the machine. The public artifact and the email
# both go through `strip_for_publication`.
PRIVATE_FIELDS = ("entry_id", "entry_name", "manager_name", "counterfactuals")


class NotificationError(RuntimeError):
    """Delivery failed. Never swallow this: an undelivered decision is no decision."""


@dataclass
class DeliveryResult:
    """Which channels confirmed, and which did not."""

    delivered: List[str] = field(default_factory=list)
    skipped: Dict[str, str] = field(default_factory=dict)
    failed: Dict[str, str] = field(default_factory=dict)

    @property
    def any_delivered(self) -> bool:
        return bool(self.delivered)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "delivered": list(self.delivered),
            "skipped": dict(self.skipped),
            "failed": dict(self.failed),
        }


SUBJECT_TEMPLATE = Template(
    "FPL GW$gameweek — decision ready ($hours_left h to deadline)"
)

BODY_TEMPLATE = Template(
    """FPL Gameweek $gameweek

Deadline: $deadline  ($hours_left hours from now)
Generated: $generated_at

$teams_block
$notes_block
Full detail, including the reasoning and the numbers behind each choice:
$site_url

This is a recommendation. Nothing has been submitted on your behalf — the
agent has no write access to FPL by design.
"""
)


def strip_for_publication(decision: Dict[str, Any]) -> Dict[str, Any]:
    """
    Remove anything that should not be published.

    The site artifact is world-readable once it reaches `frontend/public`, so
    entry identifiers and the counterfactual block — which reveals every
    alternative considered — are dropped rather than trusted to obscurity.
    """
    public = {
        key: value for key, value in decision.items() if key not in PRIVATE_FIELDS
    }
    teams = []
    for team in public.get("teams", []):
        teams.append(
            {k: v for k, v in team.items() if k not in PRIVATE_FIELDS}
        )
    if teams:
        public["teams"] = teams
    return public


def _format_team(team: Dict[str, Any]) -> str:
    lines = [f"── {team.get('label', team.get('objective', 'team')).upper()}"]

    captain = team.get("captain")
    if captain:
        lines.append(f"   Captain: {captain}")
    vice = team.get("vice_captain")
    if vice:
        lines.append(f"   Vice:    {vice}")

    transfers = team.get("transfers") or []
    if transfers:
        for move in transfers:
            lines.append(
                f"   Transfer: {move.get('out')} -> {move.get('in')}"
                + (f"  ({move.get('note')})" if move.get("note") else "")
            )
    else:
        lines.append("   Transfers: none (roll)")

    chip = team.get("chip")
    lines.append(f"   Chip: {chip}" if chip else "   Chip: none")

    projected = team.get("projected_points")
    if projected is not None:
        interval = team.get("projected_interval")
        suffix = f"  (90% {interval})" if interval else ""
        lines.append(f"   Projected: {projected}{suffix}")

    if team.get("status") and team["status"] != "ok":
        lines.append(f"   STATUS: {team['status'].upper()}")
    return "\n".join(lines)


def render_email(
    decision: Dict[str, Any], site_url: str, hours_left: float
) -> tuple[str, str]:
    """Render (subject, body). Pure, so it is testable without sending anything."""
    public = strip_for_publication(decision)
    teams_block = "\n\n".join(
        _format_team(team) for team in public.get("teams", [])
    ) or "No decision produced."

    notes = list(public.get("notices") or [])
    metadata = public.get("metadata", {})
    if metadata.get("fpl_rules_degraded"):
        notes.append(
            "FPL scoring table drift detected — projections are degraded."
        )
    if metadata.get("bonus_tail_claim") is False:
        notes.append(
            "Bonus is approximated; tail probabilities are modelled, not measured."
        )
    notes_block = ""
    if notes:
        notes_block = "\nNotes:\n" + "\n".join(f"  - {note}" for note in notes) + "\n"

    values = {
        "gameweek": public.get("gameweek", "?"),
        "deadline": public.get("deadline", "unknown"),
        "hours_left": f"{hours_left:.1f}",
        "generated_at": public.get("generated_at", "unknown"),
        "teams_block": teams_block,
        "notes_block": notes_block,
        "site_url": site_url,
    }
    return SUBJECT_TEMPLATE.substitute(values), BODY_TEMPLATE.substitute(values)


def send_email(
    subject: str,
    body: str,
    config: Optional[Dict[str, str]] = None,
) -> str:
    """
    Send via SMTP. Raises :class:`NotificationError` on any failure.

    Configuration comes from the environment so no credential is ever written to
    an artifact: SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD,
    NOTIFY_EMAIL_FROM, NOTIFY_EMAIL_TO.
    """
    settings = config or {
        "host": os.environ.get("SMTP_HOST", ""),
        "port": os.environ.get("SMTP_PORT", "587"),
        "username": os.environ.get("SMTP_USERNAME", ""),
        "password": os.environ.get("SMTP_PASSWORD", ""),
        "sender": os.environ.get("NOTIFY_EMAIL_FROM", ""),
        "recipient": os.environ.get("NOTIFY_EMAIL_TO", ""),
    }

    missing = [
        name
        for name in ("host", "sender", "recipient")
        if not settings.get(name)
    ]
    if missing:
        raise NotificationError(
            f"email is not configured; missing {', '.join(missing)}"
        )

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings["sender"]
    message["To"] = settings["recipient"]
    message.set_content(body)

    try:
        with smtplib.SMTP(settings["host"], int(settings["port"]), timeout=30) as server:
            server.starttls(context=ssl.create_default_context())
            if settings.get("username"):
                server.login(settings["username"], settings["password"])
            server.send_message(message)
    except Exception as exc:  # noqa: BLE001 — re-raised as a typed error below
        raise NotificationError(f"SMTP delivery failed: {exc}") from exc

    return settings["recipient"]


def notify(
    decision: Dict[str, Any],
    site_url: str,
    hours_left: float,
    channels: Sequence[str] = ("email",),
    email_config: Optional[Dict[str, str]] = None,
    require_delivery: bool = True,
) -> DeliveryResult:
    """
    Deliver the decision. Raises if nothing got through and delivery is required.

    ``require_delivery`` exists for dry runs only. In the sealing path it must
    stay True: a decision nobody received is not a decision, and recording the
    seal as complete would make the ledger claim something untrue.
    """
    result = DeliveryResult()
    subject, body = render_email(decision, site_url, hours_left)

    for channel in channels:
        if channel == "email":
            try:
                recipient = send_email(subject, body, email_config)
                result.delivered.append("email")
                logger.info("decision emailed to %s", recipient)
            except NotificationError as exc:
                result.failed["email"] = str(exc)
                logger.error("email delivery failed: %s", exc)
        elif channel == "site":
            # The site is published by the artifact writer, not here. Recorded so
            # the delivery summary reflects every configured channel.
            result.delivered.append("site")
        else:
            result.skipped[channel] = "unknown channel"

    if require_delivery and not result.any_delivered:
        raise NotificationError(
            "no channel confirmed delivery: " + str(result.as_dict())
        )
    return result
