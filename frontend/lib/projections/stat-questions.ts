/**
 * What the stats screen asks, what it can answer, and who measured each answer.
 *
 * ## The structure this replaces, and why
 *
 * Tabs used to be split BY WARRANTY: one per published artifact, so incomparable
 * columns could never be read against each other. The rule was sound and it is
 * kept — see {@link StatBand} — but as a NAVIGATION boundary it also made every
 * question that spans sources unanswerable, which is most real questions. "Is his
 * finishing sustainable" needs goals (FPL), non-penalty xG (Understat) and the
 * simulation's own odds: three tabs, no way to see them together.
 *
 * So the boundary moved. A tab is now a QUESTION, and the warranty is declared in
 * the column header instead — every band names its source and states how much
 * football that source has seen. The rule survives as something a reader can see
 * rather than something the navigation makes impossible.
 *
 * That trade is real and worth stating plainly: FPL's xG and Understat's npxG now
 * sit on the same row. Nothing but the band rail and the coverage strip stops a
 * reader subtracting one from the other. `stat-questions.test.ts` pins the one
 * defence that is structural rather than typographic — a DERIVED column may never
 * cross a band, because two sources cover different numbers of matches and the
 * subtraction would be arithmetic on two different denominators.
 */

import type { PlayerEvent } from "@/lib/data/player-events";
import type { Projection } from "@/lib/data/projections";
import type { PlayerRow } from "@/lib/data/narrow";

export type StatSource = "playerStats" | "projections" | "playerEvents" | "market";

/** One player, gathered from every artifact that mentions them. */
export interface StatRow {
  readonly elementId: number;
  readonly name: string;
  readonly team: string;
  readonly position: string;
  readonly owned: boolean;
  readonly stats: PlayerRow | null;
  readonly projection: Projection | null;
  readonly event: PlayerEvent | null;
}

export interface StatColumn {
  readonly key: string;
  readonly label: string;
  /** null renders as ∅ — withheld, which is not a zero. */
  readonly of: (row: StatRow) => number | null;
  readonly decimals?: number;
  /**
   * A column computed from others rather than read from a feed.
   *
   * Marked because the test above forbids one from reading across bands, and a
   * flag is the only way that rule can be checked rather than remembered.
   */
  readonly derived?: boolean;
  /** Sign carries meaning: over is good, under is not. Only for derived columns. */
  readonly signed?: boolean;
  /**
   * Which end of this column is the better one, when two players are set beside
   * each other — or null when the column is not a contest at all.
   *
   * Null is the important case and the reason this is explicit rather than
   * assumed. A comparison that marked the highest figure in every row put a rule
   * under the more EXPENSIVE player's price and the more owned player's
   * ownership, which are facts about a purchase rather than merits. `±` inverts
   * for the same reason from the other direction: a wider spread is a worse buy
   * at the same mean, so the smaller number wins.
   */
  readonly better?: "high" | "low" | null;
}

/**
 * A run of columns that share a source, and therefore share a warranty.
 *
 * The band is where the old tab boundary went. It is drawn as a rule and a label
 * over its columns, and the label carries the source's coverage, because a
 * warranty without a denominator is what made two xG figures look like an
 * argument.
 */
export interface StatBand {
  readonly source: StatSource;
  readonly name: string;
  readonly columns: readonly StatColumn[];
}

export interface StatQuestion {
  readonly key: string;
  readonly label: string;
  /** One line, shown beside the sheet. */
  readonly note: string;
  readonly bands: readonly StatBand[];
  /** Which column the sheet opens sorted by. */
  readonly sortKey: string;
}

