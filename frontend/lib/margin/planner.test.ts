/**
 * The planner's arithmetic, where being wrong costs the reader real points.
 *
 * Three things are easy to get subtly wrong here and all three are silent:
 *
 * - **Greedy XI selection.** Taking the best players per line independently
 *   produces an illegal team, and an illegal team still renders.
 * - **The captain.** The best XI is not the one with the highest bare sum, it
 *   is the one whose sum plus its own best player is highest, because the
 *   armband doubles. A five-defender shape can beat a three-forward one on
 *   total and lose on the doubled captain.
 * - **Unknowns as zeros.** A player the projection has no view of, scored as
 *   zero, makes every transfer out of him look like a gain.
 */

import { describe, expect, it } from "vitest";
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";
import {
  applyMoves, formationOf, MAX_BANKED_FREE_TRANSFERS, optimiseXi, ownedIn,
  moveDelta, pairRows, playersAcross, pointsFrom, projectedTotal, RULES,
  squadAtWeek, transferCost, transferDelta,
  weeklyLedger, xiProblems,
} from "@/lib/margin/planner";

let nextId = 1;
function player(position: string, price = 5, name = `P${nextId}`): SquadPlayer {
  return {
    name, position, team: "ARS", price, elementId: nextId++,
    bench: undefined, role: undefined, fixture: undefined, fixtures: [],
  };
}

function projection(elementId: number, xp: number | null, over: Partial<Projection> = {}): Projection {
  return {
    elementId, name: `#${elementId}`, team: "ARS", position: "MID",
    xp, xpSd: 2, mode: 2, pAppears: 0.9, p60: 0.8, eMinutes: 80,
    pGoal: 0.2, pCleanSheet: 0.3, pGe5: 0.4, pGe10: 0.1,
    q10: 1, q25: 2, q50: 4, q75: 7, q90: 10,
    nFixtures: 1, blank: false, decomposition: null, ...over,
  };
}

/** A legal fifteen: 2 GK, 5 DEF, 5 MID, 3 FWD. */
function squadOf(): SquadPlayer[] {
  nextId = 1;
  return [
    ...Array.from({ length: 2 }, () => player("GKP")),
    ...Array.from({ length: 5 }, () => player("DEF")),
    ...Array.from({ length: 5 }, () => player("MID")),
    ...Array.from({ length: 3 }, () => player("FWD")),
  ];
}

describe("formation rules", () => {
  it("names a legal shape", () => {
    const squad = squadOf();
    const xi = [squad[0], ...squad.slice(2, 6), ...squad.slice(7, 11), ...squad.slice(12, 14)];
    expect(xi).toHaveLength(RULES.lineupSize);
    expect(formationOf(xi)).toBe("4-4-2");
  });

  it("refuses eleven players in an illegal shape", () => {
    // Two keepers is eleven players and not a team.
    const squad = squadOf();
    const xi = [squad[0], squad[1], ...squad.slice(2, 5), ...squad.slice(7, 11), ...squad.slice(12, 14)];
    expect(formationOf(xi)).toBeNull();
  });

  it("says which line is wrong, not just that something is", () => {
    // The reader is mid-edit. "Not a legal team" is useless next to "you have
    // two keepers".
    const squad = squadOf();
    const xi = [squad[0], squad[1], ...squad.slice(2, 5), ...squad.slice(7, 11), ...squad.slice(12, 14)];
    const problems = xiProblems(xi);
    expect(problems.map((p) => p.line)).toContain("GKP");
    expect(problems.find((p) => p.line === "GKP")?.have).toBe(2);
    expect(problems.find((p) => p.line === "GKP")?.need).toBe("exactly 1");
  });
});

