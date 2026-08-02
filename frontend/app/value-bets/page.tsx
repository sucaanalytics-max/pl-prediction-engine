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
      <div className="relative z-10 mb-4">
        <h1
          className="text-4xl md:text-5xl font-extrabold tracking-tighter bg-clip-text text-transparent drop-shadow-sm mb-2"
          style={{ backgroundImage: "linear-gradient(135deg, var(--text-1) 0%, var(--accent) 100%)", fontFamily: "var(--font-jakarta)" }}
        >
          Value Bets
        </h1>
        <p className="text-sm font-medium tracking-wide" style={{ color: "var(--text-3)" }}>
          Matchweek {data.metadata.gameweek} <span className="mx-1.5 opacity-50">•</span> {allBets.length} opportunities <span className="mx-1.5 opacity-50">•</span>{" "}
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
        <div className="flex flex-wrap gap-2.5">
          {MARKET_FILTERS.map((m) => {
            const count = m === "all" ? allBets.length : (marketCounts[m] ?? 0);
            if (m !== "all" && count === 0) return null;
            const isActive = marketFilter === m;
            return (
              <button
                key={m}
                onClick={() => setMarketFilter(m)}
                className="px-4 py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all duration-300 hover:scale-[1.02] shadow-sm flex items-center gap-2"
                style={
                  isActive
                    ? { background: "var(--accent)", color: "#fff", boxShadow: "var(--glow-accent)" }
                    : { background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-3)" }
                }
              >
                {m === "all" ? "All Markets" : m}
                <span className={`px-1.5 py-0.5 rounded text-[9px] ${isActive ? 'bg-white/20 text-white' : 'glass-panel text-[var(--text-2)]'}`}>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Second row: confidence + edge + search */}
        <div className="flex flex-wrap items-center gap-4 pt-2">
          {/* Confidence filter */}
          <div className="flex gap-2 glass-panel p-1.5 rounded-xl border border-[var(--border)]">
            {(["all", "high", "medium", "low"] as ConfFilter[]).map((c) => (
              <button
                key={c}
                onClick={() => setConfFilter(c)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${confFilter === c
                    ? c === "high"
                      ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/50 shadow-[0_0_10px_rgba(16,185,129,0.2)]"
                      : c === "medium"
                        ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/50 shadow-[0_0_10px_rgba(245,158,11,0.2)]"
                        : c === "low"
                          ? "bg-slate-700/50 text-slate-300 ring-1 ring-slate-600/50"
                          : ""
                    : "hover:bg-white/5"
                  }`}
                style={
                  confFilter === c && c === "all"
                    ? { background: "var(--accent-muted)", color: "var(--accent)", border: "1px solid var(--accent-border)", boxShadow: "var(--glow-accent)" }
                    : confFilter !== c
                      ? { color: "var(--text-4)" }
                      : undefined
                }
              >
                {c === "all" ? "ALL CONF" : c}
              </button>
            ))}
          </div>

          {/* Min edge slider */}
          <div className="flex items-center gap-3 text-xs glass-panel px-4 py-2 rounded-xl border border-[var(--border)]" style={{ color: "var(--text-3)" }}>
            <label htmlFor="min-edge-slider" className="sr-only">Minimum edge percentage</label>
            <span aria-hidden="true" className="font-semibold uppercase tracking-wider text-[10px]">Min Edge:</span>
            <input
              id="min-edge-slider"
              type="range"
              min={0}
              max={20}
              step={1}
              value={minEdge}
              onChange={(e) => setMinEdge(Number(e.target.value))}
              className="w-24 accent-[var(--accent)]"
              aria-label={`Minimum edge: ${minEdge}%`}
            />
            <span className="w-8 text-right font-mono font-bold text-[var(--accent)]">{minEdge}%</span>
          </div>

          {/* Search */}
          <div className="ml-auto relative w-full sm:w-auto">
            <label htmlFor="vb-search" className="sr-only">Search value bets by team or market</label>
            <div className="relative">
              <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-4)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                id="vb-search"
                type="text"
                placeholder="Search team or market…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full sm:w-64 pl-9 pr-8 py-2.5 text-sm bg-[var(--surface)] border border-[var(--border)] rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--accent)] transition-shadow text-[var(--text-1)] placeholder-[var(--text-4)] shadow-inner"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-4)] hover:text-[var(--text-2)] transition-colors"
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Results count + Export */}
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          Showing {filtered.length} of {allBets.length} bets
          {minEdge > 0 && <span> · edges ≥ {minEdge}%</span>}
        </p>
        {filtered.length > 0 && (
          <button
            onClick={exportCSV}
            className="text-[11px] transition-colors flex items-center gap-1"
            style={{ color: "var(--text-3)" }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export CSV
          </button>
        )}
      </div>

      {/* Mobile card layout (below 640px) */}
      <div className="sm:hidden space-y-3 mt-4">
        {filtered.length === 0 ? (
          <div className="glass-panel p-8 text-center rounded-2xl border-dashed border-2">
            <p className="text-lg font-medium" style={{ color: "var(--text-2)" }}>No value bets match your filters.</p>
            <p className="text-sm mt-2" style={{ color: "var(--text-4)" }}>Try adjusting the minimum edge or confidence level.</p>
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
                className="glass-inset rounded-xl p-4 space-y-3 relative overflow-hidden shadow-sm"
              >
                {tier === "high" && <div className="absolute top-0 left-0 w-1 h-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]" />}
                <div className="flex items-start justify-between relative z-10">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full glass-panel flex flex-shrink-0 items-center justify-center text-[var(--accent)] shadow-inner mt-1">
                      <span className="text-sm opacity-80" role="img" aria-label={MARKET_ICON_LABELS[icon] ?? "Market"}>{icon}</span>
                    </div>
                    <div>
                      <div className="text-xs font-semibold mb-1" style={{ color: "var(--text-3)" }}>{bet.home_team} <span className="text-[10px] opacity-50 mx-1">v</span> {bet.away_team}</div>
                      <div className="text-base font-bold" style={{ color: "var(--text-1)" }}>{bet.selection ?? bet.market}</div>
                    </div>
                  </div>
                  <span className={`${badge.cls} shadow-sm px-2 py-0.5 text-[9px] mt-1`}>{badge.label}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 bg-[var(--surface)] p-3 rounded-lg border border-[var(--border)] relative z-10">
                  <div className="flex flex-col">
                    <span className="text-[9px] uppercase tracking-wider text-[var(--text-4)] mb-0.5 font-bold">Est. Edge</span>
                    <span className={`font-mono font-extrabold text-sm ${edgeColor(edge)}`}>{edgePrefix(edge)}{pct(edge)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[9px] uppercase tracking-wider text-[var(--text-4)] mb-0.5 font-bold">Top Odds</span>
                    <span className="font-mono text-sm" style={{ color: "var(--text-1)" }}>{bet.decimal_odds ? odds(bet.decimal_odds) : "—"}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[9px] uppercase tracking-wider text-[var(--text-4)] mb-0.5 font-bold">½ Kelly</span>
                    <span className="font-mono text-sm" style={{ color: "var(--info)" }}>{kellyPct > 0 ? pct(kellyPct) : "—"}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Desktop table (640px+) */}
      <div className="glass-panel overflow-hidden hidden sm:block mt-4 rounded-2xl border border-[var(--border)] shadow-[var(--shadow-lg)]">
        <table className="w-full text-left border-collapse" aria-label="Value bets">
          <thead>
            <tr className="bg-[var(--surface2)] text-[10px] uppercase tracking-[0.1em] text-[var(--text-3)] border-b border-[var(--border)]">
              <th scope="col" className="px-5 py-4 font-bold">Match</th>
              <th scope="col" className="px-5 py-4 font-bold">Market</th>
              <th
                scope="col"
                className="px-5 py-4 font-bold cursor-pointer hover:text-[var(--text-1)] transition-colors"
                onClick={() => toggleSort("model_prob")}
              >
                Model{sortArrow("model_prob")}
              </th>
              <th scope="col" className="px-5 py-4 font-bold">Implied</th>
              <th scope="col" className="px-5 py-4 font-bold hidden xl:table-cell">Devig</th>
              <th
                scope="col"
                className="px-5 py-4 font-bold cursor-pointer hover:text-[var(--text-1)] transition-colors"
                onClick={() => toggleSort("odds")}
              >
                Odds{sortArrow("odds")}
              </th>
              <th
                scope="col"
                className="px-5 py-4 font-bold cursor-pointer hover:text-[var(--accent)] transition-colors text-[var(--accent)]"
                onClick={() => toggleSort("edge")}
              >
                Edge{sortArrow("edge")}
              </th>
              <th
                scope="col"
                className="px-5 py-4 font-bold cursor-pointer hover:text-[var(--info)] transition-colors"
                onClick={() => toggleSort("kelly")}
              >
                ½ Kelly{sortArrow("kelly")}
              </th>
              <th scope="col" className="px-5 py-4 font-bold hidden lg:table-cell">Conf</th>
              <th scope="col" className="px-5 py-4 font-bold hidden xl:table-cell text-right">Book</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-black/5 dark:bg-white/[0.02]">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-5 py-12 text-center text-sm font-medium" style={{ color: "var(--text-3)" }}>
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
                    className="group hover:bg-[var(--surface2)] transition-colors relative"
                  >
                    <td className="px-5 py-3 relative">
                      {tier === "high" && <div className="absolute left-0 top-0 bottom-0 w-1 bg-[var(--accent)] rounded-r shadow-[0_0_10px_var(--accent)]" />}
                      <div className="font-semibold text-xs" style={{ color: "var(--text-2)" }}>
                        {bet.home_team} <span className="text-[10px] opacity-50 mx-1">v</span> {bet.away_team}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full glass-inset flex items-center justify-center text-[var(--accent)]">
                          <span className="text-xs opacity-80" role="img" aria-label={MARKET_ICON_LABELS[icon] ?? "Market"}>{icon}</span>
                        </div>
                        <div>
                          <div className="text-sm font-bold" style={{ color: "var(--text-1)" }}>{bet.selection ?? bet.market}</div>
                          <div className="text-[10px] uppercase font-semibold tracking-wider mt-0.5" style={{ color: "var(--text-4)" }}>{mLabel}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono text-sm font-semibold" style={{ color: "var(--success)" }}>{pct(bet.model_prob)}</td>
                    <td className="px-5 py-3 font-mono text-sm font-medium" style={{ color: "var(--text-3)" }}>{pct(bet.implied_prob)}</td>
                    <td className="px-5 py-3 font-mono text-sm font-medium hidden xl:table-cell" style={{ color: "var(--text-3)" }}>{bet.devigged_prob ? pct(bet.devigged_prob) : "—"}</td>
                    <td className="px-5 py-3 font-mono text-sm font-bold" style={{ color: "var(--text-1)" }}>
                      {bet.decimal_odds ? (
                        <span className="glass-panel px-2 py-0.5 rounded border border-[var(--border)]">{odds(bet.decimal_odds)}</span>
                      ) : "—"}
                    </td>
                    <td className={`px-5 py-3 font-mono text-sm font-black drop-shadow-sm ${edgeColor(edge)}`}>{edgePrefix(edge)}{pct(edge)}</td>
                    <td className="px-5 py-3 font-mono text-xs font-bold" style={{ color: "var(--info)" }}>
                      {kellyPct > 0 ? (
                        <span className="bg-[var(--info-muted)] border border-[var(--info-border)] px-2 py-0.5 rounded text-[var(--info)]">{pct(kellyPct)}</span>
                      ) : "—"}
                    </td>
                    <td className="px-5 py-3 hidden lg:table-cell"><span className={`${badge.cls} text-[9px] shadow-sm`}>{badge.label}</span></td>
                    <td className="px-5 py-3 text-[10px] hidden xl:table-cell text-right uppercase tracking-wider font-semibold" style={{ color: "var(--text-4)" }}>{bet.bookmaker?.replace(/_/g, " ") ?? "—"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Disclaimer */}
      <div className="text-[10px] text-center max-w-xl mx-auto" style={{ color: "var(--text-4)" }}>
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
