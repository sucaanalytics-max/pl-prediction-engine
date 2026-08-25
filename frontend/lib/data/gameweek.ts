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
 * ## The order, and why it changed
 *
 * FPL's own `event` first, via `/api/fpl/state` — but read as a *planning* week,
 * not verbatim. See `planningGameweek` below.
 *
 * `agent_status.json` second, as a fallback. It used to be first, and the reason
 * given was availability: the phase resolver always runs, so it has an answer
 * even in the ten days of a cycle when the agent is gated and every artifact it
 * owns is absent. That argument was about *availability* and was never about
 * correctness, and on 2026-08-25 the difference emptied `/` and `/players` in
 * production.
 *
 * `agent_status.gameweek` is the agent's WORK QUEUE, not the week in play. In
 * `schedule.py`'s refit branch it is `unscored[0]` — the settled gameweek still
 * needing a score — with `reason: "GW1 is settled but not scored"` and
 * `outstanding: [{gameweek: 1, action: "score"}]`. Meanwhile the same agent run
 * had already published `xp_public_gw02.json` and pruned gw01 (`public_xp.write`
 * calls `prune(keep=gameweek)`, which deletes strictly-earlier weeks). So this
 * function returned 1, every surface fetched a file the producer had correctly
 * deleted, and two screens rendered empty for the four days between GW1's last
 * match and GW2's deadline. That window recurs every gameweek.
 *
 * The agent needs `ScheduleState.gameweek` to mean the week it is working on —
 * `_settle` and `_score` both key off it — so the fix belongs here, in the
 * consumer that was reading a work-queue field as a display field.
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

/**
 * The last gameweek of an FPL season. There is no GW39 to roll forward into.
 */
export const LAST_GAMEWEEK = 38;

/**
 * The gameweek a manager can still act on, from FPL's own current event.
 *
 * FPL keeps an event `is_current` from its own deadline until the *next* one, so
 * between a gameweek's final whistle and the following deadline `event.id` names
 * a week that has already been played. This app is a planner: the only week worth
 * pointing a projection surface at is the one still ahead of its deadline.
 *
 * Verified against the live payload on 2026-08-25: `event.id` 1,
 * `deadlineTime` 2026-08-21T17:30Z, `phase` "live" — four days after GW1's last
 * match and three days before GW2's deadline. The published artifact was
 * `xp_public_gw02.json`, first kickoff 28 Aug. Rolling forward agrees with the
 * producer; taking `id` verbatim does not.
 *
 * A null deadline returns `id` unchanged rather than guessing forward: without a
 * deadline there is nothing to say the week has closed, and rolling forward on no
 * evidence would point every surface at a week nobody has projected.
 *
 * Exported and pure so it can be tested without a browser or a clock.
 */
export function planningGameweek(
  id: number | null | undefined,
  deadlineTime: string | null | undefined,
  now: Date,
): number | null {
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  if (!deadlineTime) return id;
  const deadline = new Date(deadlineTime);
  // An unparseable date is not a passed one. `getTime()` on an invalid Date is
  // NaN, and every comparison against NaN is false, so this would silently read
  // as "not passed" — worth saying out loud rather than relying on it.
  if (Number.isNaN(deadline.getTime())) return id;
  if (deadline.getTime() > now.getTime()) return id;
  // The season's last deadline has passed: there is nothing left to plan, so stay
  // put rather than naming a gameweek that does not exist.
  return id >= LAST_GAMEWEEK ? LAST_GAMEWEEK : id + 1;
}

/**
 * Phases in which `agent_status.gameweek` names a week already played.
 *
 * In these three branches of `schedule.py` the field is retrospective work, not
 * the week in play: `SETTLE_FINAL` takes the first sealed-but-unsettled gameweek,
 * `REFIT` takes `unscored[0]`, and `SETTLE_PROVISIONAL` the week whose fixtures
 * have finished. Every other phase — `IDLE`, `LOCKED`, `SEAL`, `REFRESH` —
 * derives its gameweek from the *upcoming* deadline, which is exactly what a
 * planner wants, and is why the agent stays the preferred source.
 *
 * Matched by string because the frontend narrows `phase` as a string: a phase
 * added on the Python side must NOT silently join this set, so an unknown name
 * is treated as forward-looking, which is the pre-existing behaviour.
 */
const RETROSPECTIVE_PHASES: ReadonlySet<string> = new Set([
  "settle_final",
  "settle_provisional",
  "refit",
]);

/**
 * The agent's gameweek, but only when it names the week in play.
 *
 * Null in a retrospective phase so the caller falls through to FPL's event. Pure
 * and exported because the phase list is the whole fix and deserves its own
 * tests — inline, it would only be exercised through a React hook.
 */
export function agentPlanningWeek(
  gameweek: number | null | undefined,
  phase: string | null | undefined,
): number | null {
  if (typeof gameweek !== "number" || !Number.isFinite(gameweek)) return null;
  return RETROSPECTIVE_PHASES.has(phase ?? "") ? null : gameweek;
}

export function useCurrentGameweek(): number | null {
  const { artifact: status } = useArtifact(AGENT_STATUS);
  const { artifact: heuristics } = useHeuristics();
  const agent = proven(status);
  // The agent first, as before — but only while its number means the upcoming
  // week. In a retrospective phase it is a work queue, and reading it as a
  // display gameweek is what emptied two screens for four days.
  const agentWeek = agentPlanningWeek(agent?.gameweek, agent?.phase);

  // `event?.id`, optionally, even though `HeuristicView.event` is not optional.
  // Four surfaces now resolve their week here, so a shape this function trusted
  // and did not get would throw inside all four rather than in one — and the
  // whole point of `proven` is that a narrowed value is the only trusted one.
  const event = proven(heuristics)?.event;
  return (
    agentWeek ??
    planningGameweek(event?.id, event?.deadlineTime, new Date()) ??
    null
  );
}