describe("the optimal XI", () => {
  it("returns a legal eleven", () => {
    const squad = squadOf();
    const points = new Map(squad.map((p, i) => [p.elementId!, 10 - i * 0.1]));
    const best = optimiseXi(squad, points);
    expect(best).not.toBeNull();
    expect(best!.xi).toHaveLength(RULES.lineupSize);
    expect(formationOf(best!.xi)).not.toBeNull();
    expect(best!.bench).toHaveLength(4);
  });

  it("does not pick greedily into an illegal shape", () => {
    /**
     * The trap. Defenders are individually the best players here, so a greedy
     * pass takes five of them and then cannot fill the midfield minimum without
     * dropping one back out. The exhaustive search over shapes cannot produce
     * that, and the assertion is that the result is legal rather than that it
     * has some particular formation.
     */
    const squad = squadOf();
    const points = new Map<number, number>();
    for (const p of squad) {
      points.set(p.elementId!, p.position === "DEF" ? 9 : p.position === "GKP" ? 4 : 1);
    }
    const best = optimiseXi(squad, points)!;
    expect(formationOf(best.xi)).not.toBeNull();
    expect(best.xi.filter((p) => p.position === "DEF").length)
      .toBeLessThanOrEqual(RULES.def.max);
    expect(best.xi.filter((p) => p.position === "MID").length)
      .toBeGreaterThanOrEqual(RULES.mid.min);
  });

  it("counts the captain twice when choosing the shape", () => {
    // One huge forward beats a flat spread once the armband doubles him, even
    // where the bare sums are close.
    const squad = squadOf();
    const points = new Map<number, number>();
    for (const p of squad) points.set(p.elementId!, 4);
    const star = squad.find((p) => p.position === "FWD")!;
    points.set(star.elementId!, 12);
    const best = optimiseXi(squad, points)!;
    expect(best.captain?.elementId).toBe(star.elementId);
    // 10 others at 4, the star at 12, doubled: 40 + 12 + 12.
    expect(best.total).toBe(64);
  });

  it("ranks a player with no projection last rather than at zero", () => {
    // At zero an unknown ties with a genuinely bad player; last means a known
    // low score always starts ahead of a player nobody has a view on.
    const squad = squadOf();
    const points = new Map<number, number>();
    for (const p of squad) {
      if (p.position === "MID") continue;   // five unprojected midfielders
      points.set(p.elementId!, 5);
    }
    const best = optimiseXi(squad, points)!;
    // The minimum midfield still has to be filled, so some unprojected players
    // start — but the count is reported rather than hidden in the total.
    expect(best.unprojected).toBeGreaterThan(0);
    expect(best.unprojected).toBe(best.xi.filter((p) => p.position === "MID").length);
  });

  it("returns null with no projection at all", () => {
    // An eleven chosen with no numbers is an arbitrary eleven wearing the
    // authority of an optimisation.
    expect(optimiseXi(squadOf(), new Map())).toBeNull();
  });

  it("ignores a blank player's zero", () => {
    const projections = [projection(1, 0, { blank: true }), projection(2, 6)];
    const points = pointsFrom(projections);
    expect(points.has(1)).toBe(false);
    expect(points.get(2)).toBe(6);
  });
});

/**
 * One definition of "projected total", and the one number that is not it.
 *
 * `/now` printed 48.20 and `/margin` printed 54.9 for the same squad and the same
 * artifact. The difference was 6.6562 — B.Fernandes's projection, added a second
 * time — because `/margin` computed its headline as the XI sum PLUS the captain
 * while `/now` summed the XI bare. Both are arithmetically defensible, which is
 * exactly why neither could be read: nothing on either screen said which it was.
 *
 * So `projectedTotal` is the only definition and it does not double. The doubling
 * survives inside `optimiseXi`, where it is a comparison key over formations and
 * is never rendered — `OptimisedXi.total` is therefore a different quantity from
 * this one, and these tests pin both facts so a caller cannot quietly print the
 * wrong field again.
 */