function num(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pct(value: number | null | undefined): number | null {
  const n = num(value);
  return n === null ? null : n * 100;
}

/**
 * A per-90 from FPL's record, gated on the producer's own flag.
 *
 * Never recomputed here: `player_stats.json` derives `ratesAreMeaningful` where
 * the trap lives — its arithmetic is `xg / max(minutes / 90, 0.1)`, so a player
 * with no minutes reads as `xg * 10`.
 */
function fplRate(row: StatRow, pick: (r: PlayerRow) => number | null): number | null {
  const s = row.stats;
  if (s === null || !s.ratesAreMeaningful || s.minutes <= 0) return null;
  const value = pick(s);
  return value === null ? null : value / (s.minutes / 90);
}

const FPL_RECORD = (columns: readonly StatColumn[]): StatBand =>
  ({ source: "playerStats", name: "FPL record", columns });
const UNDERSTAT = (columns: readonly StatColumn[]): StatBand =>
  ({ source: "playerEvents", name: "Understat", columns });
const SIMULATION = (columns: readonly StatColumn[]): StatBand =>
  ({ source: "projections", name: "Simulation", columns });
const MARKET = (columns: readonly StatColumn[]): StatBand =>
  ({ source: "market", name: "Market", columns });

export const STAT_QUESTIONS: readonly StatQuestion[] = [
  {
    key: "playing",
    label: "Is he playing?",
    sortKey: "eMinutes",
    note: "Minutes behind him and minutes in front of him. The record is what has "
      + "happened; the two probabilities are the simulation's, and they are the only "
      + "columns on this sheet that are about a match not yet played.",
    bands: [
      FPL_RECORD([
        { key: "minutes", label: "Mins", better: "high", of: (r) => num(r.stats?.minutes) },
      ]),
      UNDERSTAT([
        { key: "uMinutes", label: "Mins", better: "high", of: (r) => num(r.event?.minutes) },
      ]),
      SIMULATION([
        { key: "p60", label: "P(60)", better: "high", of: (r) => pct(r.projection?.p60) },
        { key: "eMinutes", label: "E[min]", better: "high", of: (r) => num(r.projection?.eMinutes), decimals: 0 },
      ]),
      MARKET([
        { key: "price", label: "£", better: null, of: (r) => num(r.stats?.fpl_price), decimals: 1 },
        { key: "own", label: "Own%", better: null, of: (r) => num(r.stats?.fpl_ownership), decimals: 1 },
      ]),
    ],
  },
  {
    key: "finishing",
    label: "Is he finishing?",
    sortKey: "overExpected",
    note: "Goals against two independent expected-goals models, and the simulation's own "
      + "odds on the coming week. G − xG stays inside the FPL band on purpose: the two "
      + "providers cover different numbers of matches, so crossing the band would be "
      + "arithmetic on two different denominators.",
    bands: [
      FPL_RECORD([
        { key: "goals", label: "G", better: "high", of: (r) => num(r.stats?.goals) },
        { key: "xg", label: "xG", better: "high", of: (r) => num(r.stats?.xg), decimals: 2 },
        { key: "xg90", label: "xG/90", decimals: 2, better: "high", of: (r) => fplRate(r, (s) => num(s.xg)) },
        {
          /* `better: null` even though a bigger number looks better. Over-
             performance is not a merit to be crowned in a two-player comparison —
             it is as often a finishing run about to end as a skill — and the sign
             already carries the reading. Stated rather than left to `signed`, so
             the rule is a decision instead of a side effect. */
          key: "overExpected", label: "G − xG", decimals: 2, derived: true, signed: true,
          better: null,
          of: (r) => {
            const goals = num(r.stats?.goals);
            const xg = num(r.stats?.xg);
            return goals === null || xg === null ? null : goals - xg;
          },
        },
      ]),
      UNDERSTAT([
        { key: "shots", label: "Sh", better: "high", of: (r) => num(r.event?.shots) },
        { key: "npxg", label: "npxG", better: "high", of: (r) => num(r.event?.npXg), decimals: 2 },
        { key: "shots90", label: "Sh/90", better: "high", of: (r) => num(r.event?.shotsPer90), decimals: 2 },
      ]),
      SIMULATION([
        { key: "pGoal", label: "P(goal)", better: "high", of: (r) => pct(r.projection?.pGoal) },
      ]),
      MARKET([
        { key: "price", label: "£", better: null, of: (r) => num(r.stats?.fpl_price), decimals: 1 },
        { key: "own", label: "Own%", better: null, of: (r) => num(r.stats?.fpl_ownership), decimals: 1 },
      ]),
    ],
  },
  {
    key: "creating",
    label: "Is he creating?",
    sortKey: "xgChain",
    note: "Assists, the chances behind them, and Understat's possession-chain measures — "
      + "involvement that stops short of the shot and never shows up in a goal or an "
      + "assist.",
    bands: [
      FPL_RECORD([
        { key: "assists", label: "A", better: "high", of: (r) => num(r.stats?.assists) },
        { key: "xa", label: "xA", better: "high", of: (r) => num(r.stats?.xa), decimals: 2 },
        { key: "xa90", label: "xA/90", decimals: 2, better: "high", of: (r) => fplRate(r, (s) => num(s.xa)) },
      ]),
      UNDERSTAT([
        { key: "keyPasses", label: "KP", better: "high", of: (r) => num(r.event?.keyPasses) },
        { key: "uXa", label: "xA", better: "high", of: (r) => num(r.event?.xa), decimals: 2 },
        { key: "xgChain", label: "xGChain", better: "high", of: (r) => num(r.event?.xgChain), decimals: 2 },
      ]),
      MARKET([
        { key: "price", label: "£", better: null, of: (r) => num(r.stats?.fpl_price), decimals: 1 },
        { key: "own", label: "Own%", better: null, of: (r) => num(r.stats?.fpl_ownership), decimals: 1 },
      ]),
    ],
  },
  {
    key: "priced",
    label: "Is he priced right?",
    sortKey: "perMillion",
    note: "What the coming week is worth against what it costs. The spread beside xP is "
      + "what says how much to trust it — a high mean with a wide spread and a high mean "
      + "with a narrow one are not the same buy.",
    bands: [
      SIMULATION([
        { key: "xp", label: "xP", better: "high", of: (r) => num(r.projection?.xp), decimals: 2 },
        { key: "sd", label: "±", better: "low", of: (r) => num(r.projection?.xpSd), decimals: 2 },
        { key: "p10", label: "P(10+)", better: "high", of: (r) => pct(r.projection?.pGe10) },
      ]),
      MARKET([
        { key: "price", label: "£", better: null, of: (r) => num(r.stats?.fpl_price), decimals: 1 },
        { key: "own", label: "Own%", better: null, of: (r) => num(r.stats?.fpl_ownership), decimals: 1 },
        { key: "form", label: "Form", better: "high", of: (r) => num(r.stats?.form), decimals: 1 },
        {
          key: "perMillion", label: "xP per £m", decimals: 2, derived: true, better: "high",
          /* Both halves come from the same row's own price and the simulation's
             xP. This is the one derived column that spans a band, and it is
             allowed because neither half is a MEASUREMENT OVER MATCHES — a price
             has no denominator to disagree about. `stat-questions.test.ts` states
             that exception rather than leaving it to look like an oversight. */
          of: (r) => {
            const xp = num(r.projection?.xp);
            const price = num(r.stats?.fpl_price);
            return xp === null || price === null || price <= 0 ? null : xp / price;
          },
        },
      ]),
    ],
  },
];

/**
 * Feeds this pipeline does not carry, named rather than silently absent.
 *
 * A question that is absent tells the reader nothing; a question named with its
 * missing feed tells them the column exists in the game, is not in this app, and
 * why. Unchanged in substance from the tab manifest this file replaces — what
 * changed is that these are no longer struck-through TABS sitting beside live
 * ones, because a question is not blocked, a FEED is.
 */
export interface BlockedFeed {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly blockedBy: string;
}

export const BLOCKED_FEEDS: readonly BlockedFeed[] = [
  {
    key: "defending",
    label: "Defending",
    note: "clearances, blocks, interceptions, tackles and recoveries",
    blockedBy: "FPL publishes these in its bootstrap; this pipeline does not carry them "
      + "into an artifact yet.",
  },
  {
    key: "setpieces",
    label: "Set pieces",
    note: "penalty, free-kick and corner order",
    blockedBy: "Order is published per team in the bootstrap and is not narrowed here, so "
      + "the sheet cannot say who takes them.",
  },
  {
    key: "market",
    label: "Transfers in and out",
    note: "how many managers moved this week",
    blockedBy: "Counts arrive in the bootstrap and are not carried into an artifact, so "
      + "price-change pressure cannot be shown.",
  },
];

export function questionByKey(key: string): StatQuestion {
  return STAT_QUESTIONS.find((q) => q.key === key) ?? STAT_QUESTIONS[0];
}

/** Every column of a question, flattened, in the order the sheet draws them. */
export function columnsOf(question: StatQuestion): readonly StatColumn[] {
  return question.bands.flatMap((band) => band.columns);
}

/** Which sources a question actually reads. Drives the coverage strip. */
export function sourcesOf(question: StatQuestion): readonly StatSource[] {
  return question.bands.map((band) => band.source);
}
