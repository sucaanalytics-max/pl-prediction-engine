/**
 * Filtering, sorting and exporting value bets.
 *
 * These carry the last of `/value-bets` across, and two of them are money
 * decisions rather than presentation:
 *
 * * **Sorting by stake must put "no stake" last, not first.** A null half-Kelly
 *   means no usable fraction could be derived, which is not the same as a small
 *   one; treating it as zero buries an unknown among the marginal.
 * * **The CSV exports the fraction and says so in the header.** A currency column
 *   would carry the pipeline's hardcoded £1,000 bankroll into a spreadsheet that
 *   records no such assumption — and a number in a spreadsheet gets believed.
 */
import { describe, expect, it } from "vitest";
import {
  applyFilters, DEFAULT_FILTERS, MARKET_GROUPS, toCsv,
  type BetFilters, type BetRow,
} from "@/lib/data/bet-filters";
import type { Bet } from "@/lib/data/narrow";
import type { Fraction } from "@/lib/data/units";

function bet(over: Partial<Bet> = {}): Bet {
  return {
    market: "Over 2.5 Goals",
    selection: null,
    edge: 0.05,
    model_prob: 0.52,
    implied_prob: 0.46,
    decimal_odds: 2.17,
    bookmaker: "bet365",
    devigged: true,
    market_type: "over_under",
    confidence: "low",
    halfKelly: 0.025 as Fraction,
    ...over,
  };
}

function row(fixture: string, over: Partial<Bet> = {}): BetRow {
  return { fixture, bet: bet(over) };
}

const ROWS: BetRow[] = [
  row("Arsenal v Chelsea", { market: "Home Win", market_type: "1x2", edge: 0.11, confidence: "medium", decimal_odds: 3.4, model_prob: 0.40, halfKelly: 0.02 as Fraction }),
  row("Everton v Fulham", { market: "Over 2.5 Goals", market_type: "over_under", edge: 0.08, confidence: "low", decimal_odds: 1.9, model_prob: 0.58, devigged: false }),
  row("Leeds v Wolves", { market: "BTTS Yes", market_type: "btts", edge: 0.03, confidence: "high", decimal_odds: 2.5, model_prob: 0.45, halfKelly: null }),
];

const filters = (over: Partial<BetFilters> = {}): BetFilters =>
  ({ ...DEFAULT_FILTERS, ...over });

describe("market grouping", () => {
  it("keys on market_type, not on words in the display name", () => {
    // "Over 2.5 Goals" and "Goalscorer" both contain words a substring matcher
    // would collide on.
    const out = applyFilters(ROWS, filters({ market: "Goals O/U" }));
    expect(out.map((r) => r.bet.market_type)).toEqual(["over_under"]);
  });

  it("all is a real passthrough", () => {
    expect(applyFilters(ROWS, filters({ market: "all" }))).toHaveLength(3);
  });

  it("groups goalscorer and player together", () => {
    const rows = [row("x", { market_type: "player" }), row("y", { market_type: "goalscorer" })];
    expect(applyFilters(rows, filters({ market: "Goalscorer" }))).toHaveLength(2);
  });

  it("a bet with no market_type is excluded from every specific group", () => {
    const rows = [row("x", { market_type: null })];
    expect(applyFilters(rows, filters({ market: "1X2" }))).toHaveLength(0);
    // ...but still appears under "all", so it is never silently lost.
    expect(applyFilters(rows, filters({ market: "all" }))).toHaveLength(1);
  });

  it("every declared group is reachable", () => {
    for (const group of Object.keys(MARKET_GROUPS) as (keyof typeof MARKET_GROUPS)[]) {
      expect(() => applyFilters(ROWS, filters({ market: group }))).not.toThrow();
    }
  });
});

