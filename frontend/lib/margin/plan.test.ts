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
import { buildPlanGrid, cellsFor, movesFor } from "@/lib/margin/plan";
import type { Projection } from "@/lib/data/projections";

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

  it("reads the moves out as names", () => {
    const horizon = artifact()!.horizon!;
    const model = buildPlanGrid(horizon, NAMES);
    expect(movesFor(horizon.weeks[1], model.rows))
      .toEqual({ out: ["Haaland"], in: ["Semenyo"] });
  });
});
