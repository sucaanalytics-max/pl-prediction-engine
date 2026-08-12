/**
 * Moved here from `lib/fpl-portal.ts`, which is gone.
 *
 * That file was 205 lines of hand-typed placeholder data — an invented squad,
 * invented "intelligence" items, and a captaincy plan carrying `confidence: 91`
 * for a pick nobody computed. These two types were the only part of it that was
 * real, and they belong beside the live state that uses them.
 */
export type Position = "GKP" | "DEF" | "MID" | "FWD";

export interface SquadPlayer {
  name: string;
  team: string;
  position: Position;
  price: number;
  fixture: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  status?: "captain" | "vice" | "monitor";
  bench?: boolean;
}

/**
 * The FPL entry this portal describes.
 *
 * Defaults to the portal owner's team (20945). Keep the Python decision agent
 * and this frontend on the same entry; otherwise the site can show one squad
 * while recommending transfers for another manager.
 *
 * Env-driven so the weekly team (2561099, "Wazza") can be viewed without a code
 * change. An entry id is a public identifier, not a secret, so NEXT_PUBLIC_ is
 * correct here.
 */
export const FPL_ENTRY_ID = Number(
  process.env.NEXT_PUBLIC_FPL_ENTRY_ID ?? 20945,
);
export const FPL_API_BASE = "https://fantasy.premierleague.com/api";

export type FplSquadSource =
  | "official_public"
  | "captured_authenticated_draft"
  | "stored_snapshot";

/**
 * One club's run of fixtures, with FPL's official difficulty.
 *
 * Difficulty is FPL's own 1-5 rating, not ours. That is deliberate: it is the scale
 * every manager already reads, and a private scale in the same visual position would
 * be read as the familiar one. Our own fitted goal rates are a separate, labelled
 * view — a different claim deserves a different label.
 */
export interface FplFixtureMatrixRow {
  readonly teamId: number;
  readonly team: string;
  readonly shortName: string;
  readonly fixtures: FplFixtureView[];
  readonly totalDifficulty: number;
  /** Mean over fixtures that EXIST, so a club with a blank stays comparable. */
  readonly meanDifficulty: number;
  readonly played: number;
}

export interface FplFixtureView {
  gameweek: number;
  label: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  kickoffTime: string | null;
}

export interface FplLivePlayer extends SquadPlayer {
  elementId: number;
  pickPosition: number;
  ownership: number;
  chanceOfPlaying: number | null;
  news: string;
  fixtures: FplFixtureView[];
}

export type FplModelBasis =
  | "fplreview_snapshot"
  | "official_form_blend"
  | "preseason_fixture_heuristic";

export interface FplRankedPlayer {
  elementId: number;
  name: string;
  team: string;
  position: Position;
  price: number;
  ownership: number;
  eliteOwnership: number | null;
  status: string;
  chanceOfPlaying: number | null;
  news: string;
  fixtures: FplFixtureView[];
  gameweekProjections: Array<{
    gameweek: number;
    fixture: string;
    difficulty: 1 | 2 | 3 | 4 | 5;
    projectedPoints: number;
  }>;
  expectedMinutes: number;
  projected4: number;
  projected6: number;
  projected10: number;
  captainScore: number;
  valueScore: number;
  differentialScore: number;
  fixtureScore: number;
  modelBasis: FplModelBasis;
}

export interface FplTransferRecommendation {
  rank: number;
  playerOut: FplRankedPlayer;
  playerIn: FplRankedPlayer;
  bankAfter: number;
  delta4: number;
  delta6: number;
  horizon: 4 | 6;
  confidence: number;
  rationale: string[];
  flags: string[];
}

export interface FplTransferPlan {
  rank: number;
  transferCount: 2 | 3;
  moves: Array<{
    playerOut: FplRankedPlayer;
    playerIn: FplRankedPlayer;
  }>;
  bankAfter: number;
  delta4: number;
  delta6: number;
  confidence: number;
  flags: string[];
}

export interface FplCaptainWeek {
  gameweek: number;
  captain: FplRankedPlayer;
  viceCaptain: FplRankedPlayer;
  captainFixture: string;
  viceFixture: string;
  projectedCaptainPoints: number;
  confidence: number;
}

export interface FplTopTenRankings {
  overall: FplRankedPlayer[];
  captaincy: FplRankedPlayer[];
  value: FplRankedPlayer[];
  differentials: FplRankedPlayer[];
  goalkeepers: FplRankedPlayer[];
  defenders: FplRankedPlayer[];
  midfielders: FplRankedPlayer[];
  forwards: FplRankedPlayer[];
}

export interface FplLiveState {
  schemaVersion: 4;
  generatedAt: string;
  season: "2026/27";
  entry: {
    id: number;
    teamName: string;
    managerName: string;
    yearsActive: number;
    overallPoints: number | null;
    overallRank: number | null;
    favouriteTeam: string | null;
  };
  event: {
    id: number;
    name: string;
    deadlineTime: string;
    phase: "preseason" | "live" | "finished";
  };
  /** Every club's next eight fixtures, easiest run first. */
  fixtureMatrix: FplFixtureMatrixRow[];
  squad: {
    source: FplSquadSource;
    sourceLabel: string;
    capturedAt: string;
    isOfficial: boolean;
    players: FplLivePlayer[];
    value: number;
    bank: number | null;
    formation: string;
  };
  freshness: {
    catalog: "live";
    fixtures: "live";
    manager: "live";
    squad: "live" | "captured" | "stored";
    persistence: "saved" | "unconfigured" | "unavailable";
  };
  history: {
    bestRank: number | null;
    bestSeason: string | null;
    latestRank: number | null;
    latestSeason: string | null;
  };
  projections: {
    source: "fplreview_csv_snapshot" | "fallback";
    sourceLabel: string;
    exportedAt: string | null;
    horizonGameweeks: number;
    matchedPlayers: number;
    officialPlayers: number;
    coveragePercent: number;
    caveats: string[];
  };
  rankings: FplTopTenRankings;
  recommendations: {
    transfers4: FplTransferRecommendation[];
    multiTransferPlans4: FplTransferPlan[];
    captaincyPlan: FplCaptainWeek[];
    modelVersion: string;
    provisional: true;
    methodology: string[];
  };
  notices: string[];
}

export interface FplLiveResponse {
  data: FplLiveState;
  persistence: "saved" | "unconfigured" | "unavailable";
}

export function asSquadPlayers(players: FplLivePlayer[]): SquadPlayer[] {
  return players.map(({ name, team, position, price, fixture, difficulty, status, bench }) => ({
    name,
    team,
    position,
    price,
    fixture,
    difficulty,
    status,
    bench,
  }));
}

export function positionFromFpl(value: string): Position {
  if (value === "GKP" || value === "DEF" || value === "MID" || value === "FWD") {
    return value;
  }
  throw new Error(`Unsupported FPL position: ${value}`);
}
