/**
 * Load and parse prediction JSON files.
 * In production, these are committed by GitHub Actions and served as static files.
 */

export interface Fixture {
  date: string;
  home_team: string;
  away_team: string;
  gameweek: number;
  referee?: string;
  is_derby?: boolean;
}

export interface Probabilities1X2 {
  home: number;
  draw: number;
  away: number;
}

export interface OverUnder {
  over: number;
  under: number;
}

export interface BothTeamsToScore {
  yes: number;
  no: number;
}

export interface ShapFeature {
  feature: string;
  value: number;
  shap_value: number;
  shap_abs?: number;
}

export interface ValueBet {
  market: string;
  selection?: string;
  model_prob: number;
  implied_prob: number;
  devigged_prob?: number;
  raw_implied_prob?: number;
  decimal_odds?: number;
  edge: number;
  devigged_edge?: number;
  full_kelly?: number;
  half_kelly?: number;
  full_kelly_pct?: number;
  half_kelly_pct?: number;
  recommendation?: string;
  expected_value?: number;
  bookmaker?: string;
  confidence_tier?: "high" | "medium" | "low";
  // legacy fields
  kelly_pct?: number;
  confidence?: string;
}

export interface PlayerBooking {
  player_id?: number;
  web_name: string;
  team: string;
  base_prob: number;
  adjusted_prob: number;
  expected_cards?: number;
  foul_rate?: number;
}

export interface GoalscorerPrediction {
  player_id: number;
  name: string;
  web_name: string;
  team: string;
  position: string;
  side: "home" | "away";
  lambda_player: number;
  anytime_prob: number;
  two_plus_prob: number;
  first_scorer_prob: number;
  xg_per_90: number;
  goals_scored: number;
  xg_share: number;
  minutes: number;
}

export interface OddsComparison {
  h2h?: Record<string, { home: number; draw: number; away: number }>;
  totals?: Record<
    string,
    {
      over?: number;
      under?: number;
      bookmaker_over?: string;
      bookmaker_under?: string;
    }
  >;
  btts?: {
    yes?: number;
    no?: number;
    bookmaker_yes?: string;
    bookmaker_no?: string;
  };
  bookmaker_home?: string;
  bookmaker_draw?: string;
  bookmaker_away?: string;
}

export interface PlayerStat {
  player_id: number;
  name: string;
  web_name: string;
  team: string;
  position: string;
  minutes: number;
  goals_scored: number;
  assists: number;
  expected_goals: number;
  expected_assists?: number;
  xg_per_90: number;
  goals_per_90: number;
  assists_per_90?: number;
  yellows: number;
  yellows_per_90: number;
  fouls_committed?: number;
  fouls_per_90?: number;
  fpl_price?: number;
  fpl_ownership?: number;
  form?: number;
  available: boolean;
}

export interface MatchPrediction {
  match_id: string;
  fixture: Fixture;
  probabilities: {
    "1x2": Probabilities1X2;
    over_under: Record<string, OverUnder>;
    btts: BothTeamsToScore;
    clean_sheet?: { home: number; away: number };
    // flat dict: {"0-0": prob, "1-0": prob, ...}
    correct_score: Record<string, number>;
    // flat dict: {"home_-2.5": prob, ...}
    asian_handicap: Record<string, number>;
    ht_ft: Record<string, number>;
    // flat dict: {"7.5": {over, under}, ...}
    corners: Record<string, OverUnder>;
    cards: Record<string, OverUnder>;
  };
  expected_goals: { home: number; away: number };
  expected_corners: number;
  expected_cards: number;
  distributions: {
    goals_home: number[];
    goals_away: number[];
    corners?: number[];
    cards?: number[];
    total_goals?: number[];
    total_corners?: number[];
    total_cards?: number[];
  };
  player_bookings?: {
    top_bookings: PlayerBooking[];
    adjustments?: Record<string, number>;
  };
  goalscorer?: {
    home_scorers: GoalscorerPrediction[];
    away_scorers: GoalscorerPrediction[];
    top_scorers: GoalscorerPrediction[];
    match_xg?: { home: number; away: number };
  };
  odds_comparison?: OddsComparison;
  model_disagreement?: number;
  shap_features: ShapFeature[];
  value_bets: ValueBet[];
  confidence?: {
    entropy: number;
    home_goals_ci?: [number, number];
    away_goals_ci?: [number, number];
  };
  n_simulations?: number;
  narrative: string;
}

export interface PredictionData {
  metadata: {
    generated_at: string;
    season: string;
    gameweek: number;
    pipeline_version: string;
    models: string[];
    sub_models?: string[];
    n_simulations: number;
    calibrated: boolean;
    odds_source?: string;
    referee_profiles_count?: number;
    stacking_weights?: Record<string, number>;
    ensemble_method?: string;
  };
  predictions: MatchPrediction[];
}

export interface MatchSummary {
  match_id: string;
  date: string;
  home_team: string;
  away_team: string;
  referee?: string;
  is_derby?: boolean;
  model_prediction: string;
  confidence_pct: number;
  n_value_bets?: number;
}

