"use client";

import { useState, useMemo } from "react";
import { usePredictions } from "@/lib/PredictionsContext";
import { useDebounce } from "@/lib/hooks";
import {
  getAllValueBets,
  marketLabel,
  marketIcon,
  confidenceTier,
  effectiveEdge,
  getHalfKellyPct,
  type ValueBet,
} from "@/lib/predictions";
import { pct, odds, timeAgo, edgeColor } from "@/lib/formats";
import { ErrorBoundary, PageSkeleton, ErrorMessage } from "@/components/ErrorBoundary";

type MarketFilter = "all" | "1X2" | "Goals O/U" | "BTTS" | "Corners" | "Cards" | "Goalscorer" | "Player";
type ConfFilter = "all" | "high" | "medium" | "low";
type SortKey = "edge" | "kelly" | "odds" | "model_prob";

const MARKET_FILTERS: MarketFilter[] = ["all", "1X2", "Goals O/U", "BTTS", "Corners", "Cards", "Goalscorer", "Player"];
const CONF_BADGES: Record<string, { label: string; cls: string }> = {
  high: { label: "HIGH", cls: "badge-green" },
  medium: { label: "MED", cls: "badge-amber" },
  low: { label: "LOW", cls: "text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider" },
};

type FlatBet = ValueBet & { match_id: string; home_team: string; away_team: string };

