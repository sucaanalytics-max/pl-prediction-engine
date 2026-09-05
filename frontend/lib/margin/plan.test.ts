/**
 * The solved horizon, from the artifact through to the grid.
 *
 * Nothing has published a decision yet — no gameweek has sealed — so every case
 * here is built from the shape `pipeline/decide/run_decide.py` writes rather
 * than from a committed file. The shape is not guessed: `Decision.as_dict`
 * carries `horizon.provisional[]` of `milp.Plan.as_dict()`, and
 * `strip_for_publication` drops only the runners-up and the selection stream.
 *
 * The cases that matter are the ones where a plausible render would be wrong:
 * a player absent from a week, the eval-only tail, and a captain who is also in
 * the XI.
 */

import { describe, expect, it } from "vitest";
import { narrowPublicDecision } from "@/lib/data/narrow";
import { buildPlanGrid, cellsFor, heldSquadHorizon } from "@/lib/margin/plan";
import type { Horizon as XpHorizon, Projection } from "@/lib/data/projections";

function projection(elementId: number, name: string, position: string): Projection {
  return {
    elementId, name, team: "Arsenal", position,
    xp: 5, xpSd: 2, mode: 2, pAppears: 0.9, p60: 0.8, eMinutes: 80,
    pGoal: 0.2, pCleanSheet: 0.3, pGe5: 0.4, pGe10: 0.1,
    q10: 1, q25: 2, q50: 4, q75: 7, q90: 10,
    nFixtures: 1, blank: false, decomposition: null,
  };
}

const NAMES = [
  projection(1, "Raya", "GKP"),
  projection(2, "Gabriel", "DEF"),
  projection(3, "Palmer", "MID"),
  projection(4, "Haaland", "FWD"),
  projection(5, "Semenyo", "MID"),
];

/** Week 0 in `decision.plan`, the tail in `horizon.provisional` — as published. */
function artifact(over: Record<string, unknown> = {}) {
  const result = narrowPublicDecision({
    gameweek: 3,
    entry_label: "season",
    decision: {
      mean_points: 59.6,
      plan: {
        squad: [1, 2, 3, 4], xi: [1, 2, 3, 4], captain: 4, vice: 3,
        transfers_in: [], transfers_out: [], hits: 0, bank_after: 8,
      },
    },
    horizon: {
      eval_horizon: 3,
      transfer_horizon: 2,
      provisional: [
        {
          squad: [1, 2, 3, 5], xi: [1, 2, 3], captain: 3, vice: 1,
          transfers_in: [5], transfers_out: [4], hits: 0, bank_after: 3,
          free_transfers_after: 1,
        },
        {
          squad: [1, 2, 3, 5], xi: [1, 2, 5], captain: 5, vice: 1,
          transfers_in: [], transfers_out: [], hits: 0, bank_after: 3,
          free_transfers_after: 2,
        },
      ],
      ...over,
    },
  });
  expect(result.ok, "fixture should narrow").toBe(true);
  return result.ok ? result.value : null;
}

describe("the horizon is read out of the decision artifact", () => {
  it("joins week 0 to the provisional tail, in order", () => {
    const horizon = artifact()?.horizon;
    expect(horizon?.weeks.map((w) => w.gameweek)).toEqual([3, 4, 5]);
  });

  it("derives the bench as squad minus XI", () => {
    // The producer publishes both sets and not the difference. Deriving a set it
    // already determined is not the same as inventing a number it never computed.
    const horizon = artifact()?.horizon;
    expect(horizon?.weeks[1].bench).toEqual([5]);
    expect(horizon?.weeks[0].bench).toEqual([]);
  });

  it("marks the eval-only tail as unplanned", () => {
    // `eval_horizon` 3 with `transfer_horizon` 2: the last week is priced, not
    // planned, and must not print a transfer count the solve never chose.
    const weeks = artifact()?.horizon?.weeks ?? [];
    expect(weeks.map((w) => w.planned)).toEqual([true, true, false]);
  });

  it("is null when the run solved one gameweek", () => {
    const result = narrowPublicDecision({
      gameweek: 3, entry_label: "season",
      decision: { mean_points: 59.6, plan: { squad: [1], xi: [1], captain: 1 } },
      horizon: null,
    });
    expect(result.ok && result.value.horizon).toBeNull();
  });

  it("is null when the horizon carries no weeks", () => {
    // A horizon block with an empty tail and no week 0 is not a horizon, and the
    // screen's refusal is the honest render.
    const result = narrowPublicDecision({
      gameweek: 3, entry_label: "season",
      decision: {},
      horizon: { eval_horizon: 8, transfer_horizon: 6, provisional: [] },
    });
    expect(result.ok && result.value.horizon).toBeNull();
  });
});

