/**
 * What the scatter plots, and who it refuses to plot.
 *
 * The load-bearing case is the refusal: a player with 40 minutes sits at the
 * origin beside one who played none, and a cluster there reads as a finding
 * rather than as an absence of evidence.
 */

import { describe, expect, it } from "vitest";

import { notable, place, plot, ticks } from "@/lib/margin/scatter";
import { MIN_MINUTES_FOR_RATES, type PlayerRow } from "@/lib/data/narrow";

function row(over: Partial<PlayerRow> = {}): PlayerRow {
  return {
    elementId: 1, name: "Haaland", team: "MCI", position: "FWD",
    minutes: 2953, goals: 27, assists: 8, xg: 25.5, xa: 2.67,
    fouls_committed: null, fouls_per_90: null,
    fpl_ownership: 72, fpl_price: 15.5, form: 0,
    available: true, ratesAreMeaningful: true, ...over,
  };
}

describe("who is plotted", () => {
  it("keeps a player with a season behind them", () => {
    expect(plot([row()]).points).toHaveLength(1);
  });

  it("drops a player below the minutes threshold", () => {
    // The narrower's own threshold, so the chart and the per-90 columns agree
    // about when a season describes a player.
    expect(plot([row({ minutes: MIN_MINUTES_FOR_RATES - 1 })]).points).toEqual([]);
  });

  it("drops a player with no element id", () => {
    // Nothing can be pinned or compared from a point with no identity.
    expect(plot([row({ elementId: null })]).points).toEqual([]);
  });

  it("carries the fields the tooltip and the pin both need", () => {
    const [point] = plot([row()]).points;
    expect(point.name).toBe("Haaland");
    expect(point.price).toBe(15.5);
    expect(point.ownership).toBe(72);
  });
});

describe("the box that holds them", () => {
  it("rounds each axis up to a whole unit", () => {
    // xG and xA are counts; a tick at 25.5 reads as false precision.
    const { bounds } = plot([row({ xg: 25.5, xa: 2.67 })]);
    expect(bounds.maxX).toBe(26);
    expect(bounds.maxY).toBe(3);
  });

  it("never collapses to a zero-width axis", () => {
    // Every player at the origin would otherwise divide by zero.
    const { bounds } = plot([row({ xg: 0, xa: 0 })]);
    expect(bounds.maxX).toBeGreaterThan(0);
    expect(bounds.maxY).toBeGreaterThan(0);
  });

  it("starts both axes at zero rather than at the data", () => {
    // A zoomed axis on a count exaggerates a gap one goal wide.
    const { points, bounds } = plot([row({ xg: 20, xa: 10 }), row({ elementId: 2, xg: 21, xa: 11 })]);
    const [a, b] = points.map((p) => place(p, bounds));
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.1);
  });
});

describe("placing a point", () => {
  it("puts the maximum at the far edge", () => {
    const { points, bounds } = plot([row({ xg: 26, xa: 3 })]);
    expect(place(points[0], bounds)).toEqual({ x: 1, y: 1 });
  });

  it("puts the origin at the corner", () => {
    const { points, bounds } = plot([row({ xg: 0, xa: 0 })]);
    expect(place(points[0], bounds)).toEqual({ x: 0, y: 0 });
  });

  it("never places a point outside the box", () => {
    const { points, bounds } = plot([row()]);
    const at = place(points[0], { ...bounds, maxX: 1, maxY: 1 });
    expect(at.x).toBeLessThanOrEqual(1);
    expect(at.y).toBeLessThanOrEqual(1);
  });
});

describe("which points get a name", () => {
  it("names the largest combined output, because 400 labels is a block of text", () => {
    const rows = [
      row({ elementId: 1, xg: 25, xa: 2 }),
      row({ elementId: 2, xg: 1, xa: 1 }),
      row({ elementId: 3, xg: 10, xa: 12 }),
    ];
    const { points } = plot(rows);
    expect([...notable(points, 2)].sort()).toEqual([1, 3]);
  });

  it("names nobody from an empty cloud", () => {
    expect(notable([], 5).size).toBe(0);
  });
});

describe("axis ticks", () => {
  it("uses whole units a reader recognises", () => {
    expect(ticks(26)).toEqual([0, 6, 12, 18, 24]);
  });

  it("always includes the origin", () => {
    expect(ticks(3)[0]).toBe(0);
  });
});
