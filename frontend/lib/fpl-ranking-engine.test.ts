import type { FplModelPlayerInput } from "./fpl-ranking-engine";
import {
  buildCaptaincyPlan,
  buildMultiTransferPlans,
  buildTopTenRankings,
  recommendTransfers,
  scoreFplPlayers,
} from "./fpl-ranking-engine";

function player(
  overrides: Partial<FplModelPlayerInput> & Pick<FplModelPlayerInput, "elementId" | "name">
): FplModelPlayerInput {
  const { elementId, name, ...rest } = overrides;
  return {
    elementId,
    name,
    team: "AAA",
    position: "MID",
    price: 7,
    ownership: 12,
    status: "a",
    chanceOfPlaying: null,
    news: "",
    fixtures: [1, 2, 3, 4, 5, 6].map((gameweek) => ({
      gameweek,
      label: `BBB (H)`,
      difficulty: 2,
      kickoffTime: null,
    })),
    epNext: 0,
    form: 0,
    pointsPerGame: 0,
    totalPoints: 0,
    minutes: 0,
    ictIndex: 0,
    ...rest,
  };
}

describe("FPL ranking engine", () => {
  it("uses FPLReview weekly points and expected minutes without clamping", () => {
    const scored = scoreFplPlayers([
      player({
        elementId: 99,
        name: "Premium projection",
        reviewProjection: {
          exportedAt: "2026-08-04T12:04:03Z",
          buyValue: 9,
          sellValue: 9,
          eliteOwnership: 17.5,
          gameweeks: Array.from({ length: 10 }, (_, index) => ({
            gameweek: index + 1,
            expectedMinutes: index === 0 ? 93 : 90,
            projectedPoints: index + 1,
          })),
        },
      }),
    ])[0];

    expect(scored.modelBasis).toBe("fplreview_snapshot");
    expect(scored.expectedMinutes).toBe(93);
    expect(scored.projected4).toBe(10);
    expect(scored.projected6).toBe(21);
    expect(scored.projected10).toBe(55);
    expect(scored.eliteOwnership).toBe(17.5);
  });

  it("overlays official injury news only when it is newer than the snapshot", () => {
    const scored = scoreFplPlayers([
      player({
        elementId: 100,
        name: "Newly flagged",
        status: "d",
        chanceOfPlaying: 50,
        newsUpdatedAt: "2026-08-05T00:00:00Z",
        reviewProjection: {
          exportedAt: "2026-08-04T12:04:03Z",
          buyValue: 7,
          sellValue: 7,
          eliteOwnership: 5,
          gameweeks: Array.from({ length: 10 }, (_, index) => ({
            gameweek: index + 1,
            expectedMinutes: 90,
            projectedPoints: 6,
          })),
        },
      }),
    ])[0];

    expect(scored.expectedMinutes).toBe(45);
    expect(scored.gameweekProjections[0].projectedPoints).toBe(3);
    expect(scored.gameweekProjections[1].projectedPoints).toBe(6);
  });

  it("creates ten-player category lists and excludes low-availability players", () => {
    const inputs = Array.from({ length: 14 }, (_, index) =>
      player({
        elementId: index + 1,
        name: `Player ${index + 1}`,
        price: 5 + index / 2,
        ownership: index,
        status: index === 13 ? "i" : "a",
      })
    );

    const rankings = buildTopTenRankings(scoreFplPlayers(inputs));

    expect(rankings.overall).toHaveLength(10);
    expect(rankings.overall.some((candidate) => candidate.name === "Player 14")).toBe(false);
    expect(rankings.differentials.every((candidate) => candidate.ownership <= 10)).toBe(true);
  });

  it("only recommends affordable same-position legal upgrades", () => {
    const squadInputs = [
      player({ elementId: 1, name: "Current", team: "AAA", price: 6 }),
      player({ elementId: 2, name: "Club mate 1", team: "CCC", position: "DEF" }),
      player({ elementId: 3, name: "Club mate 2", team: "CCC", position: "FWD" }),
      player({ elementId: 4, name: "Club mate 3", team: "CCC", position: "GKP" }),
    ];
    const candidates = [
      player({ elementId: 10, name: "Upgrade", team: "BBB", price: 6.5, epNext: 6 }),
      player({ elementId: 11, name: "Too expensive", team: "DDD", price: 8.5, epNext: 8 }),
      player({ elementId: 12, name: "Wrong position", team: "EEE", position: "FWD", epNext: 8 }),
      player({ elementId: 13, name: "Fourth club player", team: "CCC", epNext: 8 }),
    ];
    const squad = scoreFplPlayers(squadInputs);
    const recommendations = recommendTransfers({
      squad,
      allPlayers: [...squad, ...scoreFplPlayers(candidates)],
      bank: 0.5,
      horizon: 6,
    });

    expect(
      recommendations
        .filter((move) => move.playerOut.name === "Current")
        .map((move) => move.playerIn.name)
    ).toEqual(["Upgrade"]);
    expect(recommendations.every((move) => move.playerIn.position === move.playerOut.position)).toBe(true);
    expect(recommendations.every((move) => move.bankAfter >= 0)).toBe(true);
    expect(recommendations.some((move) => move.playerIn.name === "Fourth club player")).toBe(false);
  });

  it("builds affordable legal two- and three-transfer squad plans", () => {
    const squadInputs = [
      player({ elementId: 1, name: "GK current", position: "GKP", team: "AAA", price: 5 }),
      player({ elementId: 2, name: "DEF current", position: "DEF", team: "BBB", price: 5 }),
      player({ elementId: 3, name: "MID current", position: "MID", team: "CCC", price: 6 }),
      player({ elementId: 4, name: "FWD current", position: "FWD", team: "DDD", price: 6 }),
    ];
    const upgrades = [
      player({ elementId: 11, name: "GK upgrade", position: "GKP", team: "EEE", price: 5, epNext: 6 }),
      player({ elementId: 12, name: "DEF upgrade", position: "DEF", team: "FFF", price: 5, epNext: 6 }),
      player({ elementId: 13, name: "MID upgrade", position: "MID", team: "GGG", price: 6, epNext: 7 }),
      player({ elementId: 14, name: "FWD upgrade", position: "FWD", team: "HHH", price: 6, epNext: 7 }),
    ];
    const squad = scoreFplPlayers(squadInputs);
    const plans = buildMultiTransferPlans({
      squad,
      allPlayers: [...squad, ...scoreFplPlayers(upgrades)],
      bank: 0,
      horizon: 6,
    });

    expect(plans.some((plan) => plan.transferCount === 2)).toBe(true);
    expect(plans.some((plan) => plan.transferCount === 3)).toBe(true);
    expect(plans.every((plan) => plan.bankAfter >= 0)).toBe(true);
    expect(
      plans.every((plan) =>
        plan.moves.every((move) => move.playerOut.position === move.playerIn.position)
      )
    ).toBe(true);
    expect(
      plans.every((plan) => {
        const outgoing = new Set(plan.moves.map((move) => move.playerOut.elementId));
        const incoming = new Set(plan.moves.map((move) => move.playerIn.elementId));
        return (
          outgoing.size === plan.moves.length &&
          incoming.size === plan.moves.length &&
          [...outgoing].every((elementId) => !incoming.has(elementId))
        );
      })
    ).toBe(true);
  });

  it("builds a six-week captain plan with a different-club vice captain", () => {
    const scored = scoreFplPlayers([
      player({ elementId: 1, name: "Premium A", team: "AAA", price: 14, epNext: 8 }),
      player({ elementId: 2, name: "Premium B", team: "BBB", price: 12, epNext: 7 }),
      player({ elementId: 3, name: "Premium C", team: "AAA", price: 11, epNext: 6 }),
    ]);

    const plan = buildCaptaincyPlan(scored, 1);

    expect(plan).toHaveLength(6);
    expect(
      plan.every((week) => week.captain.team !== week.viceCaptain.team)
    ).toBe(true);
    expect(plan.every((week) => week.projectedCaptainPoints > 0)).toBe(true);
  });
});
