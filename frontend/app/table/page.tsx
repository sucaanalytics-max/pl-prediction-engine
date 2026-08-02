"use client";

import { useEffect, useState } from "react";
import { loadTable, type TeamStanding } from "@/lib/predictions";
import { usePredictions } from "@/lib/PredictionsContext";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";

const ZONE_STYLES: Record<string, { bg: string; label: string; color: string }> = {
  champions: { bg: "rgba(34,197,94,0.06)", label: "Champions League", color: "#22c55e" },
  europa: { bg: "rgba(56,189,248,0.06)", label: "Europa League", color: "#38bdf8" },
  conference: { bg: "rgba(139,92,246,0.06)", label: "Conference League", color: "#a78bfa" },
  relegation: { bg: "rgba(248,113,113,0.06)", label: "Relegation", color: "#f87171" },
};

function getZone(pos: number): keyof typeof ZONE_STYLES | null {
  if (pos <= 4) return "champions";
  if (pos === 5) return "europa";
  if (pos === 6) return "conference";
  if (pos >= 18) return "relegation";
  return null;
}

function FormDot({ result }: { result: string }) {
  const colors: Record<string, string> = {
    W: "#22c55e",
    D: "#94a3b8",
    L: "#f87171",
  };
  return (
    <span
      className="inline-block w-4 h-4 rounded-full text-[8px] font-bold flex items-center justify-center text-white flex-shrink-0"
      style={{ background: colors[result] ?? "#334155" }}
      title={result === "W" ? "Win" : result === "D" ? "Draw" : "Loss"}
    >
      {result}
    </span>
  );
}

function TableContent() {
  const { predictions } = usePredictions();
  const [standings, setStandings] = useState<TeamStanding[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTable()
      .then(setStandings)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    const isNotFound = error.includes("404") || error.toLowerCase().includes("failed");
    if (isNotFound) {
      return (
        <div className="space-y-4">
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
          >
            League Table
          </h1>
          <div className="card p-10 text-center">
            <p className="text-sm font-medium mb-1" style={{ color: "var(--text-2)" }}>
              League table not yet available
            </p>
            <p className="text-xs" style={{ color: "var(--text-4)" }}>
              The standings table is generated separately. Check back after the next pipeline run.
            </p>
          </div>
        </div>
      );
    }
    return <ErrorMessage message={error} onRetry={() => window.location.reload()} />;
  }

  if (!standings) return <PageSkeleton rows={5} />;

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div className="relative z-10 mb-6">
        <h1
          className="text-4xl md:text-5xl font-extrabold tracking-tighter bg-clip-text text-transparent drop-shadow-sm mb-2"
          style={{ backgroundImage: "linear-gradient(135deg, var(--text-1) 0%, var(--accent) 100%)", fontFamily: "var(--font-jakarta)" }}
        >
          Premier League Table
        </h1>
        <p className="text-sm font-medium tracking-wide" style={{ color: "var(--text-3)" }}>
          {standings.length} clubs <span className="mx-1.5 opacity-50">•</span>{" "}
          {predictions?.metadata.season ?? "Current season"}
        </p>
      </div>

      {/* Zone legend */}
      <div className="flex flex-wrap gap-3">
        {Object.entries(ZONE_STYLES).map(([key, z]) => (
          <div key={key} className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-3)" }}>
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: z.color, opacity: 0.7 }} />
            <span>{z.label}</span>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="glass-panel overflow-x-auto rounded-2xl shadow-[var(--shadow-custom)]">
        <table className="data-table" aria-label="Premier League standings">
          <thead>
            <tr>
              <th scope="col" className="w-8 text-center">#</th>
              <th scope="col">Club</th>
              <th scope="col" className="text-center">P</th>
              <th scope="col" className="text-center">W</th>
              <th scope="col" className="text-center">D</th>
              <th scope="col" className="text-center">L</th>
              <th scope="col" className="text-center hidden sm:table-cell">GF</th>
              <th scope="col" className="text-center hidden sm:table-cell">GA</th>
              <th scope="col" className="text-center">GD</th>
              <th scope="col" className="text-center font-bold" style={{ color: "var(--text-1)" }}>Pts</th>
              <th scope="col" className="hidden md:table-cell">Form</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((club) => {
              const zone = getZone(club.position);
              const zoneStyle = zone ? ZONE_STYLES[zone] : null;
              return (
                <tr
                  key={club.team}
                  style={zoneStyle ? { background: zoneStyle.bg, borderLeft: `3px solid ${zoneStyle.color}` } : undefined}
                >
                  <td className="text-center">
                    <span
                      className="text-xs font-mono font-bold"
                      style={{ color: zoneStyle?.color ?? "var(--text-3)" }}
                    >
                      {club.position}
                    </span>
                  </td>
                  <td>
                    <span className="font-medium text-sm" style={{ color: "var(--text-1)" }}>{club.team}</span>
                  </td>
                  <td className="text-center font-mono" style={{ color: "var(--text-3)" }}>{club.played}</td>
                  <td className="text-center font-mono" style={{ color: "var(--success)" }}>{club.won}</td>
                  <td className="text-center font-mono" style={{ color: "var(--text-3)" }}>{club.drawn}</td>
                  <td className="text-center font-mono" style={{ color: "var(--error)" }}>{club.lost}</td>
                  <td className="text-center font-mono hidden sm:table-cell" style={{ color: "var(--text-3)" }}>{club.gf}</td>
                  <td className="text-center font-mono hidden sm:table-cell" style={{ color: "var(--text-3)" }}>{club.ga}</td>
                  <td className="text-center font-mono">
                    <span style={{ color: club.gd >= 0 ? "var(--success)" : "var(--error)" }}>
                      {club.gd >= 0 ? "+" : ""}{club.gd}
                    </span>
                  </td>
                  <td className="text-center">
                    <span className="font-bold text-sm font-mono" style={{ color: "var(--text-1)" }}>{club.points}</span>
                  </td>
                  <td className="hidden md:table-cell">
                    <div className="flex items-center gap-1">
                      {(club.form ?? []).slice(-5).map((r, i) => (
                        <FormDot key={i} result={r} />
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-center" style={{ color: "var(--text-4)" }}>
        Data from FBref / FPL API · Updated each matchday
      </p>
    </div>
  );
}

export default function TablePage() {
  return (
    <ErrorBoundary pageName="League Table">
      <TableContent />
    </ErrorBoundary>
  );
}
