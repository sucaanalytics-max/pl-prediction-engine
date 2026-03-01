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
import { CONF_BADGES, MARKET_ICON_LABELS, edgePrefix } from "@/lib/theme";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";

type MarketFilter = "all" | "1X2" | "Goals O/U" | "BTTS" | "Corners" | "Cards" | "Goalscorer" | "Player";
type ConfFilter = "all" | "high" | "medium" | "low";
type SortKey = "edge" | "kelly" | "odds" | "model_prob";

const MARKET_FILTERS: MarketFilter[] = ["all", "1X2", "Goals O/U", "BTTS", "Corners", "Cards", "Goalscorer", "Player"];

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

  const allBets = useMemo(() => (data ? getAllValueBets(data) : []), [data]);

  // Apply filters — must be before any early return (Rules of Hooks)
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

  // Market counts for filter badges
  const marketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of allBets) {
      const m = marketLabel(b.market);
      counts[m] = (counts[m] ?? 0) + 1;
    }
    return counts;
  }, [allBets]);

  // Early returns after all hooks
  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !data) return <PageSkeleton rows={5} />;

  // Summary stats
  const totalEdge = allBets.reduce((s, b) => s + effectiveEdge(b), 0);
  const avgEdge = allBets.length > 0 ? totalEdge / allBets.length : 0;
  const bestEdge = allBets.length > 0 ? effectiveEdge(allBets[0]) : 0;
  const totalKelly = allBets.reduce((s, b) => s + getHalfKellyPct(b), 0);

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

  function exportCSV() {
    const header = ["Match", "Market", "Selection", "Model Prob", "Implied Prob", "Devig Prob", "Odds", "Edge", "Half Kelly", "Confidence", "Bookmaker"];
    const rows = filtered.map((b) => [
      `${b.home_team} v ${b.away_team}`,
      marketLabel(b.market),
      b.selection ?? b.market,
      (b.model_prob * 100).toFixed(1) + "%",
      (b.implied_prob * 100).toFixed(1) + "%",
      b.devigged_prob ? (b.devigged_prob * 100).toFixed(1) + "%" : "",
      b.decimal_odds?.toFixed(2) ?? "",
      (effectiveEdge(b) * 100).toFixed(1) + "%",
      (getHalfKellyPct(b) * 100).toFixed(1) + "%",
      b.confidence_tier ?? confidenceTier(effectiveEdge(b)),
      b.bookmaker?.replace(/_/g, " ") ?? "",
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `value-bets-gw${data?.metadata.gameweek ?? "unknown"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div>
        <h1
          className="text-2xl font-bold text-white tracking-tight"
          style={{ fontFamily: "var(--font-jakarta)" }}
        >
          Value Bets
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Matchweek {data.metadata.gameweek} · {allBets.length} opportunities ·
          Updated {timeAgo(data.metadata.generated_at)}
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Bets Found" value={allBets.length} />
        <StatCard
          label="Avg Edge"
          value={allBets.length > 0 ? pct(avgEdge) : "—"}
          accent={allBets.length > 0}
        />
        <StatCard
          label="Best Edge"
          value={allBets.length > 0 ? pct(bestEdge) : "—"}
          accent={allBets.length > 0}
        />
        <StatCard
          label="Total ½K Stake"
          value={allBets.length > 0 ? pct(totalKelly) : "—"}
        />
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
                    ? "bg-green-700 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
                style={marketFilter !== m ? { background: "var(--color-surface)", border: "1px solid var(--color-border)" } : undefined}
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
            <label htmlFor="min-edge-slider" className="sr-only">Minimum edge percentage</label>
            <span aria-hidden="true">Min edge:</span>
            <input
              id="min-edge-slider"
              type="range"
              min={0}
              max={20}
              step={1}
              value={minEdge}
              onChange={(e) => setMinEdge(Number(e.target.value))}
              className="w-20 accent-pitch-500"
              aria-label={`Minimum edge: ${minEdge}%`}
            />
            <span className="w-8 text-right text-slate-300">{minEdge}%</span>
          </div>

          {/* Search */}
          <div className="ml-auto relative">
            <label htmlFor="vb-search" className="sr-only">Search value bets by team or market</label>
            <input
              id="vb-search"
              type="text"
              placeholder="Search team or market…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="form-input text-xs w-52 py-1.5"
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

      {/* Results count + Export */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Showing {filtered.length} of {allBets.length} bets
          {minEdge > 0 && <span> · edges ≥ {minEdge}%</span>}
        </p>
        {filtered.length > 0 && (
          <button
            onClick={exportCSV}
            className="text-[11px] text-slate-500 hover:text-white transition-colors flex items-center gap-1"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export CSV
          </button>
        )}
      </div>

      {/* Mobile card layout (below 640px) */}
      <div className="sm:hidden space-y-2">
        {filtered.length === 0 ? (
          <div className="card p-6 text-center text-slate-500 text-sm">
            No value bets match the current filters.
          </div>
        ) : (
          filtered.map((bet, i) => {
            const tier = bet.confidence_tier ?? confidenceTier(effectiveEdge(bet));
            const badge = CONF_BADGES[tier] ?? CONF_BADGES.low;
            const edge = effectiveEdge(bet);
            const icon = marketIcon(bet.market);
            const kellyPct = getHalfKellyPct(bet);

            return (
              <div
                key={`m-${bet.match_id}-${bet.market}-${i}`}
                className="card p-3.5 space-y-2"
                style={tier === "high" ? { borderLeft: "3px solid #22c55e" } : undefined}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-slate-400">{bet.home_team} v {bet.away_team}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-xs" role="img" aria-label={MARKET_ICON_LABELS[icon] ?? "Market"}>{icon}</span>
                      <span className="text-sm font-medium text-white">{bet.selection ?? bet.market}</span>
                    </div>
                  </div>
                  <span className={`${badge.cls} text-[9px]`}>{badge.label}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-slate-500 text-[10px]">Edge</div>
                    <div className={`font-mono font-semibold ${edgeColor(edge)}`}>{edgePrefix(edge)}{pct(edge)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 text-[10px]">Odds</div>
                    <div className="font-mono text-white">{bet.decimal_odds ? odds(bet.decimal_odds) : "—"}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 text-[10px]">½ Kelly</div>
                    <div className="font-mono text-sky-400">{kellyPct > 0 ? pct(kellyPct) : "—"}</div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Desktop table (640px+) */}
      <div className="card overflow-x-auto hidden sm:block">
        <table className="data-table" aria-label="Value bets">
          <thead>
            <tr>
              <th scope="col">Match</th>
              <th scope="col">Market</th>
              <th
                scope="col"
                className="cursor-pointer hover:text-white transition-colors"
                onClick={() => toggleSort("model_prob")}
              >
                Model{sortArrow("model_prob")}
              </th>
              <th scope="col">Implied</th>
              <th scope="col" className="hidden md:table-cell">Devig</th>
              <th
                scope="col"
                className="cursor-pointer hover:text-white transition-colors"
                onClick={() => toggleSort("odds")}
              >
                Odds{sortArrow("odds")}
              </th>
              <th
                scope="col"
                className="cursor-pointer hover:text-white transition-colors"
                onClick={() => toggleSort("edge")}
              >
                Edge{sortArrow("edge")}
              </th>
              <th
                scope="col"
                className="cursor-pointer hover:text-white transition-colors"
                onClick={() => toggleSort("kelly")}
              >
                ½ Kelly{sortArrow("kelly")}
              </th>
              <th scope="col" className="hidden md:table-cell">Conf</th>
              <th scope="col" className="hidden lg:table-cell">Book</th>
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
                const icon = marketIcon(bet.market);
                const kellyPct = getHalfKellyPct(bet);

                return (
                  <tr
                    key={`${bet.match_id}-${bet.market}-${i}`}
                    style={tier === "high" ? { borderLeft: "3px solid #22c55e" } : undefined}
                  >
                    <td>
                      <div className="text-white font-medium text-xs">
                        {bet.home_team} v {bet.away_team}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs opacity-60" role="img" aria-label={MARKET_ICON_LABELS[icon] ?? "Market"}>{icon}</span>
                        <div>
                          <div className="text-white text-xs">{bet.selection ?? bet.market}</div>
                          <div className="text-[10px] text-slate-500">{mLabel}</div>
                        </div>
                      </div>
                    </td>
                    <td className="text-white font-mono text-xs">{pct(bet.model_prob)}</td>
                    <td className="text-slate-400 font-mono text-xs">{pct(bet.implied_prob)}</td>
                    <td className="text-slate-400 font-mono text-xs hidden md:table-cell">{bet.devigged_prob ? pct(bet.devigged_prob) : "—"}</td>
                    <td className="text-white font-mono text-xs">{bet.decimal_odds ? odds(bet.decimal_odds) : "—"}</td>
                    <td className={`font-mono text-xs font-semibold ${edgeColor(edge)}`}>{edgePrefix(edge)}{pct(edge)}</td>
                    <td className="text-sky-400 font-mono text-xs">{kellyPct > 0 ? pct(kellyPct) : "—"}</td>
                    <td className="hidden md:table-cell"><span className={`${badge.cls} text-[10px]`}>{badge.label}</span></td>
                    <td className="text-slate-500 text-[11px] hidden lg:table-cell">{bet.bookmaker?.replace(/_/g, " ") ?? "—"}</td>
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
