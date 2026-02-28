"use client";

import { pct } from "@/lib/formats";

interface ScorelineHeatmapProps {
  grid: number[][];
  homeTeam: string;
  awayTeam: string;
}

function cellColor(prob: number): string {
  if (prob >= 0.12) return "bg-pitch-500/80 text-white";
  if (prob >= 0.08) return "bg-pitch-600/60 text-white";
  if (prob >= 0.05) return "bg-pitch-700/40 text-slate-200";
  if (prob >= 0.02) return "bg-slate-800/80 text-slate-300";
  if (prob > 0) return "bg-slate-800/40 text-slate-500";
  return "bg-slate-900/40 text-slate-700";
}

export default function ScorelineHeatmap({ grid, homeTeam, awayTeam }: ScorelineHeatmapProps) {
  const maxGoals = 5; // Show 0-4 goals (5x5)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-500 uppercase tracking-wider">
        <span>{awayTeam} goals →</span>
      </div>

      <div className="grid gap-1" style={{ gridTemplateColumns: `32px repeat(${maxGoals}, 1fr)` }}>
        {/* Header row */}
        <div />
        {Array.from({ length: maxGoals }, (_, i) => (
          <div key={`h-${i}`} className="text-center text-xs font-mono text-slate-500 py-1">
            {i}
          </div>
        ))}

        {/* Grid rows */}
        {grid.slice(0, maxGoals).map((row, homeGoals) => (
          <>
            <div
              key={`label-${homeGoals}`}
              className="flex items-center justify-center text-xs font-mono text-slate-500"
            >
              {homeGoals}
            </div>
            {row.slice(0, maxGoals).map((prob, awayGoals) => (
              <div
                key={`${homeGoals}-${awayGoals}`}
                className={`heatmap-cell ${cellColor(prob)} rounded-md flex items-center justify-center py-3 text-xs font-mono font-medium`}
                title={`${homeTeam} ${homeGoals} - ${awayGoals} ${awayTeam}: ${pct(prob)}`}
              >
                {prob >= 0.01 ? pct(prob, 0) : ""}
              </div>
            ))}
          </>
        ))}
      </div>

      <div className="flex items-center text-xs text-slate-500 uppercase tracking-wider">
        <span className="-rotate-0">↑ {homeTeam} goals</span>
      </div>

      {/* Top scorelines */}
      <div className="pt-2 border-t border-slate-800/40">
        <p className="text-xs text-slate-500 mb-2">Most likely scorelines</p>
        <div className="flex flex-wrap gap-2">
          {getTopScorelines(grid, homeTeam, awayTeam, 5).map((s, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-800/60 text-xs font-mono"
            >
              <span className="text-white font-semibold">{s.score}</span>
              <span className="text-slate-500">{pct(s.prob)}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function getTopScorelines(
  grid: number[][],
  home: string,
  away: string,
  n: number
): Array<{ score: string; prob: number }> {
  const scores: Array<{ score: string; prob: number }> = [];
  for (let h = 0; h < grid.length; h++) {
    for (let a = 0; a < grid[h].length; a++) {
      if (grid[h][a] > 0) {
        scores.push({ score: `${h}-${a}`, prob: grid[h][a] });
      }
    }
  }
  return scores.sort((a, b) => b.prob - a.prob).slice(0, n);
}
