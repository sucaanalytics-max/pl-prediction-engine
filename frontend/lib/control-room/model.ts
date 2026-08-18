/**
 * The control room's three teams, and the few figures it derives itself.
 *
 * ## Why this module exists rather than literals in the page
 *
 * The design document this screen implements ships a populated example: Ronny at
 * 54, Wazza at 53, `Thomas → Senesi`, `£96.9m · £3.1m`, both bots' last runs at
 * `06:14 today`. Its own provenance section says all of that is fabricated — "the
 * two sample proposals" — and neither bot has ever published a decision:
 * `fpl/decision_public_gw01_season.json` and `..._weekly.json` have never been
 * written, and `fpl/agent_status.json` reports `agent_ran: false`.
 *
 * So the page renders `∅` in those cells. What is left here is the small set of
 * things that genuinely are knowable, each with the file that knows it:
 *
 * | thing | where it comes from |
 * |---|---|
 * | entry ids, names, objectives | `pipeline/config.py` `FPL_ENTRIES` |
 * | the weekly tail threshold | `pipeline/decide/plan_eval.py` `tail_threshold` |
 * | six calibrated gameweeks | `pipeline/decide/field.py` `REQUIRED_CALIBRATED_GAMEWEEKS` |
 * | the ownership argument | `pipeline/decide/field.py` module docstring |
 * | the XI's projected total | `fpl/xp_public_gw{NN}.json`, joined on FPL's own id |
 * | the availability split | `player_stats.json` |
 * | gameweeks sealed | `fpl/accuracy.json` |
 *
 * Everything in the first four rows is team metadata — the same class of thing as
 * an entry id — and it is written down once, here, with its source named. Nothing
 * below invents a measurement.
 */

import type { Accuracy } from "@/lib/data/accuracy";
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { PlayerRow } from "@/lib/data/narrow";
import type { Projection } from "@/lib/data/projections";
import { joinProjections } from "@/lib/margin/squad";
import { pointsFrom, projectedTotal } from "@/lib/margin/planner";

// ─────────────────────────────────────────────────────────────────────────────
// Who the three teams are
// ─────────────────────────────────────────────────────────────────────────────

/** The URL's own vocabulary for the focused team. `?team=mine`. */
export const TEAM_KEYS = ["mine", "ronny", "wazza"] as const;
export type TeamKey = (typeof TEAM_KEYS)[number];

/**
 * The threshold the weekly objective clears, as the producer defaults it.
 *
 * **70, not the design's 60.** `plan_eval.py` computes the whole ladder —
 * `TAIL_THRESHOLDS = (40, 50, 60, 70, 80, 90)` — and both `adjudicate` and
 * `run_decide.decide` default `tail_threshold` to 70; 60 is a rung, not the
 * default. The design names 60 in a prototype prop with a slider, which is how the
 * two drifted apart.
 *
 * It is a producer default rather than a published figure, and the objective row
 * says so: no run has written a decision, so nothing has recorded which rung this
 * gameweek was solved against.
 */
export const TAIL_THRESHOLD = 70;

/**
 * Consecutive gameweeks inside the field model's calibration band before the
 * weekly objective may drive a recommendation.
 *
 * `pipeline/decide/field.py`: "Six because a single gameweek's average and highest
 * are one draw each, and three would be cheap to pass by luck." Until it is met,
 * `run_decide` falls back to the EV-optimal plan and appends a warning saying so —
 * which is why the caveat on this screen is content rather than a fault.
 */
export const REQUIRED_CALIBRATED_GAMEWEEKS = 6;

export interface Team {
  readonly key: TeamKey;
  readonly name: string;
  readonly entryId: number;
  readonly kind: "human" | "bot";
  /** The mono figure in the objective row. */
  readonly objective: string;
  /** The strip's and the header's one-line description of the mandate. */
  readonly mandate: string;
  /**
   * Which published decision carries this team's proposal, or null.
   *
   * `null` for the human entry, and that is a fact rather than a gap: nothing in
   * the pipeline solves for 20945. The two bots' labels are the keys
   * `pipeline/config.py` uses, which is what makes the path derivable.
   */
  readonly decisionLabel: "season" | "weekly" | null;
}

/**
 * The three, in reading order.
 *
 * Ronny and Wazza read one identical projection and reach opposite conclusions;
 * the ordering puts the human first because the screen answers "what needs me".
 */
