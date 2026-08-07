/**
 * Filtering, sorting and exporting value bets.
 *
 * Pure, and in a lib rather than the page for the reason `next build` taught us:
 * Next.js validates a page's whole export shape, so an extra named export there
 * fails the build while `tsc --noEmit` and the test suite both pass.
 */

import type { Bet } from "@/lib/data/narrow";

export interface BetRow {
  readonly fixture: string;
  readonly bet: Bet;
}

/**
 * Market groupings as the pipeline labels them.
 *
 * Keyed on `market_type`, which the pipeline writes explicitly, rather than on
 * substrings of the display name — "Over 2.5 Goals" and "Goalscorer" both contain
 * words that a naive matcher would collide on.
 */
export const MARKET_GROUPS = {
  all: null,
  "1X2": ["1x2"],
  "Goals O/U": ["over_under"],
  BTTS: ["btts"],
  Corners: ["corners"],
  Cards: ["cards"],
  Goalscorer: ["goalscorer", "player"],
} as const;

export type MarketGroup = keyof typeof MARKET_GROUPS;
export type Confidence = "all" | "high" | "medium" | "low";
export type SortKey = "edge" | "stake" | "odds" | "model_prob";

export interface BetFilters {
  readonly market: MarketGroup;
  readonly confidence: Confidence;
  readonly minEdgePct: number;
  readonly search: string;
  readonly devigedOnly: boolean;
  readonly sortKey: SortKey;
}

export const DEFAULT_FILTERS: BetFilters = {
  market: "all",
  confidence: "all",
  minEdgePct: 0,
  search: "",
  devigedOnly: false,
  sortKey: "edge",
};

function matchesMarket(bet: Bet, group: MarketGroup): boolean {
  const types = MARKET_GROUPS[group];
  if (types === null) return true;
  return bet.market_type !== null && (types as readonly string[]).includes(bet.market_type);
}

export function applyFilters(
  rows: readonly BetRow[], filters: BetFilters,
): BetRow[] {
  const needle = filters.search.trim().toLowerCase();
  const out = rows.filter(({ fixture, bet }) => {
    if (!matchesMarket(bet, filters.market)) return false;
    if (filters.confidence !== "all" && bet.confidence !== filters.confidence) {
      return false;
    }
    if (bet.edge < filters.minEdgePct / 100) return false;
    if (filters.devigedOnly && bet.devigged !== true) return false;
    if (needle) {
      const haystack = `${fixture} ${bet.market} ${bet.selection ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const key = filters.sortKey;
  return out.sort((a, b) => {
    switch (key) {
      case "stake":
        // Nulls last: "no stake could be derived" is not a small stake, and
        // sorting it as zero would bury a bet whose size is simply unknown at the
        // bottom alongside genuinely marginal ones.
        if (a.bet.halfKelly === null && b.bet.halfKelly === null) return 0;
        if (a.bet.halfKelly === null) return 1;
        if (b.bet.halfKelly === null) return -1;
        return b.bet.halfKelly - a.bet.halfKelly;
      case "odds":
        return (b.bet.decimal_odds ?? 0) - (a.bet.decimal_odds ?? 0);
      case "model_prob":
        return b.bet.model_prob - a.bet.model_prob;
      default:
        return b.bet.edge - a.bet.edge;
    }
  });
}

/**
 * CSV of exactly what is on screen.
 *
 * The stake column is the FRACTION, and the header says so. Exporting a currency
 * figure would carry the pipeline's hardcoded £1,000 bankroll into a spreadsheet
 * where nothing records that assumption — and a number in a spreadsheet is
 * believed.
 *
 * `devigged` is exported too: an edge that still contains the book's margin must
 * not become an anonymous number in a column of comparable ones.
 */
export function toCsv(rows: readonly BetRow[]): string {
  const header = [
    "fixture", "market", "selection", "edge", "decimal_odds",
    "model_prob", "half_kelly_fraction", "devigged", "confidence",
  ];
  const escape = (value: string) =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const lines = rows.map(({ fixture, bet }) => [
    escape(fixture),
    escape(bet.market),
    escape(bet.selection ?? ""),
    bet.edge.toFixed(6),
    bet.decimal_odds !== null ? bet.decimal_odds.toFixed(4) : "",
    bet.model_prob.toFixed(6),
    bet.halfKelly !== null ? bet.halfKelly.toFixed(6) : "",
    bet.devigged === null ? "unknown" : String(bet.devigged),
    bet.confidence ?? "",
  ].join(","));

  return [header.join(","), ...lines].join("\n") + "\n";
}
