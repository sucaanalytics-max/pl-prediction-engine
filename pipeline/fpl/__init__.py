"""
Pure FPL rules. No statistics, no I/O, no randomness.

This is the bottom of the dependency graph: `simulation/`, `decide/` and
`learning/` all import it, and it imports none of them. That is what makes it
verifiable independently of any model — the scoring function can be checked
against tens of thousands of settled real gameweeks without a single parameter
being fitted.

Rules are facts. Nothing in `pipeline/learning/` may modify anything here.
"""