describe("confidence and edge filters", () => {
  it("filters on the pipeline's own tier", () => {
    expect(applyFilters(ROWS, filters({ confidence: "high" }))).toHaveLength(1);
  });

  it("reads confidence_tier but falls back to confidence", () => {
    // The 1X2 path writes both; the totals path writes only `confidence`. Keying
    // on one alone silently loses half the bets from the filter.
    const rows = [row("x", { confidence: "medium" })];
    expect(applyFilters(rows, filters({ confidence: "medium" }))).toHaveLength(1);
  });

  it("applies a minimum edge", () => {
    expect(applyFilters(ROWS, filters({ minEdgePct: 5 }))).toHaveLength(2);
    expect(applyFilters(ROWS, filters({ minEdgePct: 10 }))).toHaveLength(1);
  });

  it("can exclude bets whose edge still contains the vig", () => {
    const out = applyFilters(ROWS, filters({ devigedOnly: true }));
    expect(out.every((r) => r.bet.devigged === true)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("de-vigged-only also excludes unknown, not just false", () => {
    // Unknown is not clean. Including it would defeat the filter's purpose.
    const rows = [row("x", { devigged: null })];
    expect(applyFilters(rows, filters({ devigedOnly: true }))).toHaveLength(0);
  });
});

describe("search", () => {
  it("matches the fixture", () => {
    expect(applyFilters(ROWS, filters({ search: "arsenal" }))).toHaveLength(1);
  });

  it("matches the market", () => {
    expect(applyFilters(ROWS, filters({ search: "btts" }))).toHaveLength(1);
  });

  it("is case-insensitive and trims", () => {
    expect(applyFilters(ROWS, filters({ search: "  ARSENAL  " }))).toHaveLength(1);
  });

  it("an empty search filters nothing", () => {
    expect(applyFilters(ROWS, filters({ search: "   " }))).toHaveLength(3);
  });
});

describe("sorting", () => {
  it("defaults to largest edge first", () => {
    expect(applyFilters(ROWS, filters()).map((r) => r.bet.edge))
      .toEqual([0.11, 0.08, 0.03]);
  });

  it("sorts by odds", () => {
    expect(applyFilters(ROWS, filters({ sortKey: "odds" })).map((r) => r.bet.decimal_odds))
      .toEqual([3.4, 2.5, 1.9]);
  });

  it("sorts by model probability", () => {
    expect(applyFilters(ROWS, filters({ sortKey: "model_prob" })).map((r) => r.bet.model_prob))
      .toEqual([0.58, 0.45, 0.40]);
  });

  it("sorts by stake with 'no stake' LAST, not treated as zero", () => {
    const out = applyFilters(ROWS, filters({ sortKey: "stake" }));
    expect(out.map((r) => r.bet.halfKelly)).toEqual([0.025, 0.02, null]);
    // A null stake is "could not be derived", not "very small". Sorting it as 0
    // would bury an unknown among the genuinely marginal.
    expect(out[out.length - 1].bet.halfKelly).toBeNull();
  });

  it("does not mutate the input array", () => {
    const before = ROWS.map((r) => r.fixture);
    applyFilters(ROWS, filters({ sortKey: "odds" }));
    expect(ROWS.map((r) => r.fixture)).toEqual(before);
  });
});

describe("CSV export", () => {
  it("exports the stake as a FRACTION and names it in the header", () => {
    const csv = toCsv([ROWS[0]]);
    const [header, first] = csv.trim().split("\n");
    expect(header).toContain("half_kelly_fraction");
    // Never a currency figure: the pipeline's £1,000 bankroll assumption would
    // travel into a spreadsheet that records nothing about it.
    expect(header).not.toContain("stake_gbp");
    expect(first).toContain("0.020000");
    expect(first).not.toContain("20.00");
  });

  it("exports whether each edge is de-vigged", () => {
    const csv = toCsv(ROWS);
    const lines = csv.trim().split("\n");
    expect(lines[1]).toContain("true");
    expect(lines[2]).toContain("false");
  });

  it("exports unknown rather than a blank for unknown de-vig status", () => {
    const csv = toCsv([row("x", { devigged: null })]);
    expect(csv).toContain("unknown");
  });

  it("leaves a null stake empty rather than writing 0", () => {
    const csv = toCsv([row("x", { halfKelly: null })]);
    const cells = csv.trim().split("\n")[1].split(",");
    // An empty cell is unknown; a 0 would read as a decided no-bet.
    expect(cells[6]).toBe("");
  });

  it("escapes commas and quotes in a fixture name", () => {
    const csv = toCsv([row('Nott\'m Forest v "The Blades", away')]);
    expect(csv).toContain('"Nott\'m Forest v ""The Blades"", away"');
  });

  it("exports only the rows given, so it matches what is on screen", () => {
    const shown = applyFilters(ROWS, filters({ minEdgePct: 10 }));
    const csv = toCsv(shown);
    expect(csv.trim().split("\n")).toHaveLength(2); // header + 1
  });

  it("emits a header even with no rows", () => {
    expect(toCsv([]).trim().split("\n")).toHaveLength(1);
  });
});

describe("filters compose", () => {
  it("market, edge and search apply together", () => {
    const out = applyFilters(ROWS, filters({
      market: "all", minEdgePct: 5, search: "v",
    }));
    expect(out).toHaveLength(2);
  });

  it("an over-restrictive combination yields nothing, not an error", () => {
    expect(applyFilters(ROWS, filters({ market: "Corners", minEdgePct: 19 })))
      .toEqual([]);
  });
});
