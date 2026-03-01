"use client";

import { useEffect, useState, useMemo } from "react";
import { loadPlayerStats, type PlayerStat } from "@/lib/predictions";
import { useDebounce } from "@/lib/hooks";
import { POS_COLORS, POS_BG } from "@/lib/theme";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";

type SortKey =
  | "goals_per_90"
  | "xg_per_90"
  | "assists_per_90"
  | "yellows_per_90"
  | "fouls_per_90"
  | "minutes"
  | "expected_goals"
  | "goals_scored"
  | "form";
type PosFilter = "all" | "GKP" | "DEF" | "MID" | "FWD";

const SORT_OPTIONS: Array<{ key: SortKey; label: string }> = [
  { key: "goals_per_90", label: "Goals/90" },
  { key: "xg_per_90", label: "xG/90" },
  { key: "assists_per_90", label: "Assists/90" },
  { key: "expected_goals", label: "Total xG" },
  { key: "yellows_per_90", label: "Yellows/90" },
  { key: "fouls_per_90", label: "Fouls/90" },
  { key: "minutes", label: "Minutes" },
];

const PAGE_SIZE = 25;

function PlayersContent() {
  const [players, setPlayers] = useState<PlayerStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("xg_per_90");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [posFilter, setPosFilter] = useState<PosFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebounce(search, 250);

  useEffect(() => {
    loadPlayerStats()
      .then(setPlayers)
      .catch((e) => setError(e.message));
  }, []);

  // All useMemo/hooks must be before any early return (Rules of Hooks)
  const filtered = useMemo(() => {
    if (!players) return [];
    let data = players;

    if (posFilter !== "all") {
      data = data.filter((p) => p.position === posFilter);
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      data = data.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.web_name.toLowerCase().includes(q) ||
          p.team.toLowerCase().includes(q)
      );
    }

    data = [...data].sort((a, b) => {
      const av = (a[sortKey] as number) ?? 0;
      const bv = (b[sortKey] as number) ?? 0;
      return sortDir === "desc" ? bv - av : av - bv;
    });

    return data;
  }, [players, posFilter, debouncedSearch, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const posCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of players ?? []) c[p.position] = (c[p.position] ?? 0) + 1;
    return c;
  }, [players]);

  // Early returns after all hooks — show graceful "unavailable" state for 404
  if (error) {
    const isNotFound = error.includes("404") || error.toLowerCase().includes("failed");
    if (isNotFound) {
      return (
        <div className="space-y-4">
          <h1 className="text-2xl font-bold text-white tracking-tight" style={{ fontFamily: "var(--font-jakarta)" }}>
            Player Stats
          </h1>
          <div className="card p-10 text-center">
            <p className="text-slate-400 text-sm font-medium mb-1">Player data not available</p>
            <p className="text-slate-600 text-xs">
              Player stats are generated separately from match predictions. Check back after the next pipeline run.
            </p>
          </div>
        </div>
      );
    }
    return <ErrorMessage message={error} onRetry={() => window.location.reload()} />;
  }
  if (!players) return <PageSkeleton rows={6} />;

  // Non-hook computations that require players to be non-null
  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  // Card magnet threshold: top 10% yellows_per_90
  const yellowsSorted = [...players].sort((a, b) => (b.yellows_per_90 ?? 0) - (a.yellows_per_90 ?? 0));
  const cardMagnetThreshold = yellowsSorted[Math.floor(yellowsSorted.length * 0.1)]?.yellows_per_90 ?? 999;

  // Goal machine threshold: top 10% xG/90 (excluding GKP)
  const xgSorted = [...players].filter(p => p.position !== "GKP").sort((a, b) => b.xg_per_90 - a.xg_per_90);
  const goalMachineThreshold = xgSorted[Math.floor(xgSorted.length * 0.1)]?.xg_per_90 ?? 999;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight" style={{ fontFamily: "var(--font-jakarta)" }}>
          Player Stats
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {players.length} players · FPL API data · Goalscorer & booking analysis
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Position filter */}
        <fieldset className="flex gap-1.5" aria-label="Filter by position">
          {(["all", "GKP", "DEF", "MID", "FWD"] as PosFilter[]).map((pos) => (
            <button
              key={pos}
              onClick={() => { setPosFilter(pos); setPage(0); }}
              className={`px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors border ${
                posFilter === pos
                  ? pos === "all"
                    ? "bg-green-700 text-white border-green-600/30"
                    : `${POS_BG[pos] ?? "text-white bg-slate-800/60 border-slate-700/50"}`
                  : "text-slate-500 hover:text-slate-300 border-transparent"
              }`}
              aria-pressed={posFilter === pos}
            >
              {pos === "all" ? `ALL (${players.length})` : `${pos} (${posCounts[pos] ?? 0})`}
            </button>
          ))}
        </fieldset>

        {/* Sort pills */}
        <div className="flex gap-1.5 flex-wrap">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => toggleSort(opt.key)}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                sortKey === opt.key
                  ? "bg-green-500/15 text-green-400 ring-1 ring-green-500/25"
                  : "text-slate-500 hover:text-white"
              }`}
            >
              {opt.label}{sortArrow(opt.key)}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="ml-auto relative">
          <label htmlFor="player-search" className="sr-only">Search player or team</label>
          <input
            id="player-search"
            type="text"
            placeholder="Search player or team…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="form-input !w-52 !text-xs !py-1.5"
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

      {/* Pagination info */}
      {(() => {
        const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
        const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const start = page * PAGE_SIZE + 1;
        const end = Math.min((page + 1) * PAGE_SIZE, filtered.length);

        return (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500">
                {filtered.length === 0 ? "No players match" : `${start}–${end} of ${filtered.length} players`}
              </p>
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                    className="px-2 py-1 text-[10px] rounded glass-inset text-slate-400 disabled:opacity-30 hover:text-white transition-colors"
                  >
                    ← Prev
                  </button>
                  <span className="text-[10px] text-slate-500 px-2">{page + 1}/{totalPages}</span>
                  <button
                    onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                    disabled={page >= totalPages - 1}
                    className="px-2 py-1 text-[10px] rounded glass-inset text-slate-400 disabled:opacity-30 hover:text-white transition-colors"
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>

            {/* Mobile card layout */}
            <div className="sm:hidden space-y-2">
              {paged.length === 0 ? (
                <div className="card p-6 text-center text-slate-500 text-sm">No players match the current filters.</div>
              ) : paged.map((player) => {
                const isCardMagnet = (player.yellows_per_90 ?? 0) >= cardMagnetThreshold;
                const isGoalMachine = player.xg_per_90 >= goalMachineThreshold && player.position !== "GKP";
                return (
                  <div key={player.player_id} className="card p-3 flex items-center gap-3">
                    <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${POS_BG[player.position] ?? "text-slate-400 bg-slate-800/60 border-slate-700/50"}`}>
                      {player.position}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">{player.web_name}</div>
                      <div className="text-[10px] text-slate-500">{player.team} · {player.minutes} mins</div>
                    </div>
                    <div className="text-right text-xs font-mono space-y-0.5 flex-shrink-0">
                      <div className="text-emerald-400">{player.xg_per_90.toFixed(2)} xG/90</div>
                      <div className="text-amber-400">{(player.yellows_per_90 ?? 0).toFixed(2)} Y/90</div>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {isCardMagnet && <span className="badge-amber text-[7px]">□</span>}
                      {isGoalMachine && <span className="badge-green text-[7px]">⚽</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop table */}
            <div className="card overflow-x-auto hidden sm:block">
              <table className="data-table" aria-label="Player statistics">
                <thead>
                  <tr>
                    <th scope="col">Player</th>
                    <th scope="col">Team</th>
                    <th scope="col" className="text-center">Pos</th>
                    <th scope="col" className="text-right cursor-pointer hover:text-white" onClick={() => toggleSort("goals_per_90")}>
                      G/90{sortArrow("goals_per_90")}
                    </th>
                    <th scope="col" className="text-right cursor-pointer hover:text-white" onClick={() => toggleSort("xg_per_90")}>
                      xG/90{sortArrow("xg_per_90")}
                    </th>
                    <th scope="col" className="text-right cursor-pointer hover:text-white hidden md:table-cell" onClick={() => toggleSort("assists_per_90")}>
                      A/90{sortArrow("assists_per_90")}
                    </th>
                    <th scope="col" className="text-right cursor-pointer hover:text-white" onClick={() => toggleSort("yellows_per_90")}>
                      Y/90{sortArrow("yellows_per_90")}
                    </th>
                    <th scope="col" className="text-right cursor-pointer hover:text-white hidden md:table-cell" onClick={() => toggleSort("fouls_per_90")}>
                      F/90{sortArrow("fouls_per_90")}
                    </th>
                    <th scope="col" className="text-right cursor-pointer hover:text-white hidden lg:table-cell" onClick={() => toggleSort("minutes")}>
                      Mins{sortArrow("minutes")}
                    </th>
                    <th scope="col" className="text-right hidden lg:table-cell">Goals</th>
                    <th scope="col" className="text-center">Status</th>
                    <th scope="col" className="text-center">Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="px-4 py-8 text-center text-slate-500">
                        No players match the current filters.
                      </td>
                    </tr>
                  ) : (
                    paged.map((player) => {
                const isCardMagnet = (player.yellows_per_90 ?? 0) >= cardMagnetThreshold;
                const isGoalMachine = player.xg_per_90 >= goalMachineThreshold && player.position !== "GKP";
                const xgDiff = player.goals_per_90 - player.xg_per_90;

                return (
                  <tr key={player.player_id} className="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="text-white font-medium">{player.web_name}</div>
                      <div className="text-[10px] text-slate-600 sm:hidden">{player.team}</div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-400 hidden sm:table-cell">{player.team}</td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`text-[10px] font-mono font-semibold ${POS_COLORS[player.position] ?? "text-slate-400"}`}>
                        {player.position}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-emerald-400">{player.goals_per_90.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-300">{player.xg_per_90.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-sky-400 hidden md:table-cell">
                      {(player.assists_per_90 ?? 0).toFixed(2)}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono ${isCardMagnet ? "text-amber-400 font-semibold" : "text-slate-400"}`}>
                      {(player.yellows_per_90 ?? 0).toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-400 hidden md:table-cell">
                      {(player.fouls_per_90 ?? 0).toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-500 hidden lg:table-cell">
                      {player.minutes.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-400 hidden lg:table-cell">
                      {player.goals_scored}
                    </td>
                    <td className="px-3 py-2.5 text-center hidden sm:table-cell">
                      {player.available ? (
                        <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" title="Available" />
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-red-500 inline-block" title="Unavailable" />
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {isCardMagnet && (
                          <span className="badge-amber text-[8px]" title="Card magnet — top 10% yellows/90">□</span>
                        )}
                        {isGoalMachine && (
                          <span className="badge-green text-[8px]" title="Goal threat — top 10% xG/90">⚽</span>
                        )}
                        {xgDiff > 0.15 && (
                          <span className="text-[8px] text-emerald-500 bg-emerald-500/10 px-1 rounded" title="Overperforming xG">↑</span>
                        )}
                        {xgDiff < -0.15 && (
                          <span className="text-[8px] text-red-400 bg-red-500/10 px-1 rounded" title="Underperforming xG">↓</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
                  </tbody>
                </table>
              </div>

              {/* Bottom pagination */}
              {totalPages > 1 && (
                <div className="flex justify-center gap-1 pt-2">
                  <button
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                    className="px-2 py-1 text-[10px] rounded glass-inset text-slate-400 disabled:opacity-30 hover:text-white transition-colors"
                  >
                    ← Prev
                  </button>
                  <span className="text-[10px] text-slate-500 px-2 py-1">{page + 1}/{totalPages}</span>
                  <button
                    onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                    disabled={page >= totalPages - 1}
                    className="px-2 py-1 text-[10px] rounded glass-inset text-slate-400 disabled:opacity-30 hover:text-white transition-colors"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          );
        })()}

      <p className="text-[10px] text-slate-600 text-center">
        Stats from FPL API · □ = Card magnet (top 10% Y/90) · ⚽ = Goal threat (top 10% xG/90) · ↑↓ = xG over/underperformance
      </p>
    </div>
  );
}

export default function PlayersPage() {
  return (
    <ErrorBoundary pageName="Players">
      <PlayersContent />
    </ErrorBoundary>
  );
}
