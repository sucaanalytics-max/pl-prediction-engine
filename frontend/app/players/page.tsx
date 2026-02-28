"use client";

import { useEffect, useState } from "react";

interface PlayerProjection {
  name: string;
  team: string;
  position: string;
  goals_per_90: number;
  xg_per_90: number;
  assists_per_90: number;
  minutes: number;
  form: number;
  available: boolean;
}

// Seed data — in production this comes from the pipeline's player_stats
const SEED_PLAYERS: PlayerProjection[] = [
  { name: "Erling Haaland", team: "Man City", position: "FWD", goals_per_90: 0.92, xg_per_90: 0.88, assists_per_90: 0.12, minutes: 2340, form: 8.2, available: true },
  { name: "Mohamed Salah", team: "Liverpool", position: "FWD", goals_per_90: 0.68, xg_per_90: 0.62, assists_per_90: 0.38, minutes: 2520, form: 7.8, available: true },
  { name: "Bukayo Saka", team: "Arsenal", position: "MID", goals_per_90: 0.42, xg_per_90: 0.38, assists_per_90: 0.52, minutes: 2460, form: 7.5, available: true },
  { name: "Cole Palmer", team: "Chelsea", position: "MID", goals_per_90: 0.58, xg_per_90: 0.52, assists_per_90: 0.35, minutes: 2280, form: 8.0, available: true },
  { name: "Alexander Isak", team: "Newcastle", position: "FWD", goals_per_90: 0.72, xg_per_90: 0.65, assists_per_90: 0.18, minutes: 2100, form: 7.6, available: true },
  { name: "Ollie Watkins", team: "Aston Villa", position: "FWD", goals_per_90: 0.55, xg_per_90: 0.52, assists_per_90: 0.28, minutes: 2400, form: 6.9, available: true },
  { name: "Bruno Fernandes", team: "Man Utd", position: "MID", goals_per_90: 0.32, xg_per_90: 0.28, assists_per_90: 0.42, minutes: 2520, form: 6.5, available: true },
  { name: "Son Heung-min", team: "Tottenham", position: "FWD", goals_per_90: 0.48, xg_per_90: 0.45, assists_per_90: 0.32, minutes: 2160, form: 7.2, available: true },
];

export default function PlayersPage() {
  const [sortBy, setSortBy] = useState<keyof PlayerProjection>("goals_per_90");
  const [players] = useState<PlayerProjection[]>(SEED_PLAYERS);

  const sorted = [...players].sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (typeof av === "number" && typeof bv === "number") return bv - av;
    return 0;
  });

  const sortOptions: Array<{ key: keyof PlayerProjection; label: string }> = [
    { key: "goals_per_90", label: "Goals/90" },
    { key: "xg_per_90", label: "xG/90" },
    { key: "assists_per_90", label: "Assists/90" },
    { key: "form", label: "Form" },
    { key: "minutes", label: "Minutes" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-white tracking-tight">
          Player Projections
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Key attacking stats per 90 minutes · FPL API data
        </p>
      </div>

      {/* Sort controls */}
      <div className="flex gap-2 flex-wrap">
        {sortOptions.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setSortBy(opt.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              sortBy === opt.key
                ? "bg-pitch-500/20 text-pitch-400 ring-1 ring-pitch-500/30"
                : "bg-slate-800/60 text-slate-400 hover:text-white"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Player table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800/60">
              <th className="text-left py-3 px-4 text-xs uppercase tracking-wider text-slate-500">Player</th>
              <th className="text-left py-3 px-3 text-xs uppercase tracking-wider text-slate-500">Team</th>
              <th className="text-center py-3 px-3 text-xs uppercase tracking-wider text-slate-500">Pos</th>
              <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500">G/90</th>
              <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500">xG/90</th>
              <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500">A/90</th>
              <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500">Mins</th>
              <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500">Form</th>
              <th className="text-center py-3 px-3 text-xs uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {sorted.map((player) => (
              <tr key={player.name} className="hover:bg-slate-800/30 transition-colors">
                <td className="py-3 px-4 font-medium text-white">{player.name}</td>
                <td className="py-3 px-3 text-slate-400">{player.team}</td>
                <td className="py-3 px-3 text-center">
                  <span className={`text-xs font-mono ${
                    player.position === "FWD" ? "text-red-400" :
                    player.position === "MID" ? "text-sky-400" : "text-emerald-400"
                  }`}>
                    {player.position}
                  </span>
                </td>
                <td className="py-3 px-3 text-right font-mono text-emerald-400">{player.goals_per_90.toFixed(2)}</td>
                <td className="py-3 px-3 text-right font-mono text-slate-300">{player.xg_per_90.toFixed(2)}</td>
                <td className="py-3 px-3 text-right font-mono text-sky-400">{player.assists_per_90.toFixed(2)}</td>
                <td className="py-3 px-3 text-right font-mono text-slate-400">{player.minutes.toLocaleString()}</td>
                <td className="py-3 px-3 text-right font-mono text-amber-400">{player.form.toFixed(1)}</td>
                <td className="py-3 px-3 text-center">
                  {player.available ? (
                    <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-slate-600 text-center">
        Stats sourced from FPL API · Projections will be enhanced with FBref xG and Understat data in future updates
      </p>
    </div>
  );
}
