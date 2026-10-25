"""Runtime contract checks for exported prediction artifacts."""
from __future__ import annotations

import math
from typing import Dict, List


def _is_probability(value) -> bool:
    return (
        isinstance(value, (int, float))
        and math.isfinite(float(value))
        and 0.0 <= float(value) <= 1.0
    )


def validate_prediction_output(output: Dict) -> List[str]:
    """Return contract violations that should block publication."""
    errors: List[str] = []
    metadata = output.get("metadata", {})
    predictions = output.get("predictions", [])
    expected_sims = metadata.get("n_simulations")
    seen_ids = set()

    if not metadata.get("season"):
        errors.append("metadata.season is required")
    if not isinstance(predictions, list):
        return errors + ["predictions must be a list"]

    for index, prediction in enumerate(predictions):
        prefix = f"predictions[{index}]"
        match_id = prediction.get("match_id")
        if not match_id:
            errors.append(f"{prefix}.match_id is required")
        elif match_id in seen_ids:
            errors.append(f"{prefix}.match_id is duplicated: {match_id}")
        seen_ids.add(match_id)

        if prediction.get("n_simulations") != expected_sims:
            errors.append(
                f"{prefix}.n_simulations={prediction.get('n_simulations')} "
                f"does not match metadata={expected_sims}"
            )

        probabilities = prediction.get("probabilities", {})
        one_x_two = probabilities.get("1x2", {})
        one_x_two_values = [
            one_x_two.get("home"),
            one_x_two.get("draw"),
            one_x_two.get("away"),
        ]
        if not all(_is_probability(v) for v in one_x_two_values):
            errors.append(f"{prefix}.probabilities.1x2 contains invalid values")
        elif abs(sum(one_x_two_values) - 1.0) > 1e-6:
            errors.append(f"{prefix}.probabilities.1x2 does not sum to 1")

        btts = probabilities.get("btts", {})
        if not isinstance(btts, dict):
            errors.append(f"{prefix}.probabilities.btts must be an object")
        elif not all(_is_probability(btts.get(k)) for k in ("yes", "no")):
            errors.append(f"{prefix}.probabilities.btts contains invalid values")
        elif abs(btts["yes"] + btts["no"] - 1.0) > 1e-6:
            errors.append(f"{prefix}.probabilities.btts does not sum to 1")

        for market_name in ("over_under", "corners", "cards"):
            market = probabilities.get(market_name, {})
            for line, sides in market.items():
                if not isinstance(sides, dict):
                    errors.append(
                        f"{prefix}.probabilities.{market_name}.{line} must be an object"
                    )
                    continue
                over, under = sides.get("over"), sides.get("under")
                if not _is_probability(over) or not _is_probability(under):
                    errors.append(
                        f"{prefix}.probabilities.{market_name}.{line} has invalid values"
                    )
                elif abs(over + under - 1.0) > 1e-6:
                    errors.append(
                        f"{prefix}.probabilities.{market_name}.{line} does not sum to 1"
                    )

        handicaps = probabilities.get("asian_handicap", {})
        ordered_handicaps = []
        for key, value in handicaps.items():
            try:
                ordered_handicaps.append((float(key.removeprefix("home_")), value))
            except (TypeError, ValueError):
                errors.append(f"{prefix}.probabilities.asian_handicap has invalid key {key}")
        ordered_handicaps.sort()
        handicap_values = [value for _, value in ordered_handicaps]
        if handicap_values and any(
            later + 1e-12 < earlier
            for earlier, later in zip(handicap_values, handicap_values[1:])
        ):
            errors.append(
                f"{prefix}.probabilities.asian_handicap is not monotonic by home line"
            )

        for booking in prediction.get("player_bookings", {}).get("top_bookings", []):
            if not isinstance(booking.get("is_card_magnet"), bool):
                errors.append(
                    f"{prefix}.player_bookings contains non-boolean is_card_magnet"
                )
                break

    # A held selection is published so it can be reviewed, never so it can be
    # staked: all four stake fields (two currency, two fraction) must be zero
    # and it must say why it was held.
    for index, prediction in enumerate(predictions):
        for held in prediction.get("held_bets") or []:
            staked = [f for f in ("full_kelly", "half_kelly", "full_kelly_pct", "half_kelly_pct")
                      if float(held.get(f) or 0.0) != 0.0]
            if staked or not held.get("hold_reasons"):
                errors.append(
                    f"predictions[{index}].held_bets has a held selection with "
                    f"non-zero stake {staked} or no hold_reasons"
                )
                break

    if metadata.get("odds_source") == "unavailable":
        n_bets = sum(len(p.get("value_bets", [])) for p in predictions)
        if n_bets:
            errors.append("value bets must be empty when current odds are unavailable")

    # The goal-method stake gate, checked on the artifact rather than trusted
    # from find_value_bets: a fixture priced by anything but the required
    # method, or any fixture on a withheld card, must carry no bets.
    staking = metadata.get("staking")
    if isinstance(staking, dict):
        required = staking.get("required_goal_method")
        for index, prediction in enumerate(predictions):
            if not prediction.get("value_bets"):
                continue
            method = (prediction.get("goal_markets") or {}).get("method")
            if staking.get("withheld") or method != required:
                errors.append(
                    f"predictions[{index}].value_bets must be empty: goals priced by "
                    f"{method!r}, staking requires {required!r}"
                    + (" and the card is withheld" if staking.get("withheld") else "")
                )

    return errors


def assert_valid_prediction_output(output: Dict) -> None:
    """Raise before publishing an invalid prediction artifact."""
    errors = validate_prediction_output(output)
    if errors:
        formatted = "\n".join(f"- {error}" for error in errors)
        raise ValueError(f"Prediction artifact validation failed:\n{formatted}")
