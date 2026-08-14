"use client";

import { pct } from "@/lib/formats";

interface ScorelineHeatmapProps {
  grid: number[][];
  homeTeam: string;
  awayTeam: string;
}

function cellColor(prob: number): string {
  if (prob >= 0.12) return "bg-pitch-500/80 text-[var(--bg)]";
  if (prob >= 0.08) return "bg-pitch-600/60 text-[var(--bg)]";
  if (prob >= 0.05) return "bg-pitch-700/40 dark:text-[var(--text-2)] text-slate-800";
  if (prob >= 0.02) return "dark:bg-[var(--surface)] bg-[var(--surface)] dark:text-[var(--text-2)] text-slate-600";
  if (prob > 0) return "dark:bg-[var(--surface)] bg-[var(--surface)] dark:text-[var(--text-3)] text-[var(--text-3)]";
  return "dark:bg-[var(--surface)] bg-transparent dark:text-slate-700 text-[var(--text-2)]";
}

export default function ScorelineHeatmap({ grid, homeTeam, awayTeam }: ScorelineHeatmapProps) {
  const maxGoals = 5;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>
        <span>{awayTeam} goals →</span>
      </div>

      <div className="grid gap-1" style={{ gridTemplateColumns: `32px repeat(${maxGoals}, 1fr)` }}>
        {/* Header row */}
        <div />
        {Array.from({ length: maxGoals }, (_, i) => (
          <div key={`h-${i}`} className="text-center text-xs font-mono py-1" style={{ color: "var(--text-3)" }}>
            {i}
          </div>
        ))}

        {/* Grid rows */}
        {grid.slice(0, maxGoals).map((row, homeGoals) => (
          <>
            <div
              key={`label-${homeGoals}`}
              className="flex items-center justify-center text-xs font-mono"
              style={{ color: "var(--text-3)" }}
            >
              {homeGoals}
            </div>
            {row.slice(0, maxGoals).map((prob, awayGoals) => (
              <div
                key={`${homeGoals}-${awayGoals}`}
                className={`heatmap-cell ${cellColor(prob)} rounded-none flex items-center justify-center py-3 text-xs font-mono font-medium`}
                title={`${homeTeam} ${homeGoals} - ${awayGoals} ${awayTeam}: ${pct(prob)}`}
              >
                {prob >= 0.01 ? pct(prob, 0) : ""}
              </div>
            ))}
          </>
        ))}
      </div>

      <div className="flex items-center text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>
        <span>↑ {homeTeam} goals</span>
      </div>

      {/* Top scorelines */}
      <div className="pt-2" style={{ borderTop: "1px solid var(--border)" }}>
        <p className="text-xs mb-2" style={{ color: "var(--text-3)" }}>Most likely scorelines</p>
        <div className="flex flex-wrap gap-2">
          {getTopScorelines(grid, homeTeam, awayTeam, 5).map((s, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-none text-xs font-mono"
              style={{ background: "var(--surface2)", border: "1px solid var(--border)" }}
            >
              <span className="font-semibold" style={{ color: "var(--text-1)" }}>{s.score}</span>
              <span style={{ color: "var(--text-3)" }}>{pct(s.prob)}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function getTopScorelines(
  grid: number[][],
  _home: string,
  _away: string,
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