export interface HealthData {
  last_updated: string;
  gameweek: number;
  n_predictions: number;
  status: string;
  forecast_validation_status?: "collecting" | "evaluated";
  model_metrics?: Record<string, number>;
  calibration?: {
    bins: Array<{
      bin_center: number;
      predicted_mean: number;
      actual_mean: number;
      count: number;
    }>;
  };
}

export interface TeamStanding {
  position: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  form: string[]; // last 5: 'W' | 'D' | 'L'
  logo_url?: string;
}

export interface H2HMatch {
  date: string;
  home_team?: string;
  away_team?: string;
  home_goals: number;
  away_goals: number;
  season: string;
}

export interface H2HRecord {
  home_team: string;
  away_team: string;
  home_wins: number;
  draws: number;
  away_wins: number;
  matches: H2HMatch[];
}

export interface HistoricalStatPlayer {
  name: string;
  team: string;
  value: number;
}

export interface HistoricalTopPerformer {
  name: string;
  team: string;
  points: number;
  bonus: number;
  bps: number;
  xg: number;
  xa: number;
  minutes: number;
}

export interface HistoricalMatchEvents {
  fixtureId: number;
  season: string;
  date: string;
  kickoffTime: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  scorers: HistoricalStatPlayer[];
  assists: HistoricalStatPlayer[];
  ownGoals: HistoricalStatPlayer[];
  yellowCards: HistoricalStatPlayer[];
  redCards: HistoricalStatPlayer[];
  saves: HistoricalStatPlayer[];
  penaltiesSaved: HistoricalStatPlayer[];
  penaltiesMissed: HistoricalStatPlayer[];
  bonus: HistoricalStatPlayer[];
  xgLeaders: HistoricalStatPlayer[];
  xaLeaders: HistoricalStatPlayer[];
  topPerformers: HistoricalTopPerformer[];
  source: {
    label: string;
    url: string;
    attribution: string;
  };
}

export interface HistoricalMatchEventsFile {
  schemaVersion: 1;
  generatedAt: string;
  caveats: string[];
  records: Record<string, HistoricalMatchEvents>;
}

const getBasePath = () =>
  process.env.NEXT_PUBLIC_SUPABASE_URL
    ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/predictions`
    : "/predictions";

async function fetchWithFallback<T>(filename: string): Promise<T> {
  const basePath = getBasePath();

  if (basePath !== "/predictions") {
    try {
      // Create a 5-second timeout for Supabase
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${basePath}/${filename}`, {
        next: { revalidate: 3600 },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        return await res.json();
      }
      console.warn(`Supabase fetch failed (${res.status}) for ${filename}, falling back to local.`);
    } catch (err) {
      console.warn(`Supabase fetch error for ${filename}, falling back to local:`, err);
    }
  }

  // Fallback to local /predictions directory
  const localRes = await fetch(`/predictions/${filename}`, { next: { revalidate: 3600 } });
  if (!localRes.ok) throw new Error(`Failed to load ${filename} locally (${localRes.status})`);
  return await localRes.json();
}

export async function loadPredictions(): Promise<PredictionData> {
  return fetchWithFallback<PredictionData>("latest.json");
}

export async function loadMatches(): Promise<{ matches: MatchSummary[]; gameweek: number }> {
  return fetchWithFallback<{ matches: MatchSummary[]; gameweek: number }>("matches.json");
}

export async function loadHealth(): Promise<HealthData> {
  return fetchWithFallback<HealthData>("health.json");
}

export async function loadPlayerStats(): Promise<PlayerStat[]> {
  return fetchWithFallback<PlayerStat[]>("player_stats.json");
}

export async function loadTable(): Promise<TeamStanding[]> {
  return fetchWithFallback<TeamStanding[]>("table.json");
}

export async function loadH2H(homeTeam: string, awayTeam: string): Promise<H2HRecord | null> {
  try {
    const all = await fetchWithFallback<H2HRecord[]>("h2h.json");
    const found =
      all.find(
        (record) =>
          (record.home_team === homeTeam && record.away_team === awayTeam) ||
          (record.home_team === awayTeam && record.away_team === homeTeam)
      ) ?? null;
    if (!found || found.home_team === homeTeam) return found;
    return {
      ...found,
      home_team: homeTeam,
      away_team: awayTeam,
      home_wins: found.away_wins,
      away_wins: found.home_wins,
    };
  } catch (err) {
    console.error("Failed to load H2H:", err);
    return null;
  }
}

function canonicalTeam(value: string) {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = {
    manchesterunited: "manutd",
    manunited: "manutd",
    manchestercity: "mancity",
    nottinghamforest: "nottmforest",
    sheffieldunited: "sheffieldutd",
    tottenhamhotspur: "spurs",
    tottenham: "spurs",
    wolverhamptonwanderers: "wolves",
  };
  return aliases[compact] ?? compact;
}