describe("cells", () => {
  const weeks = artifact()!.horizon!.weeks;

  it("gives the captain a ring and NOT a filled square", () => {
    // Two marks for one fact reads as a third state.
    const haaland = cellsFor(4, weeks)[0];
    expect(haaland.captain).toBe(true);
    expect(haaland.start).toBe(false);
  });

  it("hatches a week the player is not in the squad", () => {
    // Haaland is sold in GW4. An empty cell would read as "picked, and scored
    // nothing", which is the opposite of a sale.
    const haaland = cellsFor(4, weeks);
    expect(haaland[1].off).toBe(true);
    expect(haaland[1].bench).toBe(false);
  });

  it("puts the arrowheads on the week the move happens", () => {
    expect(cellsFor(5, weeks)[1].enter).toBe(true);
    expect(cellsFor(4, weeks)[1].exit).toBe(true);
    expect(cellsFor(5, weeks)[0].enter).toBe(false);
  });

  it("separates bench from start", () => {
    const semenyo = cellsFor(5, weeks);
    expect(semenyo[1].bench).toBe(true);
    expect(semenyo[2].captain).toBe(true);
  });
});

describe("the grid", () => {
  it("carries every player who appears in any week", () => {
    // The union, not week 0's squad: a player bought in a later week belongs on
    // the grid from the start as a hatched run, which is the transfer the screen
    // exists to plan.
    const model = buildPlanGrid(artifact()!.horizon!, NAMES);
    expect(model.rows.map((r) => r.name).sort())
      .toEqual(["Gabriel", "Haaland", "Palmer", "Raya", "Semenyo"]);
  });

  it("orders rows GK, DEF, MID, FWD", () => {
    const model = buildPlanGrid(artifact()!.horizon!, NAMES);
    expect(model.rows.map((r) => r.position))
      .toEqual(["GKP", "DEF", "MID", "MID", "FWD"]);
  });

  it("counts starts including captaincies", () => {
    const model = buildPlanGrid(artifact()!.horizon!, NAMES);
    const raya = model.rows.find((r) => r.name === "Raya");
    expect(raya?.starts).toBe("3/3");
    const haaland = model.rows.find((r) => r.name === "Haaland");
    // Captain in GW3, sold thereafter.
    expect(haaland?.starts).toBe("1/3");
  });

  it("shows an id rather than another player's name", () => {
    // `decision_public` publishes ids; the names come from the projection. When
    // the two disagree about a player the honest render is the id.
    const model = buildPlanGrid(artifact()!.horizon!, [NAMES[0]]);
    expect(model.rows.map((r) => r.name)).toContain("#4");
    expect(model.unnamed).toBe(4);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The numbers in the cells
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two producers, two fidelities, and the grid has to keep them straight.
 *
 * The decided gameweek's xP is the projection row's own `xp`, simulated at
 * `n_draws` (10,000 today). Every later week comes off `xp_public.horizon`,
 * simulated at `horizon.n_draws` (5,000). `lib/data/projections.ts` says why the
 * current week is deliberately absent from the horizon block: "two numbers for
 * the same player in the same week would be indistinguishable on screen".
 *
 * So the join is by GAMEWEEK, never by column index. An index join reads
 * correctly for a horizon that starts where the plan starts, and silently shifts
 * every number one column left the moment it does not.
 */
const XP_HORIZON: XpHorizon = {
  nDraws: 5000,
  weeks: [
    { gameweek: 4, xp: new Map([[1, 4.25], [2, 3.5], [3, 6.0]]) },
    { gameweek: 5, xp: new Map([[1, 3.75], [2, 3.1]]) },
  ],
};

describe("per-week expected points", () => {
  it("takes the decided gameweek from the projection, not the horizon", () => {
    /**
     * GW3 is week 0 here and the horizon has no GW3 entry. The row's own `xp`
     * is 5 for every fixture player, and that is the higher-fidelity number.
     */
    const grid = buildPlanGrid(artifact()!.horizon!, NAMES, XP_HORIZON);
    const raya = grid.rows.find((r) => r.name === "Raya");
    expect(raya?.cells[0].gameweek).toBe(3);
    expect(raya?.cells[0].xp).toBe(5);
  });

  it("takes later weeks from the horizon, matched on gameweek", () => {
    const grid = buildPlanGrid(artifact()!.horizon!, NAMES, XP_HORIZON);
    const raya = grid.rows.find((r) => r.name === "Raya");
    expect(raya?.cells[1].gameweek).toBe(4);
    expect(raya?.cells[1].xp).toBe(4.25);
    expect(raya?.cells[2].gameweek).toBe(5);
    expect(raya?.cells[2].xp).toBe(3.75);
  });

  it("is null, never zero, for a week the horizon does not cover", () => {
    /**
     * Player 3 has a GW4 number and no GW5 one. Zero would read as "projected to
     * score nothing", which is a forecast; null reads as "no forecast", which is
     * the truth. The same distinction `narrowHorizon` drops empty weeks for.
     */
    const grid = buildPlanGrid(artifact()!.horizon!, NAMES, XP_HORIZON);
    const palmer = grid.rows.find((r) => r.name === "Palmer");
    expect(palmer?.cells[1].xp).toBe(6.0);
    expect(palmer?.cells[2].xp).toBeNull();
  });

  it("leaves every later cell null when no horizon was published", () => {
    /** `Projections.horizon` is null whenever the run solved no horizon. */
    const grid = buildPlanGrid(artifact()!.horizon!, NAMES, null);
    const raya = grid.rows.find((r) => r.name === "Raya");
    expect(raya?.cells[0].xp).toBe(5);
    expect(raya?.cells[1].xp).toBeNull();
  });
});

describe("the column total", () => {
  it("sums the XI, and says how many it could not", () => {
    /**
     * The XI only — a bench total would double-count the same squad under a
     * heading that reads like a score. And it reports `missing`, because a total
     * silently short of two players is a wrong number rather than a partial one.
     *
     * GW3's XI is 1, 2, 3, 4 and the projection gives every one of them 5.
     */
    const grid = buildPlanGrid(artifact()!.horizon!, NAMES, XP_HORIZON);
    expect(grid.totals[0]).toEqual({ gameweek: 3, xp: 20, counted: 4, missing: 0 });
  });

  it("counts what it has and names the shortfall", () => {
    /**
     * GW4's XI is 1, 2, 3; the horizon has 1 at 4.25, 2 at 3.5 and 3 at 6.0, so
     * nothing is missing. GW5's XI is 1, 2, 5 and the horizon has no 5 — so the
     * total is 6.85 over two of three.
     */
    const grid = buildPlanGrid(artifact()!.horizon!, NAMES, XP_HORIZON);
    expect(grid.totals[1]).toEqual({ gameweek: 4, xp: 13.75, counted: 3, missing: 0 });
    expect(grid.totals[2]).toEqual({ gameweek: 5, xp: 6.85, counted: 2, missing: 1 });
  });

  it("does not double the captain", () => {
    /**
     * The label is "XI xP" and this is the sum of the eleven. Doubling the
     * armband would make it a score projection, which is a different quantity
     * with a different name — and one the reader could not check by adding up
     * the column, which is the whole reason the total is allowed here at all.
     */
    const grid = buildPlanGrid(artifact()!.horizon!, NAMES, XP_HORIZON);
    // GW3: four in the XI at 5 each. With the captain doubled it would be 25.
    expect(grid.totals[0].xp).toBe(20);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The grid without a plan
// ─────────────────────────────────────────────────────────────────────────────

describe("a horizon built from the squad alone", () => {
  /**
   * The section used to vanish whenever no decision was published — which is most
   * of the week, and all of it before the first solve of a gameweek. A dashboard
   * section that disappears when the optimiser has not run is not a section.
   *
   * What is always available is the held squad and the published xP horizon. What
   * is NOT available is any claim about who starts, who is benched or who wears
   * the armband, so the cells must state none of those.
   */

  const SQUAD = [1, 2, 3, 4, 5];

  it("covers every requested gameweek", () => {
    const horizon = heldSquadHorizon(SQUAD, [4, 5, 6]);
    expect(horizon.weeks.map((w) => w.gameweek)).toEqual([4, 5, 6]);
  });

  it("holds the squad and claims no eleven", () => {
    const week = heldSquadHorizon(SQUAD, [4]).weeks[0];
    expect(week.squad).toEqual(SQUAD);
    expect(week.xi).toEqual([]);
    expect(week.bench).toEqual([]);
    expect(week.captain).toBeNull();
    expect(week.vice).toBeNull();
  });

  it("plans no transfers, because none were solved", () => {
    const week = heldSquadHorizon(SQUAD, [4]).weeks[0];
    expect(week.transfers_in).toEqual([]);
    expect(week.transfers_out).toEqual([]);
    expect(week.planned).toBe(false);
  });
});

describe("cells with no plan behind them", () => {
  it("marks an owned player unplanned rather than benched", () => {
    /**
     * The trap. With an empty XI the existing rule — in the squad, not in the XI,
     * therefore bench — would draw a hollow square on all fifteen and state that
     * the solve benched the entire squad. It did not solve anything.
     */
    const horizon = heldSquadHorizon([1, 2], [4]);
    const [cell] = cellsFor(1, horizon.weeks);
    expect(cell.unplanned).toBe(true);
    expect(cell.bench).toBe(false);
    expect(cell.start).toBe(false);
    expect(cell.captain).toBe(false);
    expect(cell.off).toBe(false);
  });

  it("still hatches a player the squad does not hold", () => {
    // Unplanned is not "unknown about everyone" — a player outside the squad is
    // still definitely not owned that week.
    const horizon = heldSquadHorizon([1, 2], [4]);
    const [cell] = cellsFor(99, horizon.weeks);
    expect(cell.off).toBe(true);
    expect(cell.unplanned).toBe(false);
  });

  it("leaves a solved week's cells exactly as they were", () => {
    // The new state must not leak into the case that already worked.
    const weeks = artifact()!.horizon!.weeks;
    const [cell] = cellsFor(1, weeks);
    expect(cell.unplanned).toBe(false);
    expect(cell.start).toBe(true);
  });
});