describe("the projected total", () => {
  it("is the bare sum of the eleven, with the captain counted once", () => {
    const squad = squadOf();
    const points = pointsFrom(squad.map((p, i) => projection(p.elementId!, i + 1)));
    // 5-4-1: one keeper, five defenders, four midfielders, one forward.
    const xi = [squad[0], ...squad.slice(2, 7), ...squad.slice(7, 11), squad[12]];
    expect(xi).toHaveLength(RULES.lineupSize);
    expect(formationOf(xi)).toBe("5-4-1");
    // `xp` equals the element id here, so ids 1, 3–7, 8–11 and 13 sum to 77.
    expect(projectedTotal(xi, points)).toBeCloseTo(77, 6);
  });

  it("is NOT `optimiseXi.total`, which carries the armband", () => {
    const squad = squadOf();
    const points = pointsFrom(squad.map((p, i) => projection(p.elementId!, i + 1)));
    const best = optimiseXi(squad, points)!;
    expect(best).not.toBeNull();
    const bare = projectedTotal(best.xi, points);
    const captain = points.get(best.captain!.elementId!)!;
    // The relationship is exact, and it is the whole reason the two screens
    // disagreed: one field is the other plus one player's projection.
    expect(best.total).toBeCloseTo(bare + captain, 6);
    expect(best.total).toBeGreaterThan(bare);
  });

  it("counts a player with no published projection as nothing, not as a gap", () => {
    const squad = squadOf();
    // Every id but the first keeper's is projected.
    const points = pointsFrom(
      squad.slice(1).map((p, i) => projection(p.elementId!, i + 1)),
    );
    const xi = [squad[0], ...squad.slice(2, 7), ...squad.slice(7, 11), squad[12]];
    // Here `xp` is one less than the id, and the keeper (id 1) is unprojected and
    // contributes nothing: 0 + 2+3+4+5+6 + 7+8+9+10 + 12 = 66.
    expect(projectedTotal(xi, points)).toBeCloseTo(66, 6);
  });

  it("counts a player with no id as nothing rather than throwing", () => {
    const squad = squadOf();
    const points = pointsFrom(squad.map((p, i) => projection(p.elementId!, i + 1)));
    const idless: SquadPlayer = { ...squad[0], elementId: undefined };
    expect(projectedTotal([idless], points)).toBe(0);
  });
});

describe("what a transfer costs", () => {
  const out = player("MID", 7.5, "Out");
  const move = { gameweek: 1, out, in: projection(99, 6), price: 8.0 };

  it("moves the bank by the price difference", () => {
    const cost = transferCost([move], 1.0, 1);
    expect(cost.bankAfter).toBeCloseTo(0.5);
    expect(cost.hits).toBe(0);
    expect(cost.unaffordable).toBe(false);
  });

  it("charges four points per transfer beyond the free ones", () => {
    const cost = transferCost([move, move, move], 20, 1);
    expect(cost.hits).toBe(2);
    expect(cost.pointsCost).toBe(8);
  });

  it("charges nothing when the free-transfer count is unknown", () => {
    /**
     * FPL does not publish free transfers to this app. Assuming one and docking
     * four points for a hit the reader may not be taking is worse than showing
     * the move with the cost stated as unknown.
     */
    const cost = transferCost([move, move], 20, null);
    expect(cost.hits).toBe(0);
    expect(cost.pointsCost).toBe(0);
  });

  it("flags a move it cannot afford", () => {
    expect(transferCost([move], 0.1, 1).unaffordable).toBe(true);
  });

  it("returns a null bank rather than a partial one", () => {
    // A bank computed from three of four prices looks spendable and is not.
    const unpriced = { gameweek: 1, out, in: projection(98, 5), price: null };
    expect(transferCost([move, unpriced], 5, 2).bankAfter).toBeNull();
  });

  it("keeps the bank in tenths", () => {
    // 0.1 + 0.2 is 0.30000000000000004, and this is money on screen.
    const cost = transferCost(
      [{ gameweek: 1, out: player("MID", 4.1), in: projection(97, 5), price: 4.3 }], 0.3, 1,
    );
    expect(cost.bankAfter).toBe(0.1);
  });
});

describe("the projected delta", () => {
  const points = new Map<number, number>([[1, 4]]);

  it("nets the hit off the gain", () => {
    const out = { ...player("MID", 5), elementId: 1 };
    const move = { gameweek: 1, out, in: projection(50, 9), price: 5 };
    const cost = transferCost([move], 5, 0);
    expect(cost.pointsCost).toBe(4);
    // +5 on the projection, −4 for the hit.
    expect(transferDelta([move], points, cost)).toBe(1);
  });

  it("is null when either side has no projection", () => {
    // Scoring an unknown as zero makes every transfer out of one look like a win.
    const out = { ...player("MID", 5), elementId: 999 };
    const move = { gameweek: 1, out, in: projection(50, 9), price: 5 };
    expect(transferDelta([move], points, transferCost([move], 5, 1))).toBeNull();
  });
});

