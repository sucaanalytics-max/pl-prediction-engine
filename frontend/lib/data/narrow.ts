/**
 * One narrower per artifact, and the descriptor table they are attached to.
 *
 * Rule 4: **runtime narrowing, never `as T`.** `predictions.ts` reached
 * `return await res.json()` inside `fetchWithFallback<T>`, which is an implicit
 * cast — TypeScript checks nothing there, and that is *how* `HealthData` drifted
 * to a producer emitting no metrics without a single error anywhere.
 *
 * Every `raw.foo` access in the app lives in this file. A field read outside a
 * narrower is a field the fixture tests cannot protect.
 *
 * ## What the real files actually contain
 *
 * These narrowers were written against the committed artifacts, and several
 * tolerances below exist because of specific measured drift rather than caution:
 *
 * - `player_stats.fouls_committed` and `fouls_per_90` are **null on all 564 rows**
 *   while `PlayerStat` types both as `number`.
 * - `player_stats.fpl_ownership` is null on 67 of 564.
 * - `matches[].referee` is null on some fixtures and a string on others.
 * - `latest.predictions[].shap_features` is `[]` on 10/10 and `odds_comparison`
 *   is `null` on 10/10 — the explainability and live-odds stages never ran.
 * - `table[].logo_url` is absent on all 20 rows, which is *legal*: the interface
 *   declares it optional.
 *
 * None of those is a reason to reject a file. All of them are reasons not to trust
 * a cast.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  countOr0, isRecord, mapKept, optArray, optBoolean, optNumber, optString,
  Problems, reqArray, reqNumber, reqRecord, reqString,
} from "@/lib/data/check";
import { parseFeed, type MessageFeed } from "@/lib/fpl-messages";
import {
  DAY, explainabilityIsEmpty, h2hIsEmpty, healthIsEmpty, matchesAreEmpty,
  playerStatsAreEmpty, tableIsEmpty,
  type Descriptor, type OpaqueDescriptor,
} from "@/lib/data/registry";
import { toFraction, type Fraction } from "@/lib/data/units";

// ─────────────────────────────────────────────────────────────────────────────
// table.json
// ─────────────────────────────────────────────────────────────────────────────

export interface Standing {
  readonly position: number;
  readonly team: string;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  readonly gf: number;
  readonly ga: number;
  readonly gd: number;
  readonly points: number;
  readonly form: readonly string[];
  readonly logo_url: string | null;
}

export function narrowTable(raw: unknown): NarrowResult<readonly Standing[]> {
  const problems = new Problems();
  const rows = reqArray(raw, "table", problems);
  if (!rows) return malformed(problems.all);

  const kept = mapKept(rows, "table", problems, (item, i) => {
    const row = reqRecord(item, `table[${i}]`, problems);
    if (!row) return null;
    // Required: the page's control flow depends on all of these. `played` in
    // particular decides whether zones render at all.
    const position = reqNumber(row.position, `table[${i}].position`, problems);
    const team = reqString(row.team, `table[${i}].team`, problems);
    const played = reqNumber(row.played, `table[${i}].played`, problems);
    if (position === null || team === null || played === null) return null;
    return {
      position, team, played,
      won: countOr0(row.won),
      drawn: countOr0(row.drawn),
      lost: countOr0(row.lost),
      gf: countOr0(row.gf),
      ga: countOr0(row.ga),
      gd: countOr0(row.gd),
      points: countOr0(row.points),
      // Only W/D/L are renderable; anything else is dropped rather than shown as
      // a mystery glyph.
      form: optArray(row.form).filter(
        (f): f is string => f === "W" || f === "D" || f === "L",
      ),
      logo_url: optString(row.logo_url),
    } satisfies Standing;
  });

  if (problems.any) return malformed(problems.all);
  return narrowed(kept);
}

// ─────────────────────────────────────────────────────────────────────────────
// matches.json
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchRow {
  readonly match_id: string;
  readonly date: string;
  readonly home_team: string;
  readonly away_team: string;
  readonly model_prediction: string;
  readonly confidence_pct: number;
  readonly referee: string | null;
  readonly is_derby: boolean | null;
  readonly n_value_bets: number | null;
}

export interface MatchesFile {
  readonly gameweek: number;
  readonly season: string | null;
  readonly generated_at: string | null;
  readonly matches: readonly MatchRow[];
}

export function narrowMatches(raw: unknown): NarrowResult<MatchesFile> {
  const problems = new Problems();
  const file = reqRecord(raw, "matches.json", problems);
  if (!file) return malformed(problems.all);

  const gameweek = reqNumber(file.gameweek, "gameweek", problems);
  const list = reqArray(file.matches, "matches", problems);
  if (gameweek === null || !list) return malformed(problems.all);

  const matches = mapKept(list, "matches", problems, (item, i) => {
    const row = reqRecord(item, `matches[${i}]`, problems);
    if (!row) return null;
    const match_id = reqString(row.match_id, `matches[${i}].match_id`, problems);
    const home_team = reqString(row.home_team, `matches[${i}].home_team`, problems);
    const away_team = reqString(row.away_team, `matches[${i}].away_team`, problems);
    const model_prediction = reqString(
      row.model_prediction, `matches[${i}].model_prediction`, problems,
    );
    if (!match_id || !home_team || !away_team || !model_prediction) return null;
    return {
      match_id, home_team, away_team, model_prediction,
      date: optString(row.date) ?? "",
      confidence_pct: countOr0(row.confidence_pct),
      // Null on some fixtures, a string on others. Referee-conditioned card
      // models degrade gracefully by design, so absence is expected.
      referee: optString(row.referee),
      is_derby: optBoolean(row.is_derby),
      n_value_bets: optNumber(row.n_value_bets),
    } satisfies MatchRow;
  });

  if (problems.any) return malformed(problems.all);
  return narrowed({
    gameweek,
    season: optString(file.season),
    generated_at: optString(file.generated_at),
    matches,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// player_stats.json
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayerRow {
  readonly name: string;
  readonly team: string;
  readonly minutes: number;
  readonly goals: number;
  readonly assists: number;
  readonly xg: number;
  readonly xa: number;
  /** Null on all 564 rows in the committed file. Never coerced to 0. */
  readonly fouls_committed: number | null;
  readonly fouls_per_90: number | null;
  /** Null on 67 of 564. */
  readonly fpl_ownership: number | null;
  readonly fpl_price: number | null;
  readonly form: number | null;
  /**
   * True when per-90 columns are meaningful.
   *
   * Derived here rather than in the page, because the arithmetic is a trap:
   * `xg_per_90` is `xg / max(minutes / 90, 0.1)`, so a 0-minute player reads as
   * `xg * 10` — a fabricated rate rendered in the same column as measured ones.
   */
  readonly ratesAreMeaningful: boolean;
}

