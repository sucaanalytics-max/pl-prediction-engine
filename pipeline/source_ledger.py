"""
Which external sources delivered on this run, and which quietly did not.

## The failure this exists for

`player_events.json` stopped refreshing on 24 August and nobody noticed until 8
September. Every morning the workflow reported success, because the Understat step
catches its own failure by design and the run carries on — which is correct
behaviour for a scraped source with no warranty, and is also how a source can be
dead for a fortnight while a green tick says otherwise.

The warning was there the whole time. It was one line inside a 5,889-line log that
nobody reads when the run is green. Logging harder would not have helped; the
problem was that nothing SUMMARISED, and nothing reached the surface a human
actually looks at.

## Warn only about what is unexpected

The hard-won rule from the same investigation: a source that is absent BY DESIGN
must never warn. FBref's passing table has no supported provider — the package
that offered it capped `rich<14` and pinned soccerdata to a version that could not
read Understat, so it was removed. If that absence produced a warning every run,
the warnings would be noise inside a month and the next real one would be ignored
for another fortnight. Expected absences are counted and named in the notice;
only unexpected ones are warned about.

Modelled on `pipeline/learning/run_news.py`, which solved the same problem for the
news poller: a pure, tested `annotations_for` rather than shell in the workflow.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Mapping, Optional, Sequence


@dataclass(frozen=True)
class SourceOutcome:
    """One external source's verdict for one run."""

    #: Stable machine name, safe to grep for across runs.
    name: str
    #: What a human calls it.
    label: str
    delivered: bool
    #: What happened, in the reader's terms. Empty when it simply worked.
    detail: str = ""
    #: True when NOT delivering is the intended state. Never warns.
    by_design: bool = False
    #: The artifact that goes stale when this source is silent, if any.
    publishes: Optional[str] = None


class SourceLedger:
    """
    Collects source outcomes during a run and reports them at the end.

    Deliberately dumb: no I/O, no logging, no knowledge of GitHub. A run records
    into it and hands the report to whatever wants to render it, which is what
    makes both halves testable without a pipeline.
    """

    def __init__(self) -> None:
        self._outcomes: List[SourceOutcome] = []

    def delivered(self, name: str, label: str, detail: str = "",
                  publishes: Optional[str] = None) -> None:
        self._outcomes.append(SourceOutcome(
            name=name, label=label, delivered=True, detail=detail, publishes=publishes,
        ))

    def failed(self, name: str, label: str, detail: str,
               publishes: Optional[str] = None) -> None:
        """A source that was expected to deliver and did not. This warns."""
        self._outcomes.append(SourceOutcome(
            name=name, label=label, delivered=False, detail=str(detail)[:200],
            publishes=publishes,
        ))

    def absent_by_design(self, name: str, label: str, detail: str) -> None:
        """A source deliberately not collected. Counted, never warned about."""
        self._outcomes.append(SourceOutcome(
            name=name, label=label, delivered=False, detail=str(detail)[:200],
            by_design=True,
        ))

    @property
    def outcomes(self) -> Sequence[SourceOutcome]:
        return tuple(self._outcomes)

    def report(self) -> Dict[str, Any]:
        return {"sources": [asdict(o) for o in self._outcomes]}

    def table(self) -> str:
        """A fixed-width block for the run log, so the tail of a run summarises."""
        if not self._outcomes:
            return "  (no external sources recorded)"
        width = max(len(o.label) for o in self._outcomes)
        lines = []
        for outcome in self._outcomes:
            mark = "ok  " if outcome.delivered else ("--  " if outcome.by_design else "DEAD")
            tail = f"  {outcome.detail}" if outcome.detail else ""
            lines.append(f"  {mark} {outcome.label.ljust(width)}{tail}")
        return "\n".join(lines)


def annotations_for(report: Mapping[str, Any]) -> List[str]:
    """
    GitHub Actions annotations for one run's sources.

    One warning per source that was expected to deliver and did not, naming the
    artifact that goes stale as a result — because "Understat player events failed"
    means nothing to someone who does not know what reads it, and
    "player_events.json will not refresh" means everything.

    Absences by design are named in the notice and never warned about; see the
    module docstring for why that distinction is the whole point.
    """
    sources = list(report.get("sources") or [])
    if not sources:
        return []

    lines: List[str] = []
    dead = [s for s in sources if not s.get("delivered") and not s.get("by_design")]
    expected = [s for s in sources if not s.get("delivered") and s.get("by_design")]
    live = [s for s in sources if s.get("delivered")]

    for source in dead:
        publishes = source.get("publishes")
        consequence = (
            f"; {publishes} will not refresh" if publishes
            else "; the run continued without it"
        )
        lines.append(
            f"::warning::source {source.get('label') or source.get('name')} "
            f"delivered nothing: {source.get('detail') or 'no reason given'}"
            f"{consequence}"
        )

    summary = f"{len(live)} of {len(live) + len(dead)} external sources delivered"
    if expected:
        names = ", ".join(str(s.get("label") or s.get("name")) for s in expected)
        summary += f" (not collected by design: {names})"
    lines.append(f"::notice::{summary}")
    return lines
