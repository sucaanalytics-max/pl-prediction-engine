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
    btts: number;
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
    return (
      all.find(
        (r) =>
          (r.home_team === homeTeam && r.away_team === awayTeam) ||
          (r.home_team === awayTeam && r.away_team === homeTeam)
      ) ?? null
    );
  } catch (err) {
    console.error("Failed to load H2H:", err);
    return null;
  }
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

/** Get half-Kelly stake percentage (handles both pipeline v1 and v2 field names) */
export function getHalfKellyPct(bet: ValueBet): number {
  return bet.half_kelly_pct ?? bet.kelly_pct ?? 0;
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