describe("applying moves", () => {
  it("swaps the player and keeps the squad at fifteen", () => {
    const squad = squadOf();
    const out = squad[7];
    const after = applyMoves(squad, [{ gameweek: 1, out, in: projection(500, 6, { position: "MID" }), price: 6 }]);
    expect(after).toHaveLength(RULES.squadSize);
    expect(after.some((p) => p.elementId === out.elementId)).toBe(false);
    expect(after.some((p) => p.elementId === 500)).toBe(true);
  });

  it("gives the incoming player no armband and no bench slot", () => {
    // A player you have not owned through a deadline has no pick, so those are
    // unknown rather than false — the planner assigns them itself.
    const squad = squadOf();
    const after = applyMoves(squad, [{ gameweek: 1, out: squad[7], in: projection(500, 6), price: 6 }]);
    const added = after.find((p) => p.elementId === 500)!;
    expect(added.bench).toBeUndefined();
    expect(added.role).toBeUndefined();
  });
});

describe("a plan is a sequence of weeks", () => {
  const squad = squadOf();
  const shaw = squad[2];      // DEF
  const gabriel = squad[3];   // DEF
  const gw = [1, 2, 3, 4, 5, 6];

  /** Shaw out in GW2, Gabriel out in GW4 — the case from the brief. */
  const moves = [
    { gameweek: 2, out: shaw, in: projection(101, 5, { position: "DEF" }), price: 5 },
    { gameweek: 4, out: gabriel, in: projection(102, 6, { position: "DEF" }), price: 6 },
  ];

  it("keeps a player until the week they are sold", () => {
    // The whole point of putting a week on a move.
    expect(squadAtWeek(squad, moves, 1).some((p) => p.elementId === shaw.elementId)).toBe(true);
    expect(squadAtWeek(squad, moves, 2).some((p) => p.elementId === shaw.elementId)).toBe(false);
    expect(squadAtWeek(squad, moves, 3).some((p) => p.elementId === gabriel.elementId)).toBe(true);
    expect(squadAtWeek(squad, moves, 4).some((p) => p.elementId === gabriel.elementId)).toBe(false);
  });

  it("brings the incoming player in from that week and no earlier", () => {
    expect(squadAtWeek(squad, moves, 1).some((p) => p.elementId === 101)).toBe(false);
    expect(squadAtWeek(squad, moves, 2).some((p) => p.elementId === 101)).toBe(true);
    expect(squadAtWeek(squad, moves, 6).some((p) => p.elementId === 101)).toBe(true);
  });

  it("charges each week against the free transfers held that week", () => {
    /**
     * The reason a move carries a week.
     *
     * Starting with one free transfer and making none in GW1, you hold two by
     * GW2 — so two moves there are still free. A third is a hit. Spreading the
     * same three across three weeks is not.
     */
    const spread = weeklyLedger(squad, moves, gw, 2.0, 1);
    expect(spread.map((w) => w.hits)).toEqual([0, 0, 0, 0, 0, 0]);

    const crammed = [
      { ...moves[0], gameweek: 2 },
      { ...moves[1], gameweek: 2 },
      { gameweek: 2, out: squad[4], in: projection(104, 5, { position: "DEF" }), price: 5 },
    ];
    const together = weeklyLedger(squad, crammed, gw, 20, 1);
    expect(together[1].freeBefore).toBe(2);
    expect(together[1].hits).toBe(1);
    expect(together[1].pointsCost).toBe(4);
  });

  it("rolls unused free transfers over and caps them", () => {
    const ledger = weeklyLedger(squad, [], gw, 2.0, 1);
    // 1 held, none used: 2, 3, 4, 5, then capped.
    expect(ledger.map((w) => w.freeAfter))
      .toEqual([2, 3, 4, 5, MAX_BANKED_FREE_TRANSFERS, MAX_BANKED_FREE_TRANSFERS]);
  });

  it("spends the free transfer before banking the next one", () => {
    const ledger = weeklyLedger(
      squad, [{ ...moves[0], gameweek: 1 }], gw, 2.0, 1,
    );
    // One held, one spent, one accrued.
    expect(ledger[0].freeBefore).toBe(1);
    expect(ledger[0].freeAfter).toBe(1);
  });

  it("carries the bank forward week by week", () => {
    // Shaw 5.0 out for 5.0 in leaves it; Gabriel 5.0 out for 6.0 in costs 1.0.
    const ledger = weeklyLedger(squad, moves, gw, 2.0, 1);
    expect(ledger[1].bankAfter).toBeCloseTo(2.0);
    expect(ledger[3].bankAfter).toBeCloseTo(1.0);
    expect(ledger[5].bankAfter).toBeCloseTo(1.0);
  });

  it("flags the week a plan stops being affordable", () => {
    const dear = [{ gameweek: 3, out: shaw, in: projection(103, 9, { position: "DEF" }), price: 12 }];
    const ledger = weeklyLedger(squad, dear, gw, 1.0, 1);
    expect(ledger[2].unaffordable).toBe(true);
    // And it stays flagged, because the money does not come back.
    expect(ledger[5].unaffordable).toBe(true);
  });

  it("leaves every hit unknown when the free-transfer count is", () => {
    const ledger = weeklyLedger(squad, moves, gw, 2.0, null);
    expect(ledger.every((w) => w.hits === 0 && w.freeAfter === null)).toBe(true);
  });

  it("puts every player who appears in any week on the grid", () => {
    // A player bought in GW4 belongs on the grid from the start as an unowned
    // run, and one sold in GW2 belongs on it to the end.
    const ledger = weeklyLedger(squad, moves, gw, 2.0, 1);
    const everyone = playersAcross(ledger, squad);
    expect(everyone.some((p) => p.elementId === shaw.elementId)).toBe(true);
    expect(everyone.some((p) => p.elementId === 102)).toBe(true);
    expect(everyone).toHaveLength(RULES.squadSize + moves.length);
  });

  it("knows who is owned in which week", () => {
    const ledger = weeklyLedger(squad, moves, gw, 2.0, 1);
    expect(ownedIn(ledger[0], shaw)).toBe(true);
    expect(ownedIn(ledger[1], shaw)).toBe(false);
  });
});