/** Minutes below which a per-90 rate is an artefact of the denominator floor. */
export const MIN_MINUTES_FOR_RATES = 90;

export function narrowPlayerStats(raw: unknown): NarrowResult<readonly PlayerRow[]> {
  const problems = new Problems();
  const rows = reqArray(raw, "player_stats", problems);
  if (!rows) return malformed(problems.all);

  const kept = mapKept(rows, "player_stats", problems, (item, i) => {
    const row = reqRecord(item, `player_stats[${i}]`, problems);
    if (!row) return null;
    const name = reqString(row.name, `player_stats[${i}].name`, problems);
    const minutes = reqNumber(row.minutes, `player_stats[${i}].minutes`, problems);
    if (name === null || minutes === null) return null;
    return {
      name, minutes,
      team: optString(row.team) ?? "",
      goals: countOr0(row.goals),
      assists: countOr0(row.assists),
      xg: countOr0(row.xg ?? row.expected_goals),
      xa: countOr0(row.xa ?? row.expected_assists),
      // Preserved as null. Coercing to 0 would report "committed no fouls" for a
      // stat the provider simply did not supply — and 564 rows of confident zero
      // is a more convincing lie than 564 blanks.
      fouls_committed: optNumber(row.fouls_committed),
      fouls_per_90: optNumber(row.fouls_per_90),
      fpl_ownership: optNumber(row.fpl_ownership),
      fpl_price: optNumber(row.fpl_price),
      form: optNumber(row.form),
      ratesAreMeaningful: minutes >= MIN_MINUTES_FOR_RATES,
    } satisfies PlayerRow;
  });

  if (problems.any) return malformed(problems.all);
  return narrowed(kept);
}

// ─────────────────────────────────────────────────────────────────────────────
// health.json
// ─────────────────────────────────────────────────────────────────────────────

export interface CalibrationBin {
  readonly bin_center: number;
  readonly predicted_mean: number;
  readonly actual_mean: number;
  readonly count: number;
}

export interface Health {
  readonly last_updated: string | null;
  readonly gameweek: number | null;
  readonly n_predictions: number;
  readonly status: string;
  readonly pipeline_version: string | null;
  readonly forecast_validation_status: string | null;
  readonly model_metrics: Readonly<Record<string, number>>;
  readonly calibration_bins: readonly CalibrationBin[];
  readonly odds_source: string | null;
}

