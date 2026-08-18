/**
 * The join, and the four ways it used to be wrong.
 */
import { describe, expect, it } from "vitest";

import { squadBoardPlayers } from "@/lib/control-room/squad";
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";

function pick(over: Partial<SquadPlayer> = {}): SquadPlayer {
  return {
    name: "Wilson", position: "FWD", team: "NEW", price: 7.5,
    fixtures: [], ...over,
  } as SquadPlayer;
}

function projection(over: Partial<Projection> = {}): Projection {
  return {
    elementId: 1, name: "Wilson", team: "NEW", position: "FWD",
    xp: 5, xpSd: 2, mode: 3, pAppears: 0.9, p60: 0.8, eMinutes: 85,
    pGoal: 0.3, pCleanSheet: null, pGe5: 0.4, pGe10: 0.1,
    q10: 1, q25: 2, q50: 4, q75: 7, q90: 10, ...over,
  } as Projection;
}

describe("the join", () => {
  it("matches on element id, so FPL's six Wilsons cannot collide", () => {
    const squad = [pick({ name: "Wilson", elementId: 11 })];
    const projections = [
      projection({ elementId: 99, name: "Wilson", xp: 99 }),
      projection({ elementId: 11, name: "Wilson", xp: 4.2 }),
    ];
    expect(squadBoardPlayers(squad, projections, null).players[0].xp).toBe(4.2);
  });

  it("keeps a pick the projection does not carry, with no number", () => {
    const board = squadBoardPlayers(
      [pick({ elementId: 11 })], [projection({ elementId: 12 })], null,
    );
    expect(board.players).toHaveLength(1);
    expect(board.players[0].xp).toBeNull();
    expect(board.players[0].distribution).toBeNull();
  });

  it("keeps a pick that carries no id at all, rather than guessing a neighbour", () => {
    const board = squadBoardPlayers([pick()], [projection({ xp: 7 })], null);
    expect(board.players).toHaveLength(1);
    expect(board.players[0].xp).toBeNull();
  });
});

describe("the fixture", () => {
  const FIXTURES = [
    { gameweek: 1, label: "BUR (H)", difficulty: 2 },
    { gameweek: 2, label: "MCI (A)", difficulty: 5 },
  ];

  it("comes from THIS gameweek, not from the first in the list", () => {
    const board = squadBoardPlayers(
      [pick({ elementId: 1, fixtures: FIXTURES })], [projection()], 2,
    );
    expect(board.players[0].opponent).toBe("MCI (A)");
    expect(board.players[0].difficulty).toBe(5);
  });

  it("claims no fixture when no gameweek is resolved", () => {
    const board = squadBoardPlayers(
      [pick({ elementId: 1, fixtures: FIXTURES })], [projection()], null,
    );
    expect(board.players[0].opponent).toBeNull();
    expect(board.players[0].difficulty).toBeNull();
  });

  it("claims no fixture for a blank week the player has no entry for", () => {
    const board = squadBoardPlayers(
      [pick({ elementId: 1, fixtures: FIXTURES })], [projection()], 3,
    );
    expect(board.players[0].opponent).toBeNull();
  });
});

describe("the pick's own flags", () => {
  it("reads the armband from the role, and only the two roles", () => {
    const roles = ["captain", "vice", "monitor"] as const;
    expect(
      roles.map((role) =>
        squadBoardPlayers([pick({ role } as Partial<SquadPlayer>)], [], null)
          .players[0].armband),
    ).toEqual(["C", "V", null]);
  });

  it("treats an unstated bench flag as unknown, not as starting", () => {
    /* `SquadPlayer.bench` is optional: a source that does not distinguish starters
       still yields a squad. Coercing undefined to "starting" would invent an XI and
       make the formation counts a claim nobody measured. */
    const board = squadBoardPlayers(
      [pick({ elementId: 1 }), pick({ elementId: 2, bench: true })], [], null,
    );
    expect(board.players.map((p) => p.benched)).toEqual([false, true]);
  });

  it("names a pick it cannot band instead of dropping it", () => {
    const board = squadBoardPlayers(
      [pick({ position: "AM", name: "Nobody" }), pick({ elementId: 1 })], [], null,
    );
    expect(board.unplaced).toEqual(["Nobody"]);
    expect(board.players).toHaveLength(1);
  });

  it("carries the published quantiles through untouched", () => {
    const board = squadBoardPlayers([pick({ elementId: 1 })], [projection()], null);
    expect(board.players[0].distribution).toEqual({
      q10: 1, q25: 2, q50: 4, q75: 7, q90: 10, mean: 5, mode: 3,
    });
  });

  it("returns an empty board for an absent squad, and does not throw", () => {
    for (const squad of [null, undefined, []]) {
      expect(squadBoardPlayers(squad, [projection()], 1))
        .toEqual({ players: [], unplaced: [] });
    }
  });
});