describe("an incoming player gets his club's fixtures", () => {
  it("looks the run up rather than arriving with none", () => {
    /**
     * The defect this fixes: `applyMoves` hardcoded an empty run, so every
     * column for a player you were evaluating hatched as "no fixture" — which
     * reads as a blank gameweek and kills rotation planning for exactly the
     * player being considered.
     */
    const squad = squadOf();
    const run = [
      { gameweek: 2, label: "ARS (H)", difficulty: 4 },
      { gameweek: 3, label: "BUR (A)", difficulty: 2 },
    ];
    const after = applyMoves(
      squad,
      [{ gameweek: 2, out: squad[7], in: projection(700, 6, { team: "Chelsea" }), price: 6 }],
      (team) => (team === "Chelsea" ? run : []),
    );
    expect(after.find((p) => p.elementId === 700)?.fixtures).toEqual(run);
  });

  it("leaves the run empty when the club is unknown", () => {
    // Empty, not invented: a player whose club has no published run gets the
    // hatch, which is the honest mark for "nothing scheduled that we can see".
    const squad = squadOf();
    const after = applyMoves(
      squad,
      [{ gameweek: 2, out: squad[7], in: projection(701, 6, { team: null }), price: 6 }],
      () => [{ gameweek: 2, label: "X", difficulty: 3 }],
    );
    expect(after.find((p) => p.elementId === 701)?.fixtures).toEqual([]);
  });
});

describe("a swap's two players sit together", () => {
  const squad = squadOf();
  const move = {
    gameweek: 2, out: squad[7], in: projection(800, 6, { position: "MID" }), price: 6,
  };

  it("puts the arrival directly under the departure", () => {
    // The one thing a transfer plan has to show is what swapped for what, and
    // sorting by line then projection put the two anywhere relative to each
    // other. The input is the union across the plan — the departed player is
    // not in the post-move squad, which is why `playersAcross` exists.
    const everyone = playersAcross(weeklyLedger(squad, [move], [1, 2, 3], 2, 1), squad);
    const rows = pairRows(everyone, [move]);
    const outIndex = rows.findIndex((r) => r.player.elementId === squad[7].elementId);
    expect(outIndex).toBeGreaterThanOrEqual(0);
    expect(rows[outIndex].side).toBe("out");
    expect(rows[outIndex + 1].player.elementId).toBe(800);
    expect(rows[outIndex + 1].side).toBe("in");
  });

  it("leaves every other row unpaired", () => {
    const everyone = playersAcross(weeklyLedger(squad, [move], [1, 2, 3], 2, 1), squad);
    const rows = pairRows(everyone, [move]);
    // Sixteen players across the plan: the fifteen plus the arrival. Two are
    // the pair; the rest stand alone.
    expect(rows).toHaveLength(everyone.length);
    expect(rows.filter((r) => r.side !== null)).toHaveLength(2);
  });

  it("keeps a departed player on the grid", () => {
    // He is gone from the squad but still owns the weeks before the sale.
    const everyone = playersAcross(
      weeklyLedger(squad, [move], [1, 2, 3], 2, 1), squad,
    );
    const rows = pairRows(everyone, [move]);
    expect(rows.some((r) => r.player.elementId === squad[7].elementId)).toBe(true);
  });
});

