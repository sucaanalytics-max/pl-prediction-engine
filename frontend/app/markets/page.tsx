"use client";

/**
 * Markets — is there a bet, and what is the stake.
 *
 * **This is the real-money screen**, so two things are load-bearing rather than
 * stylistic.
 *
 * ## 1. Stakes are fractions, and only fractions
 *
 * `latest.json` carries four Kelly fields per bet and two of them are in a
 * different unit:
 *
 *     "full_kelly":     50.0     <- CURRENCY (0.05 x a hardcoded 1000 bankroll)
 *     "half_kelly_pct":  0.025   <- FRACTION
 *
 * `ValueBet` typed all four as bare `number`, and `lib/kelly.ts` declares an
 * unrelated `KellyResult.full_kelly` that IS a fraction and is rendered with
 * `pct()`. One copy-paste between the two files renders `pct(50.0)` — **5000%** —
 * as a recommended stake. The narrower therefore drops the currency fields
 * entirely and every stake here is a {@link Fraction}, minted by a constructor
 * that rejects anything outside [0, 1].
 *
 * ## 2. "No bets" has three meanings and they are different cards
 *
 * Zero bets with `odds_source === "the_odds_api"` means markets were priced and
 * nothing beat the edge threshold — an informative answer. Zero bets with
 * `"unavailable"` means no prices were fetched at all, which is a quota or an
 * outage. Collapsing them would report a failed fetch as a market judgement.
 *
 * And a third, found by reading the live artifact rather than the code: the
 * committed `health.json` says **`football_data`**, a value no current code path
 * writes — `run_pipeline.py:845` only ever emits the two above. Bucketing an
 * unrecognised vocabulary into either would be a confident answer derived from a
 * stale producer, so it gets its own card that says exactly that.
 */

import { useMemo, useState } from "react";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { ProvenanceStrip, Section, WhenProven } from "@/components/data/Artifact";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { proven } from "@/lib/data/artifact";
import { formatStake, stakeFor } from "@/lib/data/units";
import { pricingCopy, pricingOf } from "@/lib/data/pricing";
import {
  applyFilters, DEFAULT_FILTERS, MARKET_GROUPS, toCsv,
  type BetFilters, type BetRow, type Confidence, type MarketGroup, type SortKey,
} from "@/lib/data/bet-filters";
import type { Health, Latest, Prediction } from "@/lib/data/narrow";

/** Bankroll used only to show an illustrative cash figure beside the fraction. */
const ILLUSTRATIVE_BANKROLL = 100;

function rowsOf(latest: Latest): BetRow[] {
  return latest.predictions.flatMap((p: Prediction) =>
    p.value_bets.map((bet) => ({
      fixture: `${p.home_team} v ${p.away_team}`,
      bet,
    })),
  );
}

/**
 * Whether the edge has the book's margin removed.
 *
 * Shown per row, not as a page-level footnote, because it varies BY MARKET in the
 * live data: the 1X2 bets are de-vigged and the Over 2.5 ones are not. A single
 * caveat at the bottom would let a reader apply it to the wrong rows.
 */
function VigFlag({ devigged }: { devigged: boolean | null }) {
  if (devigged === true) {
    return (
      <span className="text-[10px]" style={{ color: "var(--text-4)" }} data-vig="clean">
        net of vig
      </span>
    );
  }
  if (devigged === false) {
    return (
      <span
        className="text-[10px] font-semibold"
        style={{ color: "var(--warning)" }}
        data-vig="inflated"
        title="edge = model_prob - implied_prob, and implied_prob here still contains the bookmaker's margin"
      >
        includes vig
      </span>
    );
  }
  return (
    <span className="text-[10px]" style={{ color: "var(--text-4)" }} data-vig="unknown">
      vig unknown
    </span>
  );
}