export async function loadH2HEvents(
  homeTeam: string,
  awayTeam: string
): Promise<HistoricalMatchEventsFile | null> {
  try {
    const pairSlug = [canonicalTeam(homeTeam), canonicalTeam(awayTeam)]
      .sort()
      .join("--");
    return await fetchWithFallback<HistoricalMatchEventsFile>(
      `h2h-events/${pairSlug}.json`
    );
  } catch {
    return null;
  }
}

export function findHistoricalMatchEvents(
  file: HistoricalMatchEventsFile | null,
  match: H2HMatch,
  fallbackHome: string,
  fallbackAway: string
) {
  if (!file) return null;
  const homeTeam = match.home_team ?? fallbackHome;
  const awayTeam = match.away_team ?? fallbackAway;
  const key = [
    match.season,
    match.date.slice(0, 10),
    canonicalTeam(homeTeam),
    canonicalTeam(awayTeam),
  ].join("|");
  return file.records[key] ?? null;
}

export function getMatchById(
  predictions: PredictionData,
  matchId: string
): MatchPrediction | undefined {
  return predictions.predictions.find((p) => p.match_id === matchId);
}

export function getAllValueBets(
  predictions: PredictionData
): Array<ValueBet & { match_id: string; home_team: string; away_team: string }> {
  const bets: Array<ValueBet & { match_id: string; home_team: string; away_team: string }> = [];
  for (const pred of predictions.predictions) {
    for (const bet of pred.value_bets) {
      bets.push({
        ...bet,
        match_id: pred.match_id,
        home_team: pred.fixture.home_team,
        away_team: pred.fixture.away_team,
      });
    }
  }
  return bets.sort((a, b) => b.edge - a.edge);
}

/** Convert flat correct_score dict {"0-0": prob, ...} to a 2D grid[home][away] */
export function correctScoreToGrid(
  correctScore: Record<string, number>,
  maxGoals = 6
): number[][] {
  const grid: number[][] = Array.from({ length: maxGoals + 1 }, () =>
    new Array(maxGoals + 1).fill(0)
  );
  for (const [key, prob] of Object.entries(correctScore)) {
    const parts = key.split("-");
    if (parts.length !== 2) continue;
    const h = parseInt(parts[0], 10);
    const a = parseInt(parts[1], 10);
    if (h <= maxGoals && a <= maxGoals && !isNaN(h) && !isNaN(a)) {
      grid[h][a] = prob;
    }
  }
  return grid;
}

/**
 * Half-Kelly stake percentage, handling both pipeline v1 and v2 field names.
 *
 * Staking is real money, so an ambiguous input must never produce a larger
 * stake than intended. The current pipeline emits the explicit `half_kelly_pct`
 * and `full_kelly_pct` (see `pipeline/risk/kelly.py`); the legacy `kelly_pct`
 * does not say which fraction it holds. Because a bare "kelly" conventionally
 * means the *full* fraction, it is halved rather than trusted as already-halved
 * — under-staking is recoverable, over-staking is not.
 */
export function getHalfKellyPct(bet: ValueBet): number {
  if (bet.half_kelly_pct !== undefined) return bet.half_kelly_pct;
  if (bet.full_kelly_pct !== undefined) return bet.full_kelly_pct / 2;
  if (bet.kelly_pct !== undefined) {
    console.warn(
      `Ambiguous legacy kelly_pct (${bet.kelly_pct}) for "${bet.market}"; ` +
        "halving it as full-Kelly. Re-export this data with half_kelly_pct."
    );
    return bet.kelly_pct / 2;
  }
  return 0;
}

/** Get market label for display */
export function marketLabel(market: string): string {
  const labels: Record<string, string> = {
    "Home Win": "1X2",
    "Draw": "1X2",
    "Away Win": "1X2",
    "Over 2.5": "Goals O/U",
    "Under 2.5": "Goals O/U",
    "BTTS Yes": "BTTS",
    "BTTS No": "BTTS",
  };
  if (market.includes("Corner")) return "Corners";
  if (market.includes("Card") || market.includes("Booking")) return "Cards";
  if (market.includes("Goalscorer") || market.includes("Anytime") || market.includes("First Goal")) return "Goalscorer";
  if (market.includes("Player")) return "Player";
  return labels[market] ?? "1X2";
}

/** Get market icon character */
export function marketIcon(market: string): string {
  if (market.includes("Corner")) return "⚑";
  if (market.includes("Card") || market.includes("Booking")) return "□";
  if (market.includes("Goalscorer") || market.includes("Anytime") || market.includes("First Goal")) return "⚽";
  if (market.includes("Player")) return "👤";
  return "⚽";
}

/** Get confidence tier from edge value */
export function confidenceTier(edge: number): "high" | "medium" | "low" {
  if (edge >= 0.10) return "high";
  if (edge >= 0.05) return "medium";
  return "low";
}

/** Get the effective edge (devigged if available, raw otherwise) */
export function effectiveEdge(bet: ValueBet): number {
  return bet.devigged_edge ?? bet.edge;
}
