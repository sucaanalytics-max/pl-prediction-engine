import type { Position, SquadPlayer } from "./fpl-portal";

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

export interface FplProjectionPlayer {
  elementId: number;
  name: string;
  team: string;
  position: Position;
  price: number;
  ownership: number;
  eliteOwnership: number | null;
  status: string;
  expectedMinutes: number;
  projected4: number;
  projected6: number;
  projected10: number;
  valueScore: number;
  gameweekProjections: FplRankedPlayer["gameweekProjections"];
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

export interface FplEvidenceItem {
  elementId: number;
  player: string;
  team: string;
  position: Position;
  price: number;
  ownership: number;
  status: string;
  chanceOfPlaying: number | null;
  headline: string;
  observedAt: string;
  sourceUpdatedAt: string | null;
  severity: "critical" | "warning" | "monitor";
  scope: "squad" | "target" | "league";
  sources: Array<{
    label: string;
    url: string;
    role: "primary" | "cross-check";
  }>;
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
    players: FplProjectionPlayer[];
    caveats: string[];
  };
  rankings: FplTopTenRankings;
  recommendations: {
    transfers4: FplTransferRecommendation[];
    transfers6: FplTransferRecommendation[];
    multiTransferPlans4: FplTransferPlan[];
    multiTransferPlans6: FplTransferPlan[];
    captaincyPlan: FplCaptainWeek[];
    captaincyPool: FplRankedPlayer[];
    modelVersion: string;
    provisional: true;
    methodology: string[];
  };
  evidence: {
    generatedAt: string;
    officialRefreshMinutes: 15;
    items: FplEvidenceItem[];
    caveats: string[];
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
