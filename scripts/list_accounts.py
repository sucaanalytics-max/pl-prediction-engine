"""
Print the configured scan accounts as TSV: handle, source, club.

A separate file rather than a heredoc inside the workflow YAML. The heredoc had to
survive YAML block scalars, shell quoting and Python string literals at once, and
the first version silently produced nothing — the same class of bug as the `"\\n".join`
inside a quoted heredoc that once yielded a one-line CSV with zero rows.

Used by scripts/x_scan.sh and .github/workflows/x_scan.yml so both read the same
source of truth, `X_SCAN_ACCOUNTS` in pipeline/config.py.
"""

from __future__ import annotations

from pipeline.config import X_SCAN_ACCOUNTS


def main() -> int:
    for account in X_SCAN_ACCOUNTS:
        handle = str(account.get("handle") or "").strip()
        if not handle:
            continue
        source = str(account.get("source") or f"x:{handle}")
        club = str(account.get("club") or "")
        print(f"{handle}\t{source}\t{club}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
