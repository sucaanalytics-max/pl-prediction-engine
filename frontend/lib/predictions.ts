/**
 * Load and parse prediction JSON files.
 * In production, these are committed by GitHub Actions and served as static files.
 */

export interface Fixture {
  date: string;
  home_team: string;
  away_team: string;
  gameweek: number;
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

export interface CorrectScoreGrid {
  grid: number[][];
}

export interface ShapFeature {
  feature: string;
  value: number;
  shap_value: number;
}

export interface ValueBet {
  market: string;
  selection: string;
  model_prob: number;
  implied_prob: number;
  decimal_odds: number;
  edge: number;
  kelly_pct: number;
  half_kelly_pct: number;
  confidence: string;
}

export interface MatchPrediction {
  match_id: string;
  fixture: Fixture;
  probabilities: {
    "1x2": Probabilities1X2;
    over_under: Record<string, OverUnder>;
    btts: number;
    correct_score: CorrectScoreGrid;
    corners: { over_under: Record<string, OverUnder> };
    cards: { over_under: Record<string, OverUnder> };
    asian_handicap: Record<string, { home: number; away: number }>;
    ht_ft: Record<string, number>;
  };
  expected_goals: { home: number; away: number };
  expected_corners: number;
  expected_cards: number;
  distributions: {
    goals_home: number[];
    goals_away: number[];
    total_goals: number[];
    total_corners: number[];
    total_cards: number[];
  };
  shap_features: ShapFeature[];
  value_bets: ValueBet[];
  confidence: {
    entropy: number;
    credible_interval_90: [number, number];
  };
  narrative: string;
}

export interface PredictionData {
  metadata: {
    generated_at: string;
    season: string;
    gameweek: number;
    pipeline_version: string;
    models: string[];
    n_simulations: number;
    calibrated: boolean;
  };
  predictions: MatchPrediction[];
}

export interface MatchSummary {
  match_id: string;
  date: string;
  home_team: string;
  away_team: string;
  model_prediction: string;
  confidence_pct: number;
}

export interface HealthData {
  last_updated: string;
  gameweek: number;
  n_predictions: number;
  status: string;
  model_metrics: Record<string, number>;
  calibration: {
    bins: Array<{
      bin_center: number;
      predicted_mean: number;
      actual_mean: number;
      count: number;
    }>;
  };
}

const BASE_PATH = "/predictions";

export async function loadPredictions(): Promise<PredictionData> {
  const res = await fetch(`${BASE_PATH}/latest.json`);
  if (!res.ok) throw new Error("Failed to load predictions");
  return res.json();
}

export async function loadMatches(): Promise<{ matches: MatchSummary[]; gameweek: number }> {
  const res = await fetch(`${BASE_PATH}/matches.json`);
  if (!res.ok) throw new Error("Failed to load matches");
  return res.json();
}

export async function loadHealth(): Promise<HealthData> {
  const res = await fetch(`${BASE_PATH}/health.json`);
  if (!res.ok) throw new Error("Failed to load health data");
  return res.json();
}

export function getMatchById(
  predictions: PredictionData,
  matchId: string
): MatchPrediction | undefined {
  return predictions.predictions.find((p) => p.match_id === matchId);
}

export function getAllValueBets(predictions: PredictionData): Array<ValueBet & { match_id: string; home_team: string; away_team: string }> {
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
