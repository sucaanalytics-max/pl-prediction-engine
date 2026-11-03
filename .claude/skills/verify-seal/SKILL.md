---
name: verify-seal
description: Use to check that a sealed forecast is real, complete, and carries its provenance — after a seal rehearsal, after a genuine seal lands, or when auditing whether a gameweek is properly recorded. Reads a forecast.jsonl header and reports what is missing.
---

# Verifying a sealed forecast

A seal is irrecoverable and there are 38 in a season, so "the job went green" is not enough. Check the artifact.

## Read the header

```bash
cd /Users/tusk-jvb/dev/pl-prediction-engine
git show origin/main:predictions/fpl/ledger/gw01/forecast.jsonl | head -1 | python3 -m json.tool
```

For a local or rehearsed file, replace with the path directly.

## What must be true

| Field | Expected | Why it matters |
|---|---|---|
| `dry_run` | `false` for a real seal | A quarantined rehearsal must never be mistaken for the record |
| `sealed_at` | before `deadline_time` | `seconds_before_deadline` should be positive; `TooLateToSealError` exists to prevent otherwise |
| `rows_written` | equals `universe_size` | A short write means the projection and the universe disagreed |
| `universe_criteria` | present | The seal must say who it considered, not just who it kept |
| `goal_rates`, `horizon`, `availability_evidence`, `artifact_metadata` | all four present | Flattened into the header by `header.update(metadata)`, NOT nested under a `metadata` key — look at the top level |
| `h0_start_gate` | present and non-null on seals made after the gate landed; `active` true from the gameweek where `settled_gameweeks` reaches `min_settled`; `kappa_effective` 1.0 (a no-op) until the owner switches kappa on with fix A | Says whether outfield h=0 starts reverted (`minutes.h0_start_target_keep`). The parameter value alone cannot say it, and the pre-registered confirm-or-rollback rule (`docs/superpowers/specs/2026-11-03-h0-start-gate-preregistration.md`) scores only seals whose record says `active` with `kappa_effective` below 1. Null means the record failed and that seal drops out of the rule |

Those four provenance fields are the only route by which the parameters that priced weeks 2-8 stay measurable against outcomes. A seal missing them is a seal that cannot be scored later.

## Count rows correctly

The first line is the header, not a forecast. Count the record type:

```bash
git show origin/main:predictions/fpl/ledger/gw01/forecast.jsonl \
  | python3 -c "import json,sys; print(sum(1 for l in sys.stdin if json.loads(l).get('record')=='forecast'))"
```

Counting lines reports one too many, which reads as a discrepancy against the header's own `rows_written`.

## Sanity-check the universe

Fewer rows than the projection is expected, not a fault: `resolve_universe` keeps players who are available OR sufficiently owned, and the criterion is recorded in the header. A large unexplained drop is worth investigating; a modest one is the filter working.