export const TEAMS: readonly Team[] = [
  {
    key: "mine",
    name: "Mine",
    entryId: 20945,
    kind: "human",
    objective: "Your call",
    mandate: "Human · advisory only",
    decisionLabel: null,
  },
  {
    key: "ronny",
    name: "Ronny",
    entryId: 2561567,
    kind: "bot",
    objective: "E[season]",
    mandate: "Bot · max E[season]",
    decisionLabel: "season",
  },
  {
    key: "wazza",
    name: "Wazza",
    entryId: 2561099,
    kind: "bot",
    objective: `P(GW ≥ ${TAIL_THRESHOLD})`,
    mandate: `Bot · max P(≥${TAIL_THRESHOLD})`,
    decisionLabel: "weekly",
  },
];

export function teamOf(key: TeamKey): Team {
  // Non-null by construction: `TeamKey` is the union of the three keys below.
  return TEAMS.find((team) => team.key === key) ?? TEAMS[0];
}

/**
 * `?team=` in, a team out, and an unrecognised value falls back to the human.
 *
 * Not `as TeamKey`. A cast would let `?team=toString` through, and this app has
 * already shipped that exact bug once: `/margin` read `?view=` with `in` rather
 * than `hasOwn`, so an inherited key resolved to a function, React took it for a
 * state updater and the page rendered a bar with no panel under it.
 */
export function teamFromParam(raw: string | null | undefined): TeamKey {
  if (!raw) return "mine";
  return (TEAM_KEYS as readonly string[]).includes(raw) ? (raw as TeamKey) : "mine";
}

// ─────────────────────────────────────────────────────────────────────────────
// The figures this screen derives
// ─────────────────────────────────────────────────────────────────────────────

export interface XiTotal {
  /** Sum of the published means over the drafted XI. Captain NOT doubled. */
  readonly total: number;
  /** How many of the eleven carried a published projection. */
  readonly matched: number;
  readonly xiSize: number;
  readonly captain: SquadPlayer | null;
  readonly vice: SquadPlayer | null;
}

/**
 * The drafted eleven's projected total, and only what is additive.
 *
 * A mean is additive: the mean of a sum is the sum of the means, whatever the
 * correlation between the terms. So this figure is exact rather than an estimate,
 * and it is the one squad-level number on the screen.
 *
 * **A quantile is not additive**, and nothing here pretends otherwise. Adding the
 * eleven q10s and eleven q90s produces an interval the producer never computed —
 * narrower than the measured one once clean sheets are drawn jointly across a
 * defence and the XI becomes path-dependent through auto-substitution, which is
 * the flattering direction to be wrong in. `PublicDecision.points_q10` is where a
 * squad total's interval legitimately comes from, it is null until a decision is
 * published, and `SquadInterval` already says the sentence for that: "No interval
 * is published for a squad total, so none is drawn."
 *
 * Counting rule stated rather than chosen quietly: {@link projectedTotal} does not
 * double the armband, because two screens in this app once printed 48.20 and 54.9
 * for the same eleven and the same artifact with neither saying which was which.
 *
 * Null when the squad does not distinguish its starters — `bench` is optional on
 * `SquadPlayer`, and treating unknown as starting would invent an eleven.
 */
export function xiTotal(
  squad: readonly SquadPlayer[],
  projections: readonly Projection[],
): XiTotal | null {
  const named = squad.filter((player) => player.bench !== undefined);
  if (named.length === 0) return null;

  const xi = named.filter((player) => player.bench === false);
  if (xi.length === 0) return null;

  const points = pointsFrom(projections);
  const join = joinProjections(xi, projections);

  return {
    total: projectedTotal(xi, points),
    matched: join.matchedById + join.matchedByName,
    xiSize: xi.length,
    captain: squad.find((player) => player.role === "captain") ?? null,
    vice: squad.find((player) => player.role === "vice") ?? null,
  };
}

export interface AvailabilitySplit {
  /** Players FPL has flagged as out, suspended or not in the squad. */
  readonly flagged: number;
  /**
   * Players carrying no such flag.
   *
   * Emphatically NOT "verified fit". `fpl_api.py:270` writes `available` as
   * `status in {"a", "d"}` — available *or doubtful* — so this segment holds
   * everyone the provider has not ruled out, including players nobody has said
   * anything about at all. The bar draws it hatched for that reason: absence of
   * news must never be drawn as fitness, and this artifact cannot separate "fit"
   * from "unmentioned".
   */
  readonly unflagged: number;
  readonly total: number;
}