function ValueBetsContent() {
  const { predictions: data, loading, error, refresh } = usePredictions();

  // Filters & sort state
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const [confFilter, setConfFilter] = useState<ConfFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("edge");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [minEdge, setMinEdge] = useState(0);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);

  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !data) return <PageSkeleton rows={5} />;

  const allBets = getAllValueBets(data);

  // Apply filters
  const filtered = useMemo(() => {
    let bets = allBets;

    if (marketFilter !== "all") {
      bets = bets.filter((b) => marketLabel(b.market) === marketFilter);
    }
    if (confFilter !== "all") {
      bets = bets.filter((b) => (b.confidence_tier ?? confidenceTier(effectiveEdge(b))) === confFilter);
    }
    if (minEdge > 0) {
      bets = bets.filter((b) => effectiveEdge(b) >= minEdge / 100);
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      bets = bets.filter(
        (b) =>
          b.home_team.toLowerCase().includes(q) ||
          b.away_team.toLowerCase().includes(q) ||
          b.market.toLowerCase().includes(q) ||
          (b.selection ?? "").toLowerCase().includes(q)
      );
    }

    // Sort
    bets = [...bets].sort((a, b) => {
      let av: number, bv: number;
      switch (sortKey) {
        case "edge":
          av = effectiveEdge(a);
          bv = effectiveEdge(b);
          break;
        case "kelly":
          av = getHalfKellyPct(a);
          bv = getHalfKellyPct(b);
          break;
        case "odds":
          av = a.decimal_odds ?? 0;
          bv = b.decimal_odds ?? 0;
          break;
        case "model_prob":
          av = a.model_prob;
          bv = b.model_prob;
          break;
        default:
          av = effectiveEdge(a);
          bv = effectiveEdge(b);
      }
      return sortDir === "desc" ? bv - av : av - bv;
    });

    return bets;
  }, [allBets, marketFilter, confFilter, minEdge, debouncedSearch, sortKey, sortDir]);

  // Summary stats
  const totalEdge = allBets.reduce((s, b) => s + effectiveEdge(b), 0);
  const avgEdge = allBets.length > 0 ? totalEdge / allBets.length : 0;
  const bestEdge = allBets.length > 0 ? effectiveEdge(allBets[0]) : 0;
  const totalKelly = allBets.reduce((s, b) => s + getHalfKellyPct(b), 0);

  // Market counts for filter badges
  const marketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of allBets) {
      const m = marketLabel(b.market);
      counts[m] = (counts[m] ?? 0) + 1;
    }
    return counts;
  }, [allBets]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-bold text-white tracking-tight">
          Value Bets
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Matchweek {data.metadata.gameweek} · {allBets.length} opportunities ·
          Updated {timeAgo(data.metadata.generated_at)}
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card p-4">
          <div className="stat-label">Bets Found</div>
          <div className="stat-value text-white">{allBets.length}</div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Avg Edge</div>
          <div className="stat-value text-emerald-400">
            {allBets.length > 0 ? pct(avgEdge) : "—"}
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Best Edge</div>
          <div className="stat-value text-emerald-400">
            {allBets.length > 0 ? pct(bestEdge) : "—"}
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Total ½K Stake</div>
          <div className="stat-value text-sky-400">
            {allBets.length > 0 ? pct(totalKelly) : "—"}
          </div>
        </div>
      </div>

      <div className="glow-line" />

      {/* Filters */}
      <div className="space-y-4">
        {/* Market filter row */}
        <div className="flex flex-wrap gap-2">
          {MARKET_FILTERS.map((m) => {
            const count = m === "all" ? allBets.length : (marketCounts[m] ?? 0);
            if (m !== "all" && count === 0) return null;
            return (
              <button
                key={m}
                onClick={() => setMarketFilter(m)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  marketFilter === m
                    ? "bg-pitch-600 text-white"
                    : "bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50"
                }`}
              >
                {m === "all" ? "All" : m}
                <span className="ml-1.5 text-[10px] opacity-60">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Second row: confidence + edge + search */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Confidence filter */}
          <div className="flex gap-1.5">
            {(["all", "high", "medium", "low"] as ConfFilter[]).map((c) => (
              <button
                key={c}
                onClick={() => setConfFilter(c)}
                className={`px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  confFilter === c
                    ? c === "high"
                      ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30"
                      : c === "medium"
                      ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/30"
                      : c === "low"
                      ? "bg-slate-700/50 text-slate-300 ring-1 ring-slate-600/30"
                      : "bg-pitch-600 text-white"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {c === "all" ? "ALL" : c.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Min edge slider */}
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Min edge:</span>
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={minEdge}
              onChange={(e) => setMinEdge(Number(e.target.value))}
              className="w-20 accent-pitch-500"
            />
            <span className="w-8 text-right text-slate-300">{minEdge}%</span>
          </div>

          {/* Search */}
          <div className="ml-auto relative">
            <input
              type="text"
              placeholder="Search team or market…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 w-52 focus:outline-none focus:ring-1 focus:ring-pitch-500"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Results count */}
      {filtered.length !== allBets.length && (
        <p className="text-xs text-slate-500">
          Showing {filtered.length} of {allBets.length} bets
        </p>
      )}

      {/* Table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800/60 text-left text-[11px] text-slate-500 uppercase tracking-wider">
              <th className="px-4 py-3 font-medium">Match</th>
              <th className="px-4 py-3 font-medium">Market</th>
              <th
                className="px-4 py-3 font-medium cursor-pointer hover:text-white transition-colors"
                onClick={() => toggleSort("model_prob")}
              >
                Model{sortArrow("model_prob")}
              </th>
              <th className="px-4 py-3 font-medium hidden sm:table-cell">Implied</th>
              <th className="px-4 py-3 font-medium hidden md:table-cell">Devig</th>
              <th
                className="px-4 py-3 font-medium cursor-pointer hover:text-white transition-colors"
                onClick={() => toggleSort("odds")}
              >
                Odds{sortArrow("odds")}
              </th>
              <th
                className="px-4 py-3 font-medium cursor-pointer hover:text-white transition-colors"
                onClick={() => toggleSort("edge")}
              >
                Edge{sortArrow("edge")}
              </th>
              <th
                className="px-4 py-3 font-medium cursor-pointer hover:text-white transition-colors hidden sm:table-cell"
                onClick={() => toggleSort("kelly")}
              >
                ½ Kelly{sortArrow("kelly")}
              </th>
              <th className="px-4 py-3 font-medium hidden md:table-cell">Conf</th>
              <th className="px-4 py-3 font-medium hidden lg:table-cell">Book</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-slate-500">
                  No value bets match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((bet, i) => {
                const tier = bet.confidence_tier ?? confidenceTier(effectiveEdge(bet));
                const badge = CONF_BADGES[tier] ?? CONF_BADGES.low;
                const mLabel = marketLabel(bet.market);
                const edge = effectiveEdge(bet);
                const kellyPct = getHalfKellyPct(bet);

                return (
                  <tr
                    key={`${bet.match_id}-${bet.market}-${i}`}
                    className="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors"
                  >
                    {/* Match */}
                    <td className="px-4 py-3">
                      <div className="text-white font-medium text-xs">
                        {bet.home_team} v {bet.away_team}
                      </div>
                    </td>

                    {/* Market */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs opacity-60">{marketIcon(bet.market)}</span>
                        <div>
                          <div className="text-white text-xs">
                            {bet.selection ?? bet.market}
                          </div>
                          <div className="text-[10px] text-slate-500">{mLabel}</div>
                        </div>
                      </div>
                    </td>

                    {/* Model prob */}
                    <td className="px-4 py-3 text-white font-mono text-xs">
                      {pct(bet.model_prob)}
                    </td>

                    {/* Implied prob */}
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs hidden sm:table-cell">
                      {pct(bet.implied_prob)}
                    </td>

                    {/* Devigged prob */}
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs hidden md:table-cell">
                      {bet.devigged_prob ? pct(bet.devigged_prob) : "—"}
                    </td>

                    {/* Odds */}
                    <td className="px-4 py-3 text-white font-mono text-xs">
                      {bet.decimal_odds ? odds(bet.decimal_odds) : "—"}
                    </td>

                    {/* Edge */}
                    <td className={`px-4 py-3 font-mono text-xs font-semibold ${edgeColor(edge)}`}>
                      {pct(edge)}
                    </td>

                    {/* Half Kelly */}
                    <td className="px-4 py-3 text-sky-400 font-mono text-xs hidden sm:table-cell">
                      {kellyPct > 0 ? pct(kellyPct) : "—"}
                    </td>

                    {/* Confidence */}
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className={`${badge.cls} text-[10px]`}>{badge.label}</span>
                    </td>

                    {/* Bookmaker */}
                    <td className="px-4 py-3 text-slate-500 text-[11px] hidden lg:table-cell">
                      {bet.bookmaker?.replace(/_/g, " ") ?? "—"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Disclaimer */}
      <div className="text-[10px] text-slate-600 text-center max-w-xl mx-auto">
        All predictions are model-generated and for informational purposes only.
        Past performance does not guarantee future results. Always bet responsibly.
        Edges shown are devigged where available. Kelly stakes assume independent events.
      </div>
    </div>
  );
}

export default function ValueBetsPage() {
  return (
    <ErrorBoundary pageName="Value Bets">
      <ValueBetsContent />
    </ErrorBoundary>
  );
}
