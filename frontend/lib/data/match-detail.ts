/**
 * One fixture in full, for `/matches/[id]`.
 *
 * ## Why this is separate from `narrowLatest`
 *
 * `Latest` deliberately carries the handful of fields that list-shaped screens
 * need. The detail page reads about thirty more — the correct-score grid, the
 * Asian-handicap ladder, four simulated distributions, bookings, goalscorers,
 * the odds comparison and the narrative. Folding all of that into `Latest`
 * would make every page that renders a fixture row pay for a payload only one
 * page opens, and would put thirty tolerances in the path of the screens that
 * matter most.
 *
 * So the same file is narrowed twice, for two different questions. That is not
 * duplication: `narrowLatest` answers "what are the fixtures", this answers
 * "everything known about one of them".
 *
 * ## Strict where the page branches, tolerant elsewhere
 *
 * The doctrine from `check.ts`. `home_team`, `away_team` and the 1X2 trio decide
 * what the page renders at all, so they are required. Every deep-detail block is
 * display-only and degrades to absent — the explainability and live-odds stages
 * have never run, so `shap_features` is `[]` and `odds_comparison` is `null` on
 * 10 of 10 committed predictions. Rejecting the file over those would blank a
 * page because two optional stages were skipped.
 *
 * Distributions are the one place tolerance would be dangerous, and they are
 * handled specifically: a malformed series becomes `[]` rather than an array
 * with holes, because a chart plots a gap as a value.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  isRecord, optArray, optBoolean, optNumber, optString, Problems, reqRecord,
  reqString,
} from "@/lib/data/check";
import { narrowBets, type Bet } from "@/lib/data/narrow";
import { DAY, type Descriptor } from "@/lib/data/registry";

export interface ShapFeature {
  readonly name: string;
  readonly value: number;
}

export interface MatchDetail {
  readonly match_id: string;
  readonly home_team: string;
  readonly away_team: string;
  readonly gameweek: number | null;
  readonly kickoff: string | null;
  readonly referee: string | null;
  readonly is_derby: boolean | null;

  readonly prob_home: number;
  readonly prob_draw: number;
  readonly prob_away: number;

  /** Null when the model published no expected scoreline; never a coerced 0-0. */
  readonly expected_goals: { readonly home: number; readonly away: number } | null;
  readonly expected_corners: number | null;
  readonly expected_cards: number | null;
  readonly n_simulations: number | null;
  readonly model_disagreement: number | null;
  readonly narrative: string | null;

  readonly confidence: {
    readonly entropy: number | null;
    readonly home_goals_ci: readonly number[];
    readonly away_goals_ci: readonly number[];
  };

  /**
   * Simulated outcome distributions, keyed as the writer emits them.
   *
   * A series that fails to narrow becomes empty rather than sparse: a chart
   * renders a missing bucket as a value, so a hole is worse than no series.
   */
  readonly distributions: {
    readonly goals_home: readonly number[];
    readonly goals_away: readonly number[];
    readonly corners: readonly number[];
    readonly cards: readonly number[];
  };

  /** Probability maps passed through as-is for display. Numeric values only. */
  readonly markets: {
    readonly over_under: Readonly<Record<string, OverUnder>>;
    readonly btts: { readonly yes: number | null; readonly no: number | null };
    readonly clean_sheet: {
      readonly home: number | null;
      readonly away: number | null;
    };
    readonly correct_score: Readonly<Record<string, number>>;
    readonly asian_handicap: Readonly<Record<string, number>>;
    readonly ht_ft: Readonly<Record<string, number>>;
    readonly corners: Readonly<Record<string, OverUnder>>;
    readonly cards: Readonly<Record<string, OverUnder>>;
  };

  readonly value_bets: readonly Bet[];
  readonly shap_features: readonly ShapFeature[];
  readonly bookings: readonly Booking[];
  readonly goalscorers: {
    readonly home: readonly Scorer[];
    readonly away: readonly Scorer[];
    readonly match_xg: { readonly home: number; readonly away: number } | null;
  };
  /**
   * Bookmaker 1X2 prices, keyed by book.
   *
   * `null` on 10 of 10 committed predictions — the live-odds stage has never
   * run. An empty map would say "no bookmaker priced this", which is a
   * different and wrong claim.
   */
  readonly h2hOdds: Readonly<Record<string, ThreeWayPrice>> | null;
}

export interface Scorer {
  readonly web_name: string;
  readonly position: string;
  readonly anytime_prob: number;
  readonly xg_per_90: number | null;
}

export interface Booking {
  readonly web_name: string;
  readonly team: string;
  readonly adjusted_prob: number;
}

export interface ThreeWayPrice {
  readonly home: number;
  readonly draw: number;
  readonly away: number;
}

/** An over/under pair at one line. Both sides required to be a pair at all. */
export interface OverUnder {
  readonly over: number;
  readonly under: number;
}

/**
 * Lines keyed by threshold, e.g. `{"2.5": {over, under}}`.
 *
 * Verified against the committed artifact: `over_under`, `corners` and `cards`
 * are pair-valued while `correct_score`, `asian_handicap` and `ht_ft` are
 * scalar. Treating all six the same would silently empty the three that are
 * pairs, and the page would render "no lines priced" for a fully priced market.
 */
