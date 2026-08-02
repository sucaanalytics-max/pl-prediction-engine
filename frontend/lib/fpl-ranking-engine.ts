import type { Position } from "./fpl-portal";
import type {
  FplCaptainWeek,
  FplFixtureView,
  FplRankedPlayer,
  FplTransferPlan,
  FplTransferRecommendation,
} from "./fpl-live";

export interface FplModelPlayerInput {
  elementId: number;
  name: string;
  team: string;
  position: Position;
  price: number;
  ownership: number;
  status: string;
  chanceOfPlaying: number | null;
  news: string;
  fixtures: FplFixtureView[];
  epNext: number;
  form: number;
  pointsPerGame: number;
  totalPoints: number;
  minutes: number;
  ictIndex: number;
}

const POSITION_BASELINE: Record<Position, number> = {
  GKP: 3.35,
  DEF: 3.45,
  MID: 3.75,
  FWD: 3.9,
};

const PRICE_FLOOR: Record<Position, number> = {
  GKP: 4,
  DEF: 4,
  MID: 4.5,
  FWD: 4.5,
};

const DIFFICULTY_MULTIPLIER = [0, 1.28, 1.14, 1, 0.86, 0.72];

function rounded(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function availability(player: FplModelPlayerInput) {
  if (player.status === "a") return 1;
  if (player.chanceOfPlaying !== null) {
    return Math.max(0.1, Math.min(1, player.chanceOfPlaying / 100));
  }
  if (player.status === "d") return 0.65;
  return 0.2;
}

function expectedMinutes(player: FplModelPlayerInput) {
  const availabilityFactor = availability(player);
  const historicMinutes =
    player.minutes > 0
      ? Math.min(90, Math.max(45, (player.minutes / Math.max(1, player.totalPoints)) * 4.5))
      : 82;
  return Math.round(historicMinutes * availabilityFactor);
}

function fixtureProjection(
  base: number,
  fixtures: FplFixtureView[],
  horizon: 4 | 6
) {
  const selected = fixtures.slice(0, horizon);
  if (selected.length === 0) return base * horizon;
  const total = selected.reduce(
    (sum, fixture) => sum + base * DIFFICULTY_MULTIPLIER[fixture.difficulty],
    0
  );
  return total + Math.max(0, horizon - selected.length) * base;
}

export function scoreFplPlayers(
  players: FplModelPlayerInput[]
): FplRankedPlayer[] {
  return players.map((player) => {
    const availabilityFactor = availability(player);
    const priceSignal = Math.min(
      2.3,
      Math.max(0, player.price - PRICE_FLOOR[player.position]) * 0.19
    );
    const ownedSignal = Math.min(0.35, Math.log10(player.ownership + 1) * 0.18);
    const liveSignal =
      player.form > 0 || player.pointsPerGame > 0
        ? player.form * 0.22 + player.pointsPerGame * 0.18
        : 0;
    const officialSignal = player.epNext > 0 ? player.epNext : 0;
    const base =
      officialSignal > 0
        ? officialSignal * 0.58 +
          (POSITION_BASELINE[player.position] + priceSignal + liveSignal) * 0.42
        : POSITION_BASELINE[player.position] + priceSignal + ownedSignal + liveSignal;
    const projected4 = fixtureProjection(base, player.fixtures, 4) * availabilityFactor;
    const projected6 = fixtureProjection(base, player.fixtures, 6) * availabilityFactor;
    const gameweekProjections = player.fixtures.slice(0, 6).map((fixture) => ({
      gameweek: fixture.gameweek,
      fixture: fixture.label,
      difficulty: fixture.difficulty,
      projectedPoints: rounded(
        base * DIFFICULTY_MULTIPLIER[fixture.difficulty] * availabilityFactor
      ),
    }));
    const easyFixtures = player.fixtures
      .slice(0, 6)
      .filter((fixture) => fixture.difficulty <= 2).length;
    const captainScore =
      projected4 * (1 + Math.min(0.18, priceSignal * 0.06)) +
      easyFixtures * 0.45;
    const valueScore = projected6 / Math.max(3.5, player.price);
    const differentialScore =
      projected6 *
      Math.max(0.12, 1 - Math.min(95, player.ownership) / 100) *
      (0.85 + easyFixtures * 0.035);

    return {
      elementId: player.elementId,
      name: player.name,
      team: player.team,
      position: player.position,
      price: player.price,
      ownership: rounded(player.ownership),
      status: player.status,
      chanceOfPlaying: player.chanceOfPlaying,
      news: player.news,
      fixtures: player.fixtures,
      gameweekProjections,
      expectedMinutes: expectedMinutes(player),
      projected4: rounded(projected4),
      projected6: rounded(projected6),
      captainScore: rounded(captainScore, 2),
      valueScore: rounded(valueScore, 2),
      differentialScore: rounded(differentialScore, 2),
      fixtureScore: rounded(
        player.fixtures.slice(0, 6).reduce((sum, fixture) => {
          return sum + (6 - fixture.difficulty);
        }, 0),
        1
      ),
      modelBasis:
        player.epNext > 0 || player.form > 0
          ? "official_form_blend"
          : "preseason_fixture_heuristic",
    };
  });
}

function candidatePool(players: FplRankedPlayer[], horizon: 4 | 6) {
  const projection = (player: FplRankedPlayer) =>
    horizon === 4 ? player.projected4 : player.projected6;
  return (["GKP", "DEF", "MID", "FWD"] as const).flatMap((position) => {
    const positional = players.filter(
      (player) => player.position === position && player.expectedMinutes >= 60
    );
    const byProjection = [...positional]
      .sort((left, right) => projection(right) - projection(left))
      .slice(0, 22);
    const byValue = [...positional]
      .sort((left, right) => right.valueScore - left.valueScore)
      .slice(0, 14);
    return [...new Map([...byProjection, ...byValue].map((player) => [
      player.elementId,
      player,
    ])).values()];
  });
}

export function buildMultiTransferPlans({
  squad,
  allPlayers,
  bank,
  horizon,
}: {
  squad: FplRankedPlayer[];
  allPlayers: FplRankedPlayer[];
  bank: number;
  horizon: 4 | 6;
}): FplTransferPlan[] {
  interface SearchState {
    squad: FplRankedPlayer[];
    bank: number;
    moves: FplTransferPlan["moves"];
    delta4: number;
    delta6: number;
  }

  const pool = candidatePool(allPlayers, horizon);
  let frontier: SearchState[] = [
    { squad, bank, moves: [], delta4: 0, delta6: 0 },
  ];
  const completed: SearchState[] = [];

  for (let depth = 1; depth <= 3; depth += 1) {
    const next = new Map<string, SearchState>();
    for (const state of frontier) {
      const ownedIds = new Set(state.squad.map((player) => player.elementId));
      const clubCounts = state.squad.reduce<Record<string, number>>((counts, player) => {
        counts[player.team] = (counts[player.team] ?? 0) + 1;
        return counts;
      }, {});

      for (let outIndex = 0; outIndex < state.squad.length; outIndex += 1) {
        const playerOut = state.squad[outIndex];
        if (state.moves.some((move) => move.playerIn.elementId === playerOut.elementId)) {
          continue;
        }
        for (const playerIn of pool) {
          if (
            playerIn.position !== playerOut.position ||
            ownedIds.has(playerIn.elementId) ||
            state.moves.some(
              (move) => move.playerOut.elementId === playerIn.elementId
            ) ||
            playerIn.price > playerOut.price + state.bank + 0.001 ||
            (clubCounts[playerIn.team] ?? 0) +
              (playerIn.team === playerOut.team ? 0 : 1) >
              3
          ) {
            continue;
          }

          const nextSquad = [...state.squad];
          nextSquad[outIndex] = playerIn;
          const nextState: SearchState = {
            squad: nextSquad,
            bank: rounded(state.bank + playerOut.price - playerIn.price),
            moves: [...state.moves, { playerOut, playerIn }],
            delta4: rounded(
              state.delta4 + playerIn.projected4 - playerOut.projected4
            ),
            delta6: rounded(
              state.delta6 + playerIn.projected6 - playerOut.projected6
            ),
          };
          const key = nextSquad
            .map((player) => player.elementId)
            .sort((left, right) => left - right)
            .join("-");
          const existing = next.get(key);
          const selectedDelta =
            horizon === 4 ? nextState.delta4 : nextState.delta6;
          const existingDelta = existing
            ? horizon === 4
              ? existing.delta4
              : existing.delta6
            : Number.NEGATIVE_INFINITY;
          if (selectedDelta > existingDelta) next.set(key, nextState);
        }
      }
    }

    frontier = [...next.values()]
      .filter((state) => (horizon === 4 ? state.delta4 : state.delta6) > 0)
      .sort((left, right) => {
        const rightDelta = horizon === 4 ? right.delta4 : right.delta6;
        const leftDelta = horizon === 4 ? left.delta4 : left.delta6;
        return rightDelta - leftDelta || right.bank - left.bank;
      })
      .slice(0, 140);
    if (depth >= 2) completed.push(...frontier.slice(0, 24));
  }

  const uniquePlans = new Map<string, SearchState>();
  for (const state of completed) {
    const key = state.moves
      .map((move) => `${move.playerOut.elementId}:${move.playerIn.elementId}`)
      .sort()
      .join("|");
    if (!uniquePlans.has(key)) uniquePlans.set(key, state);
  }

  const rankedStates = [...uniquePlans.values()].sort((left, right) => {
      const rightDelta = horizon === 4 ? right.delta4 : right.delta6;
      const leftDelta = horizon === 4 ? left.delta4 : left.delta6;
      return rightDelta - leftDelta;
    });
  const balancedStates = [
    ...rankedStates.filter((state) => state.moves.length === 2).slice(0, 6),
    ...rankedStates.filter((state) => state.moves.length === 3).slice(0, 6),
  ].sort((left, right) => {
    const rightDelta = horizon === 4 ? right.delta4 : right.delta6;
    const leftDelta = horizon === 4 ? left.delta4 : left.delta6;
    return rightDelta - leftDelta;
  });

  return balancedStates
    .map((state, index) => {
      const transferCount = state.moves.length as 2 | 3;
      const selectedDelta = horizon === 4 ? state.delta4 : state.delta6;
      return {
        rank: index + 1,
        transferCount,
        moves: state.moves,
        bankAfter: state.bank,
        delta4: state.delta4,
        delta6: state.delta6,
        confidence: Math.round(
          Math.max(50, Math.min(86, 57 + selectedDelta * 1.35 - transferCount * 2))
        ),
        flags: [
          `${transferCount} coordinated moves`,
          state.bank >= 0.5 ? "Keeps budget flexibility" : "Uses full budget",
        ],
      };
    });
}

export function buildCaptaincyPlan(
  players: FplRankedPlayer[],
  gameweek: number
): FplCaptainWeek[] {
  if (!players.length) return [];
  return Array.from({ length: 6 }, (_, offset) => {
    const targetGameweek = gameweek + offset;
    const candidates = players
      .filter((player) => player.expectedMinutes >= 60)
      .map((player) => {
        const projection = player.gameweekProjections.find(
          (item) => item.gameweek === targetGameweek
        );
        const ceilingMultiplier = 1 + Math.min(0.18, Math.max(0, player.price - 7) * 0.025);
        return {
          player,
          fixture: projection?.fixture ?? "TBC",
          projectedPoints: projection?.projectedPoints ?? 0,
          score: (projection?.projectedPoints ?? 0) * ceilingMultiplier,
        };
      })
      .filter((candidate) => candidate.projectedPoints > 0)
      .sort((left, right) => right.score - left.score);
    const captain = candidates[0] ?? {
      player: players[0],
      fixture: "TBC",
      projectedPoints: 0,
      score: 0,
    };
    const vice =
      candidates.find((candidate) => candidate.player.team !== captain.player.team) ??
      candidates[1] ??
      captain;
    const separation = Math.max(0, captain.score - (candidates[1]?.score ?? 0));
    return {
      gameweek: targetGameweek,
      captain: captain.player,
      viceCaptain: vice.player,
      captainFixture: captain.fixture,
      viceFixture: vice.fixture,
      projectedCaptainPoints: rounded(captain.projectedPoints * 2),
      confidence: Math.round(Math.max(52, Math.min(88, 63 + separation * 4))),
    };
  });
}

function topTen(
  players: FplRankedPlayer[],
  score: (player: FplRankedPlayer) => number
) {
  return [...players]
    .filter((player) => player.expectedMinutes >= 45)
    .sort((left, right) => score(right) - score(left))
    .slice(0, 10);
}

export function buildTopTenRankings(players: FplRankedPlayer[]) {
  return {
    overall: topTen(players, (player) => player.projected6),
    captaincy: topTen(players, (player) => player.captainScore),
    value: topTen(players, (player) => player.valueScore),
    differentials: topTen(
      players.filter((player) => player.ownership <= 10),
      (player) => player.differentialScore
    ),
    goalkeepers: topTen(
      players.filter((player) => player.position === "GKP"),
      (player) => player.projected6
    ),
    defenders: topTen(
      players.filter((player) => player.position === "DEF"),
      (player) => player.projected6
    ),
    midfielders: topTen(
      players.filter((player) => player.position === "MID"),
      (player) => player.projected6
    ),
    forwards: topTen(
      players.filter((player) => player.position === "FWD"),
      (player) => player.projected6
    ),
  };
}

export function recommendTransfers({
  squad,
  allPlayers,
  bank,
  horizon,
}: {
  squad: FplRankedPlayer[];
  allPlayers: FplRankedPlayer[];
  bank: number;
  horizon: 4 | 6;
}): FplTransferRecommendation[] {
  const ownedIds = new Set(squad.map((player) => player.elementId));
  const clubCounts = squad.reduce<Record<string, number>>((counts, player) => {
    counts[player.team] = (counts[player.team] ?? 0) + 1;
    return counts;
  }, {});
  const projection = (player: FplRankedPlayer) =>
    horizon === 4 ? player.projected4 : player.projected6;

  const sorted = squad
    .flatMap((playerOut) =>
      allPlayers
        .filter(
          (playerIn) =>
            playerIn.position === playerOut.position &&
            !ownedIds.has(playerIn.elementId) &&
            playerIn.price <= playerOut.price + bank + 0.001 &&
            playerIn.expectedMinutes >= 60 &&
            (clubCounts[playerIn.team] ?? 0) +
              (playerIn.team === playerOut.team ? 0 : 1) <=
              3
        )
        .map((playerIn) => {
          const delta4 = rounded(playerIn.projected4 - playerOut.projected4);
          const delta6 = rounded(playerIn.projected6 - playerOut.projected6);
          const selectedDelta = horizon === 4 ? delta4 : delta6;
          const confidence = Math.round(
            Math.max(
              48,
              Math.min(
                88,
                56 +
                  selectedDelta * 2.4 +
                  Math.min(10, playerIn.expectedMinutes / 12)
              )
            )
          );
          const easyFixtures = playerIn.fixtures
            .slice(0, horizon)
            .filter((fixture) => fixture.difficulty <= 2).length;
          const rationales = [
            `Projects ${selectedDelta >= 0 ? "+" : ""}${selectedDelta.toFixed(1)} points over ${horizon} gameweeks.`,
            `${easyFixtures} favourable fixture${easyFixtures === 1 ? "" : "s"} in the selected run.`,
          ];
          if (playerIn.ownership <= 10) {
            rationales.push(`${playerIn.ownership.toFixed(1)}% ownership adds differential upside.`);
          } else if (playerIn.expectedMinutes >= 80) {
            rationales.push(`Modelled for ${playerIn.expectedMinutes} expected minutes when available.`);
          }

          return {
            rank: 0,
            playerOut,
            playerIn,
            bankAfter: rounded(bank + playerOut.price - playerIn.price),
            delta4,
            delta6,
            horizon,
            confidence,
            rationale: rationales,
            flags: [
              ...(playerIn.modelBasis === "preseason_fixture_heuristic"
                ? ["Preseason estimate"]
                : []),
              ...(playerIn.ownership <= 10 ? ["Differential"] : []),
            ],
          } satisfies FplTransferRecommendation;
        })
    )
    .filter((recommendation) => {
      return horizon === 4 ? recommendation.delta4 > 0.5 : recommendation.delta6 > 0.75;
    })
    .sort((left, right) => {
      const rightScore =
        projection(right.playerIn) -
        projection(right.playerOut) +
        right.confidence / 100;
      const leftScore =
        projection(left.playerIn) -
        projection(left.playerOut) +
        left.confidence / 100;
      return rightScore - leftScore;
    });

  const selected: FplTransferRecommendation[] = [];
  const outgoingCounts = new Map<number, number>();
  const incomingIds = new Set<number>();
  for (const recommendation of sorted) {
    const outgoingId = recommendation.playerOut.elementId;
    if (
      (outgoingCounts.get(outgoingId) ?? 0) >= 3 ||
      incomingIds.has(recommendation.playerIn.elementId)
    ) {
      continue;
    }
    selected.push(recommendation);
    outgoingCounts.set(outgoingId, (outgoingCounts.get(outgoingId) ?? 0) + 1);
    incomingIds.add(recommendation.playerIn.elementId);
    if (selected.length === 10) break;
  }

  return selected.map((recommendation, index) => ({
    ...recommendation,
    rank: index + 1,
  }));
}