describe("the delta of a single move", () => {
  const squad = squadOf();
  const points = new Map<number, number>([[squad[7].elementId!, 4]]);

  it("answers for a move in the projected gameweek", () => {
    const move = { gameweek: 1, out: squad[7], in: projection(900, 7), price: 6 };
    expect(moveDelta(move, points, 1)).toBe(3);
  });

  it("refuses for a move in any other week", () => {
    /**
     * `xp_public` covers one gameweek. A delta for a GW4 swap computed from this
     * week's projections would be the most confident wrong number on the screen
     * — it looks like an answer and is about a different week.
     */
    const move = { gameweek: 4, out: squad[7], in: projection(900, 7), price: 6 };
    expect(moveDelta(move, points, 1)).toBeNull();
  });
});

describe("an XI is eleven, and the per-line ranges never said so", () => {
  /**
   * The minima sum to 7 (1+3+2+1) and the maxima to 14 (1+5+5+3), so every size in that
   * window satisfied all four line checks while only 11 is legal. `formationOf` refused
   * such an XI by returning null and `xiProblems` reported nothing was wrong, so the
   * planner printed a projected total for a twelve-man team.
   */
  const player = (position: "GKP" | "DEF" | "MID" | "FWD", id: number) =>
    ({ elementId: id, name: `p${id}`, position, team: "ARS", price: 5 } as never);

  const shaped = (gkp: number, def: number, mid: number, fwd: number) => {
    const out: unknown[] = [];
    let id = 0;
    for (let i = 0; i < gkp; i += 1) out.push(player("GKP", id += 1));
    for (let i = 0; i < def; i += 1) out.push(player("DEF", id += 1));
    for (let i = 0; i < mid; i += 1) out.push(player("MID", id += 1));
    for (let i = 0; i < fwd; i += 1) out.push(player("FWD", id += 1));
    return out as never[];
  };

  it("passes a legal eleven", () => {
    expect(xiProblems(shaped(1, 4, 4, 2))).toEqual([]);
    expect(formationOf(shaped(1, 4, 4, 2))).toBe("4-4-2");
  });

  it("catches a twelve whose every line is within range", () => {
    const twelve = shaped(1, 5, 4, 2);
    // Every line legal on its own.
    expect(twelve).toHaveLength(12);
    const problems = xiProblems(twelve);
    expect(problems).toContainEqual({ line: null, have: 12, need: "exactly 11" });
    // And the two functions now agree, where they used to contradict each other.
    expect(formationOf(twelve)).toBeNull();
  });

  it("catches the largest all-lines-legal XI, fourteen", () => {
    const fourteen = shaped(1, 5, 5, 3);
    expect(fourteen).toHaveLength(14);
    expect(xiProblems(fourteen).some((p) => p.line === null)).toBe(true);
  });

  it("catches the smallest, seven", () => {
    const seven = shaped(1, 3, 2, 1);
    expect(seven).toHaveLength(7);
    expect(xiProblems(seven).some((p) => p.line === null)).toBe(true);
  });

  it("puts the size first, because it makes the line counts misleading", () => {
    // Eleven of the wrong shape is a different edit from twelve of the right one.
    const problems = xiProblems(shaped(1, 5, 5, 3));
    expect(problems[0].line).toBeNull();
  });

  it("still names the line when the size is right and the shape is not", () => {
    const problems = xiProblems(shaped(2, 4, 4, 1));
    expect(problems.some((p) => p.line === null)).toBe(false);
    expect(problems.some((p) => p.line === "GKP" && p.have === 2)).toBe(true);
  });
});