function lineMap(raw: unknown): Record<string, OverUnder> {
  const out: Record<string, OverUnder> = {};
  if (!isRecord(raw)) return out;
  for (const [line, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const over = optNumber(value.over);
    const under = optNumber(value.under);
    // Half a line is not a line: rendering `over` with no `under` invites the
    // reader to infer the complement, which the model may not have published.
    if (over === null || under === null) continue;
    out[line] = { over, under };
  }
  return out;
}

/** Numbers only. A string in a probability map is dropped, not parsed. */
function numberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const n = optNumber(value);
    if (n !== null) out[key] = n;
  }
  return out;
}

/**
 * A numeric series, or empty.
 *
 * All-or-nothing on purpose. `[0.1, undefined, 0.3]` charts as a dip to zero in
 * the middle, which is a claim the simulation never made.
 */
function series(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const value of raw) {
    const n = optNumber(value);
    if (n === null) return [];
    out.push(n);
  }
  return out;
}

function interval(raw: unknown): number[] {
  return Array.isArray(raw)
    ? raw.map(optNumber).filter((n): n is number => n !== null)
    : [];
}

function scorersOf(raw: unknown): Scorer[] {
  return optArray(raw).flatMap((entry): Scorer[] => {
    if (!isRecord(entry)) return [];
    const web_name = optString(entry.web_name) ?? optString(entry.name);
    const anytime_prob = optNumber(entry.anytime_prob);
    // A scorer with no probability is a name with nothing to say.
    if (web_name === null || anytime_prob === null) return [];
    return [{
      web_name,
      position: optString(entry.position) ?? "—",
      anytime_prob,
      xg_per_90: optNumber(entry.xg_per_90),
    }];
  });
}

function goalscorersOf(raw: unknown): MatchDetail["goalscorers"] {
  const block = isRecord(raw) ? raw : {};
  const xg = isRecord(block.match_xg) ? block.match_xg : null;
  const home = xg ? optNumber(xg.home) : null;
  const away = xg ? optNumber(xg.away) : null;
  return {
    home: scorersOf(block.home_scorers),
    away: scorersOf(block.away_scorers),
    match_xg: home !== null && away !== null ? { home, away } : null,
  };
}

function bookingsOf(raw: unknown): Booking[] {
  const block = isRecord(raw) ? raw : {};
  return optArray(block.top_bookings).flatMap((entry): Booking[] => {
    if (!isRecord(entry)) return [];
    const web_name = optString(entry.web_name) ?? optString(entry.name);
    const adjusted_prob = optNumber(entry.adjusted_prob);
    if (web_name === null || adjusted_prob === null) return [];
    return [{ web_name, team: optString(entry.team) ?? "—", adjusted_prob }];
  });
}

/**
 * Bookmaker prices, or null when the odds stage did not run.
 *
 * Each book needs all three prices: the page inverts them into implied
 * probabilities, and two of three would produce an overround computed against a
 * missing leg — the same one-sided-market hazard `kelly.py` has a guard for.
 */
function h2hOddsOf(raw: unknown): Record<string, ThreeWayPrice> | null {
  if (!isRecord(raw)) return null;
  const h2h = raw.h2h;
  if (!isRecord(h2h)) return null;
  const out: Record<string, ThreeWayPrice> = {};
  for (const [book, prices] of Object.entries(h2h)) {
    if (!isRecord(prices)) continue;
    const home = optNumber(prices.home);
    const draw = optNumber(prices.draw);
    const away = optNumber(prices.away);
    if (home === null || draw === null || away === null) continue;
    // A price of 1.0 or below is not a price; inverting it yields >= 1.0.
    if (home <= 1 || draw <= 1 || away <= 1) continue;
    out[book] = { home, draw, away };
  }
  return out;
}

