"use client";

/**
 * Which gameweek the app is looking at. One answer, one place.
 *
 * ## Why this is not a label
 *
 * `lib/data/projections.ts:289-292` turns the number into a path —
 * `fpl/xp_public_gw{NN}.json`. So a resolver that disagrees with another
 * resolver does not mislabel a figure, it **reads a different file**, and two
 * screens can quote "GW1" while one of them is showing last week's projection.
 * The GW1 deadline is a hard clock; that divergence is worth one shared function.
 *
 * ## The order, and why
 *
 * `agent_status.json` first. It is written by the phase resolver, which always
 * runs, so it has an answer even in the ten days of a cycle when the agent
 * itself is gated and every artifact it owns is absent. `app/margin/page.tsx`
 * already ranked it primary in a docstring only that page obeyed.
 *
 * `/api/fpl/state`'s `event.id` second — FPL's own gameweek number, live but on
 * a 30-minute staleness budget (`useHeuristics.ts:39`).
 *
 * Then **null**, not 1. A hardcoded 1 is wrong for 37 weeks of 38, and because
 * the number becomes a fetch path a wrong last resort is not a cosmetic default:
 * it silently points a surface at the wrong artifact. Callers that genuinely
 * cannot render without a number still say `?? 1` at their own call site, where
 * the choice is visible.
 *
 * Deliberately NOT included: `matches.gameweek`. Deriving an FPL gameweek from a
 * match-odds artifact is a coincidence, not a source.
 *
 * ## Who calls it
 *
 * Every surface that turns a gameweek into a path: `app/page.tsx`,
 * `components/GameweekCall.tsx`, `components/SquadBoard.tsx` and
 * `app/margin/page.tsx`. The first three take the `null` and say so; the fourth
 * says `?? 1` at its own call site because all of its panels need a number.
 */

import { proven } from "@/lib/data/artifact";
import { AGENT_STATUS } from "@/lib/data/agent-status";
import { useArtifact } from "@/lib/data/useArtifact";
import { useHeuristics } from "@/lib/data/useHeuristics";

export function useCurrentGameweek(): number | null {
  const { artifact: status } = useArtifact(AGENT_STATUS);
  const { artifact: heuristics } = useHeuristics();
  // `event?.id`, optionally, even though `HeuristicView.event` is not optional.
  // Four surfaces now resolve their week here, so a shape this function trusted
  // and did not get would throw inside all four rather than in one — and the
  // whole point of `proven` is that a narrowed value is the only trusted one.
  return proven(status)?.gameweek ?? proven(heuristics)?.event?.id ?? null;
}
