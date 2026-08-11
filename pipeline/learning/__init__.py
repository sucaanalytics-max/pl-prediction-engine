"""Measurement and learning for the FPL agent.

Everything here is about knowing whether the agent is any good: the sealed
pre-deadline ledger, settlement from realised outcomes, metrics, baselines,
the walk-forward backtest, and the gated parameter refit.

Nothing in this package may be imported by a module that produces a forecast.
The dependency runs one way — learning observes the model, never the reverse.
"""