/** Narrow one raw prediction object into the detail view. */
export function narrowMatchDetail(raw: unknown): NarrowResult<MatchDetail> {
  const problems = new Problems();
  const row = reqRecord(raw, "prediction", problems);
  if (!row) return malformed(problems.all);

  const fixture = reqRecord(row.fixture, "fixture", problems);
  const probabilities = reqRecord(row.probabilities, "probabilities", problems);
  if (!fixture || !probabilities) return malformed(problems.all);

  const home_team = reqString(fixture.home_team, "fixture.home_team", problems);
  const away_team = reqString(fixture.away_team, "fixture.away_team", problems);
  if (!home_team || !away_team) return malformed(problems.all);

  const trio = isRecord(probabilities["1x2"]) ? probabilities["1x2"] : {};
  const distributions = isRecord(row.distributions) ? row.distributions : {};
  const confidence = isRecord(row.confidence) ? row.confidence : {};
  const btts = isRecord(probabilities.btts) ? probabilities.btts : {};
  const cleanSheet = isRecord(probabilities.clean_sheet)
    ? probabilities.clean_sheet
    : {};

  const xg = isRecord(row.expected_goals) ? row.expected_goals : null;
  const xgHome = xg ? optNumber(xg.home) : null;
  const xgAway = xg ? optNumber(xg.away) : null;

  return narrowed({
    match_id: optString(row.match_id) ?? `${home_team}-${away_team}`,
    home_team,
    away_team,
    gameweek: optNumber(fixture.gameweek),
    kickoff: optString(fixture.date) ?? optString(fixture.kickoff),
    referee: optString(fixture.referee),
    is_derby: optBoolean(fixture.is_derby),

    prob_home: optNumber(trio.home) ?? 0,
    prob_draw: optNumber(trio.draw) ?? 0,
    prob_away: optNumber(trio.away) ?? 0,

    expected_goals:
      xgHome !== null && xgAway !== null ? { home: xgHome, away: xgAway } : null,
    expected_corners: optNumber(row.expected_corners),
    expected_cards: optNumber(row.expected_cards),
    n_simulations: optNumber(row.n_simulations),
    model_disagreement: optNumber(row.model_disagreement),
    narrative: optString(row.narrative),

    confidence: {
      entropy: optNumber(confidence.entropy),
      home_goals_ci: interval(confidence.home_goals_ci),
      away_goals_ci: interval(confidence.away_goals_ci),
    },

    distributions: {
      goals_home: series(distributions.goals_home),
      goals_away: series(distributions.goals_away),
      // The writer has used both spellings; neither is canonical.
      corners: series(distributions.corners ?? distributions.total_corners),
      cards: series(distributions.cards ?? distributions.total_cards),
    },

    markets: {
      over_under: lineMap(probabilities.over_under),
      btts: { yes: optNumber(btts.yes), no: optNumber(btts.no) },
      clean_sheet: {
        home: optNumber(cleanSheet.home),
        away: optNumber(cleanSheet.away),
      },
      correct_score: numberMap(probabilities.correct_score),
      asian_handicap: numberMap(probabilities.asian_handicap),
      ht_ft: numberMap(probabilities.ht_ft),
      corners: lineMap(probabilities.corners),
      cards: lineMap(probabilities.cards),
    },

    value_bets: narrowBets(row.value_bets),
    shap_features: optArray(row.shap_features).flatMap((f): ShapFeature[] => {
      if (!isRecord(f)) return [];
      const name = optString(f.feature) ?? optString(f.name);
      const value = optNumber(f.value ?? f.shap_value);
      return name !== null && value !== null ? [{ name, value }] : [];
    }),

    bookings: bookingsOf(row.player_bookings),
    goalscorers: goalscorersOf(row.goalscorer),
    h2hOdds: h2hOddsOf(row.odds_comparison),
  });
}

/**
 * Find one fixture in `latest.json` and narrow it.
 *
 * Three outcomes, deliberately distinct:
 *
 * * a `NarrowResult` — the fixture was found (ok) or found and malformed;
 * * `null` — the file is fine and carries no such fixture, which the caller
 *   turns into `empty`;
 * * a `malformed` result — the *file* is not a prediction file at all.
 *
 * The third used to collapse into the second, so `{predictions: "not a list"}`
 * reported "no such match" and the reader would go looking for a fixture id
 * that was never the problem.
 */
export function findMatchDetail(
  file: unknown, matchId: string,
): NarrowResult<MatchDetail> | null {
  const problems = new Problems();
  if (!isRecord(file)) {
    problems.add("latest.json is not an object");
    return malformed(problems.all);
  }
  if (!Array.isArray(file.predictions)) {
    problems.add("latest.json.predictions is not an array");
    return malformed(problems.all);
  }
  for (const candidate of file.predictions) {
    if (!isRecord(candidate)) continue;
    const fixture = isRecord(candidate.fixture) ? candidate.fixture : {};
    const id =
      optString(candidate.match_id) ??
      `${optString(fixture.home_team) ?? ""}-${optString(fixture.away_team) ?? ""}`;
    if (id === matchId) return narrowMatchDetail(candidate);
  }
  return null;
}

/**
 * A descriptor for one fixture's full detail, read out of `latest.json`.
 *
 * Modelled on `decisionDescriptor`: the path is fixed but the narrowing is
 * parameterised, so the page asks for the match it wants rather than loading
 * everything and rummaging.
 *
 * "No such match" is `empty`, not `unreadable`. The file was published and is
 * well-formed; it simply carries no information about this id — which is what
 * `empty` means, and it is a different card from "the file is broken".
 */
export function matchDetailDescriptor(
  matchId: string,
): Descriptor<MatchDetail | null> {
  return {
    key: `matchDetail:${matchId}`,
    path: "latest.json",
    owner: "daily",
    describes: `everything known about ${matchId}`,
    freshnessBudgetMs: DAY,
    narrow: (raw) => {
      const found = findMatchDetail(raw, matchId);
      // `null` means the file parsed and this fixture is not in it. A narrowing
      // failure inside `narrowMatchDetail` is a different thing and propagates.
      if (found === null) return narrowed(null);
      if (!found.ok) return found;
      return narrowed(found.value);
    },
    isEmpty: (value) => value === null,
  };
}
