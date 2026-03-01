"use client";

import { useEffect, useState, useMemo } from "react";
import { loadPlayerStats, type PlayerStat } from "@/lib/predictions";
import { pct } from "@/lib/formats";
import { useDebounce } from "@/lib/hooks";
import { ErrorBoundary, PageSkeleton, ErrorMessage } from "@/components/ErrorBoundary";

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

const POS_COLORS: Record<string, string> = {
  GKP: "text-purple-400",
  DEF: "text-emerald-400",
  MID: "text-sky-400",
  FWD: "text-red-400",
};

function PlayersContent() {
  const [players, setPlayers] = useState<PlayerStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("xg_per_90");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [posFilter, setPosFilter] = useState<PosFilter>("all");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);

  useEffect(() => {
    loadPlayerStats()
      .then(setPlayers)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <ErrorMessage message={error} onRetry={() => window.location.reload()} />;
  if (!players) return <PageSkeleton rows={6} />;

  const filtered = useMemo(() => {
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

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  // Card magnet threshold: top 10% yellows_per_90
  const yellowsSorted = [...players].sort((a, b) => (b.yellows_per_90 ?? 0) - (a.yellows_per_90 ?? 0));
  const cardMagnetThreshold = yellowsSorted[Math.floor(yellowsSorted.length * 0.1)]?.yellows_per_90 ?? 999;

  // Goal machine threshold: top 10% xG/90 (excluding GKP)
  const xgSorted = [...players].filter(p => p.position !== "GKP").sort((a, b) => b.xg_per_90 - a.xg_per_90);
  const goalMachineThreshold = xgSorted[Math.floor(xgSorted.length * 0.1)]?.xg_per_90 ?? 999;

  const posCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of players) c[p.position] = (c[p.position] ?? 0) + 1;
    return c;
  }, [players]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-white tracking-tight">
          Player Stats
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {players.length} players · FPL API data · Goalscorer & booking analysis
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Position filter */}
        <div className="flex gap-1.5">
          {(["all", "GKP", "DEF", "MID", "FWD"] as PosFilter[]).map((pos) => (
            <button
              key={pos}
              onClick={() => setPosFilter(pos)}
              className={`px-2.5 py-1 rounded text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                posFilter === pos
                  ? pos === "all"
                    ? "bg-pitch-600 text-white"
                    : `${POS_COLORS[pos] ?? "text-white"} bg-slate-800/60 ring-1 ring-slate-700/50`
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {pos === "all" ? `ALL (${players.length})` : `${pos} (${posCounts[pos] ?? 0})`}
            </button>
          ))}
        </div>

        {/* Sort pills */}
        <div className="flex gap-1.5 flex-wrap">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => toggleSort(opt.key)}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                sortKey === opt.key
                  ? "bg-pitch-500/20 text-pitch-400 ring-1 ring-pitch-500/30"
                  : "bg-slate-800/40 text-slate-500 hover:text-white"
              }`}
            >
              {opt.label}{sortArrow(opt.key)}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="ml-auto relative">
          <input
            type="text"
            placeholder="Search player or team…"
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

      {filtered.length !== players.length && (
        <p className="text-xs text-slate-500">Showing {filtered.length} of {players.length} players</p>
      )}

      {/* Player table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-800/60 text-left text-[10px] text-slate-500 uppercase tracking-wider">
              <th className="px-4 py-3 font-medium">Player</th>
              <th className="px-3 py-3 font-medium hidden sm:table-cell">Team</th>
              <th className="px-3 py-3 font-medium text-center">Pos</th>
              <th className="px-3 py-3 font-medium text-right cursor-pointer hover:text-white" onClick={() => toggleSort("goals_per_90")}>
                G/90{sortArrow("goals_per_90")}
              </th>
              <th className="px-3 py-3 font-medium text-right cursor-pointer hover:text-white" onClick={() => toggleSort("xg_per_90")}>
                xG/90{sortArrow("xg_per_90")}
              </th>
              <th className="px-3 py-3 font-medium text-right cursor-pointer hover:text-white hidden md:table-cell" onClick={() => toggleSort("assists_per_90")}>
                A/90{sortArrow("assists_per_90")}
              </th>
              <th className="px-3 py-3 font-medium text-right cursor-pointer hover:text-white" onClick={() => toggleSort("yellows_per_90")}>
                Y/90{sortArrow("yellows_per_90")}
              </th>
              <th className="px-3 py-3 font-medium text-right cursor-pointer hover:text-white hidden md:table-cell" onClick={() => toggleSort("fouls_per_90")}>
                F/90{sortArrow("fouls_per_90")}
              </th>
              <th className="px-3 py-3 font-medium text-right cursor-pointer hover:text-white hidden lg:table-cell" onClick={() => toggleSort("minutes")}>
                Mins{sortArrow("minutes")}
              </th>
              <th className="px-3 py-3 font-medium text-right hidden lg:table-cell">Goals</th>
              <th className="px-3 py-3 font-medium text-center hidden sm:table-cell">Status</th>
              <th className="px-3 py-3 font-medium text-center">Tags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-4 py-8 text-center text-slate-500">
                  No players match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((player) => {
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