export function narrowHealth(raw: unknown): NarrowResult<Health> {
  const problems = new Problems();
  const file = reqRecord(raw, "health.json", problems);
  if (!file) return malformed(problems.all);

  const status = reqString(file.status, "status", problems);
  if (status === null) return malformed(problems.all);

  // Only finite numbers survive. A metric arriving as null must not become 0,
  // which would read as a perfect score.
  const metrics: Record<string, number> = {};
  const rawMetrics = file.model_metrics;
  if (rawMetrics && typeof rawMetrics === "object" && !Array.isArray(rawMetrics)) {
    for (const [key, value] of Object.entries(rawMetrics)) {
      const n = optNumber(value);
      if (n !== null) metrics[key] = n;
    }
  }

  const calibration = file.calibration;
  const binsRaw =
    calibration && typeof calibration === "object" && !Array.isArray(calibration)
      ? optArray((calibration as Record<string, unknown>).bins)
      : [];
  const calibration_bins = binsRaw.flatMap((item): CalibrationBin[] => {
    if (!item || typeof item !== "object") return [];
    const bin = item as Record<string, unknown>;
    const bin_center = optNumber(bin.bin_center);
    const predicted_mean = optNumber(bin.predicted_mean);
    const actual_mean = optNumber(bin.actual_mean);
    if (bin_center === null || predicted_mean === null || actual_mean === null) {
      return [];
    }
    return [{ bin_center, predicted_mean, actual_mean, count: countOr0(bin.count) }];
  });

  return narrowed({
    status,
    last_updated: optString(file.last_updated),
    gameweek: optNumber(file.gameweek),
    n_predictions: countOr0(file.n_predictions),
    // Not optional-by-accident: this is the field whose absence made the 4.0.0
    // drift invisible, so it is read explicitly and surfaced as provenance.
    pipeline_version: optString(file.pipeline_version),
    forecast_validation_status: optString(file.forecast_validation_status),
    model_metrics: metrics,
    calibration_bins,
    odds_source: optString(file.odds_source),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// latest.json — the big one. Narrowed to what the app reads, not to everything.
// ─────────────────────────────────────────────────────────────────────────────

export interface Bet {
  readonly market: string;
  readonly selection: string | null;
  readonly edge: number;
  readonly model_prob: number;
  readonly implied_prob: number;
  readonly decimal_odds: number | null;
  readonly bookmaker: string | null;
  /**
   * Whether this edge has the bookmaker's margin removed.
   *
   * `edge = model_prob - implied_prob` (kelly.py:258), so the edge is only honest
   * if `implied_prob` was de-vigged first. Measured on the live artifact, that
   * varies BY MARKET: the three 1X2 bets carry `implied_prob != raw_implied_prob`
   * and are de-vigged, while both Over 2.5 Goals bets have them identical — so
   * their 5.6% and 8.3% edges still include the book's cut.
   *
   * Null when the artifact omits `raw_implied_prob` and the question cannot be
   * answered either way. Never assumed true: an overstated edge drives an
   * oversized stake, and this is the one screen where that costs money.
   */
  readonly devigged: boolean | null;
  /** `1x2`, `over_under`, `btts`, `corners`, `cards`, `goalscorer`, … */
  readonly market_type: string | null;
  /**
   * The pipeline's own banding of the edge.
   *
   * Reads `confidence_tier` then falls back to `confidence`: the 1X2 path writes
   * both and the totals path writes only the latter, so keying on one alone
   * silently loses half the bets from a tier filter.
   */
  readonly confidence: string | null;
  /**
   * Half-Kelly as a FRACTION of bankroll, resolved through the fallback chain.
   *
   * Null when no usable stake could be derived, which a caller must render as
   * "no stake" rather than as zero-and-therefore-safe. The pipeline's
   * `half_kelly`/`full_kelly` currency fields are deliberately NOT carried here:
   * they are a stake against a hardcoded 1000.0 bankroll, not the user's.
   * See lib/data/units.ts.
   */
  readonly halfKelly: Fraction | null;
}

export interface Prediction {
  readonly match_id: string;
  readonly home_team: string;
  readonly away_team: string;
  /** From `fixture.gameweek`. Null when the writer omits it. */
  readonly gameweek: number | null;
  readonly kickoff: string | null;
  readonly prob_home: number;
  readonly prob_draw: number;
  readonly prob_away: number;
  /**
   * Expected goals per side, or null when the model published none.
   *
   * Null rather than `{home: 0, away: 0}`: a 0-0 expectation is a real forecast
   * and a missing one is not, and rendering "xG 0.0 — 0.0" for the second would
   * be the same class of lie as the all-zero league table.
   */
  readonly expected_goals: { readonly home: number; readonly away: number } | null;
  readonly value_bets: readonly Bet[];
  readonly shap_features: readonly { name: string; value: number }[];
  readonly has_odds_comparison: boolean;
}

export interface Latest {
  readonly gameweek: number | null;
  readonly season: string | null;
  readonly generated_at: string | null;
  readonly pipeline_version: string | null;
  /**
   * Ensemble weights per model, or null when stacking did not run.
   *
   * `null` in the committed file. An empty object would say "stacking ran and
   * assigned nothing", which is a different claim and would chart as an axis
   * with no bars rather than an honest "no stacking weights published".
   */
  readonly stacking_weights: Readonly<Record<string, number>> | null;
  /**
   * How the run was configured, for `/health`.
   *
   * `n_simulations` is worth distrusting: the committed file says 5000 in
   * metadata while eight of ten predictions carry 2000. The narrower reports
   * what the writer wrote; reconciling the two is a pipeline fix, not a
   * rendering one.
   */
  readonly metadata: {
    readonly calibrated: boolean | null;
    readonly models: readonly string[];
    readonly sub_models: readonly string[];
    readonly n_simulations: number | null;
    readonly odds_source: string | null;
    readonly ensemble_method: string | null;
  };
  readonly predictions: readonly Prediction[];
}

/**
 * Half-Kelly fraction from a raw bet, preferring the least ambiguous source.
 *
 * The chain is `half_kelly_pct` -> `full_kelly_pct / 2` -> legacy `kelly_pct / 2`,
 * mirroring `getHalfKellyPct` in predictions.ts, whose legacy branch is retained
 * because under-staking is recoverable and over-staking is not.
 *
 * Every candidate goes through `toFraction`, which rejects anything outside
 * `[0, 1]` — so a currency amount landing in one of these fields yields null
 * rather than a stake of 5000% of bankroll.
 */
export function halfKellyOf(bet: Record<string, unknown>): Fraction | null {
  const half = toFraction(bet.half_kelly_pct);
  if (half !== null) return half;
  const full = toFraction(bet.full_kelly_pct);
  if (full !== null) return toFraction(full / 2);
  const legacy = toFraction(bet.kelly_pct);
  if (legacy !== null) return toFraction(legacy / 2);
  return null;
}

/**
 * Whether a bet's edge has the vig removed, or null if unknowable.
 *
 * Compares the implied probability actually used against the raw one. Equal means
 * no de-vig was applied; different means it was. An absent `raw_implied_prob`
 * yields null rather than a guess.
 */
export function devigStatusOf(bet: Record<string, unknown>): boolean | null {
  const implied = optNumber(bet.implied_prob);
  const raw = optNumber(bet.raw_implied_prob);
  if (implied === null || raw === null) return null;
  // Float comparison with a tolerance: these are two computed doubles, and an
  // exact `!==` would report rounding noise as a de-vig.
  return Math.abs(implied - raw) > 1e-9;
}

/**
 * Value bets from a raw list, dropping anything without a market.
 *
 * Exported so `/matches/[id]` uses the same path rather than re-deriving stakes.
 * `halfKellyOf` runs every candidate through `toFraction`, which rejects values
 * outside [0, 1] — duplicating this logic is how a currency amount ends up
 * rendered as a percentage of bankroll.
 */
export function narrowBets(raw: unknown): Bet[] {
  return optArray(raw).flatMap((b): Bet[] => {
    if (!b || typeof b !== "object") return [];
    const bet = b as Record<string, unknown>;
    const market = optString(bet.market);
    if (market === null) return [];
    return [{
      market,
      selection: optString(bet.selection),
      edge: countOr0(bet.edge),
      model_prob: countOr0(bet.model_prob),
      implied_prob: countOr0(bet.implied_prob),
      decimal_odds: optNumber(bet.decimal_odds),
      bookmaker: optString(bet.bookmaker),
      devigged: devigStatusOf(bet),
      market_type: optString(bet.market_type),
      confidence: optString(bet.confidence_tier) ?? optString(bet.confidence),
      halfKelly: halfKellyOf(bet),
    }];
  });
}

function stringList(raw: unknown): string[] {
  return optArray(raw).filter((v): v is string => typeof v === "string");
}

/** Numeric weights, or null when the block is absent or carries none. */
function weightsOf(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    const n = optNumber(value);
    if (n !== null) out[name] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function narrowLatest(raw: unknown): NarrowResult<Latest> {
  const problems = new Problems();
  const file = reqRecord(raw, "latest.json", problems);
  if (!file) return malformed(problems.all);

  const metadata = reqRecord(file.metadata, "metadata", problems);
  const list = reqArray(file.predictions, "predictions", problems);
  if (!metadata || !list) return malformed(problems.all);

  const predictions = mapKept(list, "predictions", problems, (item, i) => {
    const row = reqRecord(item, `predictions[${i}]`, problems);
    if (!row) return null;

    const fixture = reqRecord(row.fixture, `predictions[${i}].fixture`, problems);
    const probs = reqRecord(
      row.probabilities, `predictions[${i}].probabilities`, problems,
    );
    if (!fixture || !probs) return null;

    const home_team = reqString(
      fixture.home_team, `predictions[${i}].fixture.home_team`, problems,
    );
    const away_team = reqString(
      fixture.away_team, `predictions[${i}].fixture.away_team`, problems,
    );
    if (!home_team || !away_team) return null;

    const oneXTwo = probs["1x2"];
    const trio = oneXTwo && typeof oneXTwo === "object"
      ? (oneXTwo as Record<string, unknown>)
      : {};

    // Both sides required: half an expected scoreline is not one, and a
    // rendered "1.4 — 0.0" would read as a shut-out prediction.
    const xg = isRecord(row.expected_goals) ? row.expected_goals : null;
    const xgHome = xg ? optNumber(xg.home) : null;
    const xgAway = xg ? optNumber(xg.away) : null;

    return {
      home_team, away_team,
      match_id: optString(row.match_id) ?? optString(fixture.match_id) ?? `${i}`,
      gameweek: optNumber(fixture.gameweek),
      kickoff: optString(fixture.date) ?? optString(fixture.kickoff),
      expected_goals:
        xgHome !== null && xgAway !== null ? { home: xgHome, away: xgAway } : null,
      prob_home: countOr0(trio.home),
      prob_draw: countOr0(trio.draw),
      prob_away: countOr0(trio.away),
      value_bets: narrowBets(row.value_bets),
      // `[]` on 10/10 in the committed file, and legal: an empty array is a valid
      // ShapFeature[]. The emptiness predicate, not the narrower, is what makes
      // the page say so.
      shap_features: optArray(row.shap_features).flatMap(
        (f): { name: string; value: number }[] => {
          if (!f || typeof f !== "object") return [];
          const feat = f as Record<string, unknown>;
          const name = optString(feat.feature) ?? optString(feat.name);
          const value = optNumber(feat.value ?? feat.shap_value);
          return name !== null && value !== null ? [{ name, value }] : [];
        },
      ),
      has_odds_comparison: row.odds_comparison != null,
    } satisfies Prediction;
  });

  if (problems.any) return malformed(problems.all);
  return narrowed({
    gameweek: optNumber(metadata.gameweek),
    season: optString(metadata.season),
    generated_at: optString(metadata.generated_at),
    pipeline_version: optString(metadata.pipeline_version),
    stacking_weights: weightsOf(metadata.stacking_weights),
    metadata: {
      calibrated: optBoolean(metadata.calibrated),
      models: stringList(metadata.models),
      sub_models: stringList(metadata.sub_models),
      n_simulations: optNumber(metadata.n_simulations),
      odds_source: optString(metadata.odds_source),
      ensemble_method: optString(metadata.ensemble_method),
    },
    predictions,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// h2h.json
// ─────────────────────────────────────────────────────────────────────────────

export interface H2HGame {
  readonly season: string | null;
  readonly home_team: string | null;
  readonly away_team: string | null;
  readonly home_goals: number;
  readonly away_goals: number;
}

export interface H2HEntry {
  readonly key: string;
  readonly matches: readonly H2HGame[];
}

export function narrowH2H(raw: unknown): NarrowResult<readonly H2HEntry[]> {
  const problems = new Problems();
  const rows = reqArray(raw, "h2h", problems);
  if (!rows) return malformed(problems.all);

  const kept = mapKept(rows, "h2h", problems, (item, i) => {
    const row = reqRecord(item, `h2h[${i}]`, problems);
    if (!row) return null;
    const home = optString(row.home_team);
    const away = optString(row.away_team);
    return {
      key: home && away ? `${home}|${away}` : `h2h[${i}]`,
      matches: optArray(row.matches).flatMap((m): H2HGame[] => {
        if (!m || typeof m !== "object") return [];
        const game = m as Record<string, unknown>;
        return [{
          season: optString(game.season),
          home_team: optString(game.home_team),
          away_team: optString(game.away_team),
          home_goals: countOr0(game.home_goals),
          away_goals: countOr0(game.away_goals),
        }];
      }),
    } satisfies H2HEntry;
  });

  if (problems.any) return malformed(problems.all);
  return narrowed(kept);
}

// ─────────────────────────────────────────────────────────────────────────────
// fpl/messages.json — the agent's only channel to the human
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delegates to `lib/fpl-messages.ts`, which already implements exactly the
 * discipline this layer is built on: `parseFeed` keeps every message it can read
 * and drops only the ones it cannot, rather than failing the whole feed. That
 * matters because a corrupt feed used to silence the agent permanently.
 *
 * So this narrower never reports `malformed` for content reasons — only for a
 * payload that is not a feed at all.
 */
export function narrowMessages(raw: unknown): NarrowResult<MessageFeed> {
  const problems = new Problems();
  if (raw !== null && raw !== undefined && !isRecord(raw) && !Array.isArray(raw)) {
    problems.add(`messages.json is ${typeof raw}, expected a feed object or array`);
    return malformed(problems.all);
  }
  return narrowed(parseFeed(raw));
}

// ─────────────────────────────────────────────────────────────────────────────
// market_blend_weight.json — the only fitted evidence that exists
// ─────────────────────────────────────────────────────────────────────────────

export interface BlendWeight {
  readonly parameter: string;
  readonly generated_at: string | null;
  readonly n_matches: number;
  readonly n_rounds: number;
  readonly devig_method: string | null;
  readonly primary_loss: string | null;
  readonly headline: string | null;
  readonly recommendation: string | null;
  readonly caveats: readonly string[];
  readonly weight_grid: readonly number[];
}

export function narrowBlendWeight(raw: unknown): NarrowResult<BlendWeight> {
  const problems = new Problems();
  const file = reqRecord(raw, "market_blend_weight.json", problems);
  if (!file) return malformed(problems.all);

  const parameter = reqString(file.parameter, "parameter", problems);
  const n_matches = reqNumber(file.n_matches, "n_matches", problems);
  if (parameter === null || n_matches === null) return malformed(problems.all);

  return narrowed({
    parameter,
    n_matches,
    generated_at: optString(file.generated_at),
    n_rounds: countOr0(file.n_rounds),
    devig_method: optString(file.devig_method),
    primary_loss: optString(file.primary_loss),
    // Prose the page must render verbatim rather than paraphrase: the fit could
    // not distinguish 0.55 from the argmin, and the caveats are where that is
    // said. Summarising them would overstate the evidence.
    headline: optString(file.headline),
    recommendation: optString(file.recommendation),
    caveats: optArray(file.caveats).filter((c): c is string => typeof c === "string"),
    weight_grid: optArray(file.weight_grid).filter(
      (w): w is number => typeof w === "number" && Number.isFinite(w),
    ),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// fixture_xg.json — per-fixture goal rates, with the market anchor
// ─────────────────────────────────────────────────────────────────────────────

export interface FixtureRate {
  readonly gameweek: number;
  readonly home_team: string;
  readonly away_team: string;
  readonly home_rate: number;
  readonly away_rate: number;
  /** Which source set these rates. Never inferred; absence is its own answer. */
  readonly rate_source: string | null;
}

export interface FixtureXg {
  readonly generated_at: string | null;
  readonly current_gameweek: number | null;
  readonly fixtures: readonly FixtureRate[];
}

export function narrowFixtureXg(raw: unknown): NarrowResult<FixtureXg> {
  const problems = new Problems();
  const file = reqRecord(raw, "fixture_xg.json", problems);
  if (!file) return malformed(problems.all);

  const list = reqArray(file.fixtures ?? file.rows, "fixtures", problems);
  if (!list) return malformed(problems.all);

  const fixtures = mapKept(list, "fixtures", problems, (item, i) => {
    const row = reqRecord(item, `fixtures[${i}]`, problems);
    if (!row) return null;
    const home_team = reqString(row.home_team, `fixtures[${i}].home_team`, problems);
    const away_team = reqString(row.away_team, `fixtures[${i}].away_team`, problems);
    const home_rate = reqNumber(row.home_rate ?? row.home_xg, `fixtures[${i}].home_rate`, problems);
    const away_rate = reqNumber(row.away_rate ?? row.away_xg, `fixtures[${i}].away_rate`, problems);
    if (!home_team || !away_team || home_rate === null || away_rate === null) return null;
    return {
      home_team, away_team, home_rate, away_rate,
      gameweek: countOr0(row.gameweek),
      rate_source: optString(row.rate_source),
    } satisfies FixtureRate;
  });

  if (problems.any) return malformed(problems.all);
  return narrowed({
    generated_at: optString(file.generated_at),
    current_gameweek: optNumber(file.current_gameweek),
    fixtures,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// fpl/deltas.jsonl — what changed, and whether it changes what you should do
// ─────────────────────────────────────────────────────────────────────────────

export interface DeltaTrigger {
  readonly source: string;
  readonly source_tier: number;
  readonly claimed_at: string | null;
  readonly quote: string | null;
  readonly url: string | null;
}

export interface DeltaRecord {
  readonly kind: "resolution_change" | "decision_impact";
  readonly delta_id: string;
  readonly observed_at: string | null;
  readonly gameweek: number;
  // resolution_change
  readonly element_id: number | null;
  readonly player_name: string | null;
  readonly club: string | null;
  readonly claim_type: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly why_material: string | null;
  readonly rule_applied: string | null;
  readonly trigger: DeltaTrigger | null;
  // decision_impact
  readonly entry_label: string | null;
  readonly root_move_before: string | null;
  readonly root_move_after: string | null;
  readonly flipped: boolean;
  readonly ev_cost_of_inaction: number | null;
  readonly xp_moved: readonly {
    element_id: number; before: number | null; after: number | null;
  }[];
}

export interface DeltaFeed {
  readonly records: readonly DeltaRecord[];
  /**
   * Resolution changes with no impact record yet.
   *
   * A real state, not a loading state: the poller emits the change within fifteen
   * minutes and the agent fills in the decision half at its own cadence, because
   * the MILP needs scipy and the poller does not install it. The UI says "impact
   * not yet assessed" rather than hiding the news until it is complete.
   */
  readonly awaitingImpact: readonly string[];
}

/**
 * Newline-delimited JSON, read as TEXT.
 *
 * `res.json()` throws on the second line of a JSONL body, so the loader must not
 * use it — `format: "jsonl"` on the descriptor is what tells it so. A malformed
 * line is skipped rather than fatal, matching the Python side: a shortened delta
 * log costs a duplicate notification, whereas a shortened *claim* history silently
 * changes a projection and therefore raises.
 */
export function narrowDeltas(raw: unknown): NarrowResult<DeltaFeed> {
  const problems = new Problems();
  if (typeof raw !== "string") {
    problems.add(`deltas.jsonl is ${typeof raw}, expected text`);
    return malformed(problems.all);
  }

  const records: DeltaRecord[] = [];
  let unreadable = 0;
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      unreadable += 1;
      continue;
    }
    if (!isRecord(parsed)) { unreadable += 1; continue; }

    const kind = optString(parsed.kind);
    const deltaId = optString(parsed.delta_id);
    if ((kind !== "resolution_change" && kind !== "decision_impact") || !deltaId) {
      unreadable += 1;
      continue;
    }

    const rootMove = isRecord(parsed.root_move) ? parsed.root_move : {};
    const captain = isRecord(parsed.captain) ? parsed.captain : {};
    const triggerRaw = isRecord(parsed.trigger) ? parsed.trigger : null;

    records.push({
      kind,
      delta_id: deltaId,
      observed_at: optString(parsed.observed_at),
      gameweek: countOr0(parsed.gameweek),
      element_id: optNumber(parsed.element_id),
      player_name: optString(parsed.player_name),
      club: optString(parsed.club),
      claim_type: optString(parsed.claim_type),
      before: parsed.before ?? null,
      after: parsed.after ?? null,
      why_material: optString(parsed.why_material),
      rule_applied: optString(parsed.rule_applied),
      trigger: triggerRaw ? {
        source: optString(triggerRaw.source) ?? "unknown",
        source_tier: countOr0(triggerRaw.source_tier),
        claimed_at: optString(triggerRaw.claimed_at),
        quote: optString(triggerRaw.quote),
        url: optString(triggerRaw.url),
      } : null,
      entry_label: optString(parsed.entry_label),
      root_move_before: optString(rootMove.before),
      root_move_after: optString(rootMove.after),
      flipped: optBoolean(rootMove.flipped) ?? false,
      ev_cost_of_inaction: optNumber(parsed.ev_cost_of_inaction),
      xp_moved: optArray(parsed.xp_moved).flatMap((row) => {
        if (!isRecord(row)) return [];
        const element = optNumber(row.element_id);
        if (element === null) return [];
        // before/after stay nullable: a player absent from one artifact is
        // unknown, and 0.0 would read as a total collapse.
        return [{
          element_id: element,
          before: optNumber(row.before),
          after: optNumber(row.after),
        }];
      }),
    });
    void captain;
  }

  if (unreadable > 0) {
    // Reported, not raised. The feed is still usable and silence would hide rot.
    problems.add(`skipped ${unreadable} unreadable line(s)`);
  }

  const impacted = new Set(
    records.filter((r) => r.kind === "decision_impact").map((r) => r.delta_id),
  );
  const awaiting = records
    .filter((r) => r.kind === "resolution_change" && !impacted.has(r.delta_id))
    .map((r) => r.delta_id);

  return narrowed({ records, awaitingImpact: awaiting });
}

// ─────────────────────────────────────────────────────────────────────────────
// fpl/evidence_view.json — why a number is what it is, and what it beat
// ─────────────────────────────────────────────────────────────────────────────

export interface EvidenceClaim {
  readonly claim_id: string;
  readonly source: string;
  readonly source_tier: number;
  readonly claim_type: string;
  readonly value: unknown;
  /** When the SOURCE said it. Recency is judged on this, not on observed_at. */
  readonly claimed_at: string | null;
  readonly observed_at: string | null;
  readonly quote: string | null;
  readonly url: string | null;
  readonly verdict: "won" | "lost" | "dropped";
  /** The rule that beat it, for a loser. */
  readonly beaten_by: string | null;
}

export interface EvidenceEntry {
  readonly claim_type: string;
  readonly resolved_value: unknown;
  readonly rule: string | null;
  readonly n_conflicts: number;
  readonly unresolved: boolean;
  readonly escalation: string | null;
  readonly claims: readonly EvidenceClaim[];
}

export interface EvidencePlayer {
  readonly element_id: number;
  readonly player_name: string;
  readonly club: string;
  readonly entries: readonly EvidenceEntry[];
  readonly total_conflicts: number;
  readonly needs_attention: boolean;
}

export interface EvidenceView {
  readonly generated_at: string | null;
  readonly gameweek: number | null;
  readonly players: readonly EvidencePlayer[];
  /**
   * How much of the store this view omits.
   *
   * Without it a short list is ambiguous between "little to report" and "the
   * export broke", which is the same absent-versus-empty confusion the whole
   * envelope exists to remove — one level up.
   */
  readonly shown: number;
  readonly resolved: number;
  readonly escalations: number;
}

const VERDICTS = new Set(["won", "lost", "dropped"]);

export function narrowEvidenceView(raw: unknown): NarrowResult<EvidenceView> {
  const problems = new Problems();
  const file = reqRecord(raw, "evidence_view.json", problems);
  if (!file) return malformed(problems.all);

  const list = reqArray(file.players, "players", problems);
  if (!list) return malformed(problems.all);

  const players = mapKept(list, "players", problems, (item, i) => {
    const row = reqRecord(item, `players[${i}]`, problems);
    if (!row) return null;
    const element_id = reqNumber(row.element_id, `players[${i}].element_id`, problems);
    if (element_id === null) return null;

    const entries = optArray(row.entries).flatMap((e): EvidenceEntry[] => {
      if (!isRecord(e)) return [];
      const claim_type = optString(e.claim_type);
      if (claim_type === null) return [];
      return [{
        claim_type,
        resolved_value: e.resolved_value ?? null,
        rule: optString(e.rule),
        n_conflicts: countOr0(e.n_conflicts),
        unresolved: optBoolean(e.unresolved) ?? false,
        escalation: optString(e.escalation),
        claims: optArray(e.claims).flatMap((c): EvidenceClaim[] => {
          if (!isRecord(c)) return [];
          const claim_id = optString(c.claim_id);
          const source = optString(c.source);
          const verdict = optString(c.verdict);
          // A claim with no verdict cannot be placed in the tree — rendering it
          // as neither winner nor loser would misrepresent the adjudication.
          if (!claim_id || !source || !verdict || !VERDICTS.has(verdict)) return [];
          return [{
            claim_id, source,
            source_tier: countOr0(c.source_tier),
            claim_type: optString(c.claim_type) ?? claim_type,
            value: c.value ?? null,
            claimed_at: optString(c.claimed_at),
            observed_at: optString(c.observed_at),
            quote: optString(c.quote),
            url: optString(c.url),
            verdict: verdict as EvidenceClaim["verdict"],
            beaten_by: optString(c.beaten_by),
          }];
        }),
      }];
    });

    return {
      element_id,
      player_name: optString(row.player_name) ?? `Player ${element_id}`,
      club: optString(row.club) ?? "",
      entries,
      total_conflicts: countOr0(row.total_conflicts),
      needs_attention: optBoolean(row.needs_attention) ?? false,
    } satisfies EvidencePlayer;
  });

  if (problems.any) return malformed(problems.all);

  const counts = isRecord(file.counts) ? file.counts : {};
  return narrowed({
    generated_at: optString(file.generated_at),
    gameweek: optNumber(file.gameweek),
    players,
    shown: countOr0(counts.n_players_shown),
    resolved: countOr0(counts.n_players_resolved),
    escalations: countOr0(counts.n_escalations),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// fpl/decision_public_gw{NN}_{label}.json — the agent's proposal
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisionPlan {
  readonly squad: readonly number[];
  readonly xi: readonly number[];
  readonly captain: number | null;
  readonly vice: number | null;
  readonly transfers_in: readonly number[];
  readonly transfers_out: readonly number[];
  readonly hits: number;
  readonly bank_after: number;
}

export interface PublicDecision {
  readonly gameweek: number;
  readonly entry_label: string;
  readonly objective: string | null;
  readonly generated_at: string | null;
  /**
   * The deadline this advice is about.
   *
   * Load-bearing, and absent from every decision published before this was fixed:
   * the consumer read `String(source.deadline ?? "")`, so `Date.parse("")` was NaN
   * and EVERY proposal classified "ready" — the expired branch was unreachable
   * code. A decision past its deadline is not merely old, it is wrong.
   */
  readonly deadline: string | null;
  readonly plan: DecisionPlan | null;
  readonly mean_points: number | null;
  readonly optimism_gap: number | null;
  readonly credible_margin: boolean;
  readonly warnings: readonly string[];
  readonly xp_snapshot: Readonly<Record<string, number>>;
}

function narrowPlan(raw: unknown): DecisionPlan | null {
  if (!isRecord(raw)) return null;
  const ints = (v: unknown) =>
    optArray(v).filter((n): n is number => typeof n === "number");
  return {
    squad: ints(raw.squad),
    xi: ints(raw.xi),
    captain: optNumber(raw.captain),
    vice: optNumber(raw.vice),
    transfers_in: ints(raw.transfers_in),
    transfers_out: ints(raw.transfers_out),
    hits: countOr0(raw.hits),
    bank_after: countOr0(raw.bank_after),
  };
}

export function narrowPublicDecision(raw: unknown): NarrowResult<PublicDecision> {
  const problems = new Problems();
  const file = reqRecord(raw, "decision_public", problems);
  if (!file) return malformed(problems.all);

  const gameweek = reqNumber(file.gameweek, "gameweek", problems);
  const entry_label = reqString(file.entry_label, "entry_label", problems);
  if (gameweek === null || entry_label === null) return malformed(problems.all);

  const decision = isRecord(file.decision) ? file.decision : {};
  const snapshot: Record<string, number> = {};
  if (isRecord(file.xp_snapshot)) {
    for (const [key, value] of Object.entries(file.xp_snapshot)) {
      const n = optNumber(value);
      if (n !== null) snapshot[key] = n;
    }
  }

  return narrowed({
    gameweek,
    entry_label,
    objective: optString(file.objective),
    generated_at: optString(file.generated_at),
    deadline: optString(file.deadline),
    plan: narrowPlan(decision.plan),
    mean_points: optNumber(decision.mean_points),
    optimism_gap: optNumber(file.optimism_gap),
    credible_margin: optBoolean(file.credible_margin) ?? false,
    warnings: optArray(file.warnings).filter(
      (w): w is string => typeof w === "string",
    ),
    xp_snapshot: snapshot,
  });
}

/** The two mandates, as `pipeline/config.py::FPL_ENTRIES` names them. */
export const ENTRY_LABELS = ["season", "weekly"] as const;
export type EntryLabel = (typeof ENTRY_LABELS)[number];

/**
 * A descriptor for one entry's decision in one gameweek.
 *
 * Built per call because the path carries the gameweek — the registry holds only
 * static paths. Deliberately NOT a `decision_latest.json`: that name was fetched
 * by the old page, staged by one workflow, excluded by another, and **written by
 * nothing**, so the page could never render and the private decisions were
 * discarded every run.
 */
export function decisionDescriptor(
  gameweek: number, label: EntryLabel,
): Descriptor<PublicDecision> {
  const padded = String(gameweek).padStart(2, "0");
  return {
    key: `decision:${label}:${padded}`,
    path: `fpl/decision_public_gw${padded}_${label}.json`,
    owner: "agent",
    describes: `the ${label} team's proposal for GW${gameweek}`,
    // A proposal is advice about one deadline; freshness is judged on that
    // deadline by the consumer, not on a byte age.
    freshnessBudgetMs: null,
    narrow: narrowPublicDecision,
    producedAtOf: (v) => v.generated_at,
    isEmpty: (v) => v.plan === null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The descriptor table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every artifact the app may fetch.
 *
 * Each entry keeps its own payload type — `REGISTRY.table` is a
 * `Descriptor<readonly Standing[]>`, not a `Descriptor<any>`. An earlier draft
 * funnelled them through a `Descriptor<any>` helper to make the record
 * homogeneous, which typechecked and quietly erased every payload type in the
 * app: `proven(load(REGISTRY.table))` came back `any`, so the layer built to
 * replace `res.json() as T` reintroduced exactly the same hole one level up.
 *
 * `unpublished: true` marks a path no workflow writes yet. The paths test fails
 * on any path that is neither published nor explicitly marked, so a phantom
 * filename — `decision_latest.json`, which nothing has ever written — cannot be
 * added silently again.
 */
export const REGISTRY = {
  table: ({
    key: "table",
    path: "table.json",
    owner: "daily",
    describes: "the Premier League table",
    freshnessBudgetMs: 2 * DAY,
    narrow: narrowTable,
    isEmpty: tableIsEmpty,
  }) satisfies Descriptor<readonly Standing[]>,

  matches: ({
    key: "matches",
    path: "matches.json",
    owner: "daily",
    describes: "this gameweek's fixtures and headline calls",
    freshnessBudgetMs: DAY,
    narrow: narrowMatches,
    producedAtOf: (v) => v.generated_at,
    isEmpty: matchesAreEmpty,
  }) satisfies Descriptor<MatchesFile>,

  playerStats: ({
    key: "playerStats",
    path: "player_stats.json",
    owner: "daily",
    describes: "season player statistics",
    freshnessBudgetMs: 2 * DAY,
    narrow: narrowPlayerStats,
    isEmpty: playerStatsAreEmpty,
  }) satisfies Descriptor<readonly PlayerRow[]>,

  health: ({
    key: "health",
    path: "health.json",
    owner: "daily",
    describes: "model calibration and pipeline status",
    freshnessBudgetMs: 2 * DAY,
    narrow: narrowHealth,
    producedAtOf: (v) => v.last_updated,
    producerVersionOf: (v) => v.pipeline_version,
    isEmpty: healthIsEmpty,
  }) satisfies Descriptor<Health>,

  latest: ({
    key: "latest",
    path: "latest.json",
    owner: "daily",
    describes: "match probabilities, value bets and explanations",
    freshnessBudgetMs: DAY,
    narrow: narrowLatest,
    producedAtOf: (v) => v.generated_at,
    producerVersionOf: (v) => v.pipeline_version,
    // Partial emptiness: the probability payload is real, the SHAP and
    // odds-comparison panels are not. See explainabilityIsEmpty.
    isEmpty: explainabilityIsEmpty,
  }) satisfies Descriptor<Latest>,

  h2h: ({
    key: "h2h",
    path: "h2h.json",
    owner: "daily",
    describes: "head-to-head history",
    // A historical record does not go off.
    freshnessBudgetMs: null,
    narrow: narrowH2H,
    isEmpty: h2hIsEmpty,
  }) satisfies Descriptor<readonly H2HEntry[]>,

  messages: ({
    key: "messages",
    path: "fpl/messages.json",
    owner: "agent",
    describes: "what the agent needs to tell you",
    // The agent runs 3-hourly, so a feed older than a day means it has stopped.
    freshnessBudgetMs: DAY,
    narrow: narrowMessages,
    producedAtOf: (v) => v.generatedAt ?? null,
    // An empty feed is the NORMAL state and must not read as a failure: the agent
    // publishes nothing when it has nothing to say.
    isEmpty: (v) => v.messages.length === 0,
  }) satisfies Descriptor<MessageFeed>,

  blendWeight: ({
    key: "blendWeight",
    path: "market_blend_weight.json",
    owner: "daily",
    describes: "the fitted market blend weight and its caveats",
    // A fit does not go off; it is superseded.
    freshnessBudgetMs: null,
    narrow: narrowBlendWeight,
    producedAtOf: (v) => v.generated_at,
    isEmpty: (v) => v.n_matches === 0,
  }) satisfies Descriptor<BlendWeight>,

  fixtureXg: ({
    key: "fixtureXg",
    path: "fixture_xg.json",
    owner: "daily",
    describes: "per-fixture goal rates and the market anchor",
    freshnessBudgetMs: DAY,
    narrow: narrowFixtureXg,
    producedAtOf: (v) => v.generated_at,
    isEmpty: (v) => v.fixtures.length === 0,
  }) satisfies Descriptor<FixtureXg>,

  deltas: ({
    key: "deltas",
    path: "fpl/deltas.jsonl",
    owner: "news",
    describes: "what changed since you last looked",
    // The poller runs every 15 minutes inside a news window and republishes on
    // any change, so a feed older than a few hours during a window means it has
    // stopped. Generous because outside a window nothing is written at all.
    freshnessBudgetMs: 12 * 60 * 60_000,
    format: "jsonl",
    narrow: narrowDeltas,
    // An empty feed is the NORMAL state: most of the season nothing has changed
    // since you last looked, and that must not read as a broken page.
    isEmpty: (v) => v.records.length === 0,
  }) satisfies Descriptor<DeltaFeed>,

  evidence: ({
    key: "evidence",
    path: "fpl/evidence_view.json",
    owner: "agent",
    describes: "why each availability number is what it is",
    // Rewritten on every 3-hourly refresh.
    freshnessBudgetMs: 12 * 60 * 60_000,
    narrow: narrowEvidenceView,
    producedAtOf: (v) => v.generated_at,
    // Nobody flagged is the good outcome, and must not read as a broken export.
    isEmpty: (v) => v.players.length === 0,
  }) satisfies Descriptor<EvidenceView>,
} as const;

export type RegistryKey = keyof typeof REGISTRY;

/**
 * Metadata view over the registry, for iteration.
 *
 * `OpaqueDescriptor` rather than `Descriptor<unknown>`: see that type's note. The
 * payload-consuming members are absent by design, so a test that needs to
 * classify an artifact has to reach for the keyed entry and keep its real type.
 */
export const ALL_DESCRIPTORS: readonly OpaqueDescriptor[] =
  Object.values(REGISTRY);