/**
 * The availability bar's two segments, counted from the artifact.
 *
 * Never typed. The design's caption reads "39 of 587 carry a chance of playing",
 * which was true of one capture and is a different number every day; `player_stats`
 * is 590 rows now. Counting it also keeps the two segments summing to the total,
 * which a pair of literals stops doing the first time the roster changes.
 *
 * Null when nothing was published, so the caller renders the absence rather than
 * a bar of two zeroes — a zero-width segment reads as "nobody is flagged", which
 * is a measurement, and this would be its absence.
 */
export function availabilitySplit(
  rows: readonly PlayerRow[] | null | undefined,
): AvailabilitySplit | null {
  if (!rows || rows.length === 0) return null;
  let flagged = 0;
  let unflagged = 0;
  for (const row of rows) {
    // A tri-state, and the third value is not folded into either segment: "the
    // provider did not say" is not "the provider said available".
    if (row.available === false) flagged += 1;
    else if (row.available === true) unflagged += 1;
  }
  if (flagged + unflagged === 0) return null;
  return { flagged, unflagged, total: rows.length };
}

/**
 * How many players carry a complete set of measured quartiles.
 *
 * Counted rather than claimed. §9 of the design document lists every quantile in
 * every design file as fabricated — drawn by a local `shape()` helper around a real
 * mean — and that was true when it was written. The producer ships them now, all
 * five for all 590 players, so the glyph on this board is drawn from measurement.
 * But "all of them" is a claim about a file that changes weekly, and a sentence
 * asserting it would go on asserting it through the first partial run; the count
 * makes the claim self-checking.
 *
 * Complete means all five: a q25 with no q75 is a half-box, which is a narrower
 * interval than the one measured, and the glyph drops it rather than drawing half.
 */
export function withQuartiles(players: readonly Projection[]): number {
  return players.filter(
    (player) => player.q10 !== null && player.q25 !== null && player.q50 !== null
      && player.q75 !== null && player.q90 !== null,
  ).length;
}

/**
 * How many players the simulation gated out of appearing at all.
 *
 * `p_appears === 0` is the simulation's own statement that a player was held out
 * of every draw, which is what "availability-gated" means downstream. Counted
 * rather than read from a summary field, because no artifact publishes the count.
 */
export function gatedInSimulation(players: readonly Projection[]): number {
  return players.filter((player) => player.pAppears === 0).length;
}

/**
 * Calibrated gameweeks behind the weekly objective, or null when unknowable.
 *
 * Nothing computes this counter yet: the band is checked against
 * `field_observations.jsonl`, which no workflow publishes to the frontend. What
 * *is* published is `fpl/accuracy.json`'s `gameweeks_sealed`, and calibration
 * cannot outrun sealing — a gameweek that has not sealed cannot have been scored.
 * So zero sealed is genuine evidence of zero calibrated, and that is the only
 * inference drawn here.
 *
 * Above zero the two part company, and this refuses rather than guesses: three
 * sealed gameweeks say nothing about whether the field model held its band in
 * them. Null then, and the cell says the counter is not published.
 */
export function calibratedWeeks(accuracy: Accuracy | null): number | null {
  if (accuracy === null) return null;
  return accuracy.gameweeksSealed === 0 ? 0 : null;
}

/** `£99.5m`, and the only place this screen writes a currency symbol. */
export function money(millions: number | null | undefined): string | null {
  if (millions === null || millions === undefined) return null;
  if (!Number.isFinite(millions)) return null;
  return `£${millions.toFixed(1)}m`;
}

/**
 * The bank as FPL holds it — tenths of a million.
 *
 * `0.5` renders `5 tenths`, and the row says so because FPL's own API reports the
 * bank in tenths and a reader reconciling this screen against it should not have
 * to do the arithmetic. Null in, null out: a null bank means "no deadline has
 * passed", and `£0.0m` is a different and much more actionable claim.
 */
export function tenths(millions: number | null | undefined): number | null {
  if (millions === null || millions === undefined) return null;
  if (!Number.isFinite(millions)) return null;
  return Math.round(millions * 10);
}