function Controls({
  filters, setFilters, shown, total, inflated, onExport,
}: {
  filters: BetFilters;
  setFilters: (f: BetFilters) => void;
  shown: number;
  total: number;
  inflated: number;
  onExport: () => void;
}) {
  const set = <K extends keyof BetFilters>(key: K, value: BetFilters[K]) =>
    setFilters({ ...filters, [key]: value });

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        {(Object.keys(MARKET_GROUPS) as MarketGroup[]).map((group) => (
          <button
            key={group}
            type="button"
            onClick={() => set("market", group)}
            aria-pressed={filters.market === group}
            className="px-2 py-1 rounded"
            style={{
              background: filters.market === group ? "var(--accent)" : "transparent",
              color: filters.market === group ? "#fff" : "var(--text-3)",
              border: "1px solid var(--border)",
            }}
          >
            {group}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <input
          type="search"
          value={filters.search}
          onChange={(e) => set("search", e.target.value)}
          placeholder="Search team or market…"
          aria-label="Search team or market"
          className="px-2 py-1 rounded"
          style={{ border: "1px solid var(--border)", background: "transparent",
                   color: "var(--text-1)" }}
        />
        <label className="flex items-center gap-2">
          <span style={{ color: "var(--text-3)" }}>Confidence</span>
          <select
            value={filters.confidence}
            aria-label="Confidence"
            onChange={(e) => set("confidence", e.target.value as Confidence)}
            style={{ background: "transparent", color: "var(--text-1)",
                     border: "1px solid var(--border)" }}
          >
            <option value="all">all</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span style={{ color: "var(--text-3)" }}>Sort</span>
          <select
            value={filters.sortKey}
            aria-label="Sort by"
            onChange={(e) => set("sortKey", e.target.value as SortKey)}
            style={{ background: "transparent", color: "var(--text-1)",
                     border: "1px solid var(--border)" }}
          >
            <option value="edge">edge</option>
            <option value="stake">stake</option>
            <option value="odds">odds</option>
            <option value="model_prob">model probability</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span style={{ color: "var(--text-3)" }}>Min edge</span>
          <input
            type="range" min={0} max={20} step={1} value={filters.minEdgePct}
            onChange={(e) => set("minEdgePct", Number(e.target.value))}
            aria-label={`Minimum edge: ${filters.minEdgePct}%`}
          />
          <span className="font-mono">{filters.minEdgePct}%</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox" checked={filters.devigedOnly}
            onChange={(e) => set("devigedOnly", e.target.checked)}
          />
          <span style={{ color: "var(--text-3)" }}>De-vigged only</span>
        </label>
        <button
          type="button" onClick={onExport}
          className="underline" style={{ color: "var(--accent)" }}
        >
          Export CSV
        </button>
      </div>

      <p style={{ color: "var(--text-4)" }}>
        {shown} of {total}
        {inflated > 0
          ? ` · ${inflated} edge${inflated === 1 ? "" : "s"} still include the book's margin`
          : ""}
      </p>
    </div>
  );
}

function BetsTable({ rows }: { rows: readonly BetRow[] }) {
  const [filters, setFilters] = useState<BetFilters>(DEFAULT_FILTERS);
  const shown = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const inflated = rows.filter((r) => r.bet.devigged === false).length;

  const exportCsv = () => {
    const blob = new Blob([toCsv(shown)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "value-bets.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      <Controls
        filters={filters} setFilters={setFilters}
        shown={shown.length} total={rows.length} inflated={inflated}
        onExport={exportCsv}
      />
      <div className="glass-panel rounded-none overflow-x-auto">
        <table className="data-table" aria-label="Value bets">
          <thead>
            <tr>
              <th scope="col">Fixture</th>
              <th scope="col">Market</th>
              <th scope="col" className="text-center">Edge</th>
              <th scope="col" className="text-center">Odds</th>
              <th scope="col" className="text-center">Half-Kelly</th>
              <th scope="col" className="text-center hidden sm:table-cell">
                per £{ILLUSTRATIVE_BANKROLL}
              </th>
              <th scope="col" className="hidden md:table-cell">Book</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ fixture, bet }, index) => (
              <tr key={`${fixture}-${bet.market}-${index}`} data-testid="bet">
                <td className="text-sm">{fixture}</td>
                <td className="text-sm">
                  {bet.market}
                  {bet.selection ? (
                    <span style={{ color: "var(--text-3)" }}> · {bet.selection}</span>
                  ) : null}
                </td>
                <td className="text-center font-mono text-sm">
                  <div>{(bet.edge * 100).toFixed(1)}%</div>
                  <VigFlag devigged={bet.devigged} />
                </td>
                <td className="text-center font-mono text-sm">
                  {bet.decimal_odds !== null ? bet.decimal_odds.toFixed(2) : "—"}
                </td>
                <td className="text-center font-mono text-sm font-bold">
                  {bet.halfKelly !== null ? formatStake(bet.halfKelly) : "no stake"}
                </td>
                <td className="text-center font-mono text-sm hidden sm:table-cell">
                  {bet.halfKelly !== null
                    ? `£${stakeFor(bet.halfKelly, ILLUSTRATIVE_BANKROLL).toFixed(2)}`
                    : "—"}
                </td>
                <td className="text-sm hidden md:table-cell"
                    style={{ color: "var(--text-3)" }}>
                  {bet.bookmaker ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The distinct kinds of "no bets".
 *
 * Separated because a quota failure, a market judgement and a stale producer look
 * identical as an empty table, and only one of them means the engine is working.
 */
function NoBets({ oddsSource }: { oddsSource: string | null }) {
  const pricing = pricingOf(oddsSource);
  const { headline, detail } = pricingCopy(pricing, oddsSource);
  return (
    <div className="card p-6 text-center" role="status" data-pricing={pricing}>
      <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>
        {headline}
      </p>
      <p className="text-xs mt-2" style={{ color: "var(--text-4)" }}>
        {detail}
      </p>
    </div>
  );
}

export default function MarketsPage() {
  const { artifact: latest } = useArtifact<Latest>(REGISTRY.latest);
  const { artifact: health } = useArtifact<Health>(REGISTRY.health);

  // Read across two artifacts, so it lives here rather than in an emptiness
  // predicate — a descriptor cannot see a second file.
  const oddsSource = proven(health)?.odds_source ?? null;

  return (
    <ErrorBoundary pageName="Markets">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Markets
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Where the model disagrees with the book — and what to stake
          </p>
        </header>

        <Section
          title="Value bets"
          subtitle="Half-Kelly as a fraction of bankroll. Never full Kelly: under-staking is recoverable, over-staking is not."
          aside={<ProvenanceStrip of={latest} />}
        >
          <WhenProven
            of={latest}
            what="No predictions are published, so no market can be assessed."
            // `empty` here means the explainability stage did not run, which does
            // NOT invalidate the value bets — the probability payload is real.
            showEmpty
            then={(value) => {
              const rows = rowsOf(value);
              return rows.length > 0
                ? <BetsTable rows={rows} />
                : <NoBets oddsSource={oddsSource} />;
            }}
          />
        </Section>

        <p className="text-xs" style={{ color: "var(--text-4)" }}>
          Stakes are a fraction of whatever bankroll you actually hold. The cash
          column is illustrative at £{ILLUSTRATIVE_BANKROLL} — the pipeline&apos;s own
          currency figures assume a hardcoded £1,000 and are deliberately not shown.
        </p>
      </div>
    </ErrorBoundary>
  );
}
