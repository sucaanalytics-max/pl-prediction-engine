"""
The versioned parameter store: an append-only record of what changed and why.

Every value the models use is either a registry default or something this file
promoted, and each promotion carries the gate results that admitted it. That is
what makes a refit reviewable rather than merely automatic — a change nobody can
reconstruct the reason for is indistinguishable from a bug.

**Rollback is a forward commit.** Reverting v11 means appending v12 that copies
v10's values with ``reason: rollback of v11``, never deleting or rewriting v11.
An append-only history that can be edited is not an audit trail, and a `git
revert` here would remove the evidence of the very mistake being corrected. The
wrong version stays in the record with its gates and its outcome.

**Defaults are not versions.** Until something is promoted the models run on
``PARAM_REGISTRY`` values, and ``active()`` says so via ``version: 0``. A store
that invented a version 1 identical to the defaults would make "never refit"
indistinguishable from "refit to the same numbers".
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from pipeline.config import PARAM_REGISTRY

logger = logging.getLogger(__name__)

PARAMS_FILENAME = "params.jsonl"


class PromotionError(RuntimeError):
    """A promotion was refused. The store is never written in this case."""


@dataclass
class Version:
    """One entry in the history."""

    version: int
    generated_at: str
    values: Dict[str, float]
    changed: Dict[str, Any] = field(default_factory=dict)
    reason: str = ""
    gates: List[Dict[str, Any]] = field(default_factory=list)
    rollback_of: Optional[int] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "generated_at": self.generated_at,
            "values": self.values,
            "changed": self.changed,
            "reason": self.reason,
            "gates": self.gates,
            "rollback_of": self.rollback_of,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "Version":
        return cls(
            version=int(payload["version"]),
            generated_at=str(payload.get("generated_at", "")),
            values={str(k): float(v) for k, v in payload.get("values", {}).items()},
            changed=dict(payload.get("changed", {})),
            reason=str(payload.get("reason", "")),
            gates=list(payload.get("gates", [])),
            rollback_of=payload.get("rollback_of"),
        )


def defaults() -> Dict[str, float]:
    """Registry values — what the models run on before anything is promoted."""
    return {name: float(entry["value"]) for name, entry in PARAM_REGISTRY.items()}


def history(predictions_dir: Path) -> List[Version]:
    """Every version ever written, oldest first."""
    path = Path(predictions_dir) / "fpl" / PARAMS_FILENAME
    if not path.exists():
        return []
    versions: List[Version] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            versions.append(Version.from_dict(json.loads(line)))
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            # A corrupt line is not skippable. Silently ignoring it would let
            # the active parameter set silently revert to an older version.
            raise PromotionError(f"corrupt parameter history in {path}: {exc}") from exc
    return sorted(versions, key=lambda v: v.version)


def active(predictions_dir: Path) -> Version:
    """
    The parameter set currently in force.

    Version 0 with registry defaults when nothing has been promoted — a real
    state, distinct from "promoted values that happen to equal the defaults".
    """
    versions = history(predictions_dir)
    if not versions:
        return Version(
            version=0, generated_at="", values=defaults(),
            reason="registry defaults; nothing promoted yet",
        )
    return versions[-1]


def promote(
    predictions_dir: Path,
    changes: Mapping[str, float],
    gates: Sequence[Mapping[str, Any]],
    reason: str,
    generated_at: str,
    dry_run: bool = False,
) -> Version:
    """
    Append a new version carrying ``changes`` on top of the active one.

    ``gates`` is the full gate report, INCLUDING passing gates, because a
    promotion record showing only what was checked and not what was tested is
    unauditable. Refuses if any gate failed: the store is the last line of
    defence and it does not take a caller's word for it.
    """
    if not changes:
        raise PromotionError("a promotion must change at least one parameter")

    failed = [g for g in gates if not g.get("passed", False)]
    if failed:
        raise PromotionError(
            "refusing to promote with failed gates: "
            + "; ".join(str(g.get("reason") or g.get("gate")) for g in failed)
        )

    unknown = set(changes) - set(PARAM_REGISTRY)
    if unknown:
        raise PromotionError(f"unregistered parameters: {sorted(unknown)}")

    current = active(predictions_dir)
    values = dict(current.values)
    changed: Dict[str, Any] = {}
    for name, value in changes.items():
        changed[name] = {"from": values.get(name), "to": float(value)}
        values[name] = float(value)

    version = Version(
        version=current.version + 1,
        generated_at=generated_at,
        values=values,
        changed=changed,
        reason=reason,
        gates=[dict(g) for g in gates],
    )
    if not dry_run:
        _append(predictions_dir, version)
    logger.info(
        "%s v%d: %s", "would promote" if dry_run else "promoted",
        version.version, ", ".join(f"{k} {v['from']} -> {v['to']}" for k, v in changed.items()),
    )
    return version


def rollback(
    predictions_dir: Path,
    target_version: int,
    reason: str,
    generated_at: str,
    dry_run: bool = False,
) -> Version:
    """
    Undo by moving FORWARD: append a version copying ``target_version``'s values.

    Never rewrites or deletes. The version being undone stays in the record with
    its gates and its outcome, which is the whole value of an append-only
    history — a `git revert` here would erase the evidence of the mistake being
    corrected.
    """
    versions = history(predictions_dir)
    if not versions:
        raise PromotionError("nothing to roll back to")

    target = next((v for v in versions if v.version == target_version), None)
    if target is None:
        raise PromotionError(
            f"version {target_version} is not in the history "
            f"(have {[v.version for v in versions]})"
        )

    current = versions[-1]
    if current.version == target_version:
        raise PromotionError(f"v{target_version} is already active")

    version = Version(
        version=current.version + 1,
        generated_at=generated_at,
        values=dict(target.values),
        changed={
            name: {"from": current.values.get(name), "to": value}
            for name, value in target.values.items()
            if current.values.get(name) != value
        },
        reason=reason or f"rollback of v{current.version} to v{target_version}",
        rollback_of=current.version,
    )
    if not dry_run:
        _append(predictions_dir, version)
    logger.warning(
        "rolled back to v%d as forward version v%d", target_version, version.version
    )
    return version


def resolve(predictions_dir: Path) -> Dict[str, float]:
    """
    Values the models should use, with any registry additions filled in.

    A parameter added to the registry after the last promotion has no entry in
    that version. Falling back to its default is right; raising would make every
    new parameter a breaking change, and omitting it would make the caller
    KeyError somewhere far away.
    """
    values = defaults()
    values.update(active(predictions_dir).values)
    return values


def _append(predictions_dir: Path, version: Version) -> Path:
    directory = Path(predictions_dir) / "fpl"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / PARAMS_FILENAME
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(version.as_dict(), allow_nan=False) + "\n")
    return path
