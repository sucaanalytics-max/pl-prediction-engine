"use client";

import { useState, useMemo } from "react";
import { usePredictions } from "@/lib/PredictionsContext";
import { loadH2H, type H2HRecord } from "@/lib/predictions";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";

function H2HContent() {
  const { predictions: data, loading, error } = usePredictions();

  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");
  const [record, setRecord] = useState<H2HRecord | null | "not-found">(null);
  const [loadingH2H, setLoadingH2H] = useState(false);
  const [h2hError, setH2hError] = useState<string | null>(null);

  if (error) return <ErrorMessage message={error} />;
  if (loading || !data) return <PageSkeleton rows={3} />;

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const pred of data.predictions) {
      set.add(pred.fixture.home_team);
      set.add(pred.fixture.away_team);
    }
    return Array.from(set).sort();
  }, [data.predictions]);

  async function handleSearch() {
    if (!homeTeam || !awayTeam || homeTeam === awayTeam) return;
    setLoadingH2H(true);
    setH2hError(null);
    try {
      const result = await loadH2H(homeTeam, awayTeam);
      setRecord(result ?? "not-found");
    } catch (e) {
      setH2hError("Head-to-head data is not available yet.");
      setRecord(null);
    } finally {
      setLoadingH2H(false);
    }
  }

  // Find upcoming fixture between selected teams
  const upcomingFixture = useMemo(() => {
    if (!homeTeam || !awayTeam) return null;
    return (
      data.predictions.find(
        (p) =>
          (p.fixture.home_team === homeTeam && p.fixture.away_team === awayTeam) ||
          (p.fixture.home_team === awayTeam && p.fixture.away_team === homeTeam)
      ) ?? null
    );
  }, [data.predictions, homeTeam, awayTeam]);

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight" style={{ fontFamily: "var(--font-jakarta)" }}>
          Head-to-Head
        </h1>
        <p className="text-sm text-slate-500 mt-1">Compare two clubs across recent meetings</p>
      </div>

      {/* Team selectors */}
      <div className="card p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="home-team" className="form-label">Home Team</label>
            <select
              id="home-team"
              value={homeTeam}
              onChange={(e) => { setHomeTeam(e.target.value); setRecord(null); }}
              className="form-select"
            >
              <option value="">Select team…</option>
              {teams.filter((t) => t !== awayTeam).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="away-team" className="form-label">Away Team</label>
            <select
              id="away-team"
              value={awayTeam}
              onChange={(e) => { setAwayTeam(e.target.value); setRecord(null); }}
              className="form-select"
            >
              <option value="">Select team…</option>
              {teams.filter((t) => t !== homeTeam).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={handleSearch}
          disabled={!homeTeam || !awayTeam || homeTeam === awayTeam || loadingH2H}
          className="w-full py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-40"
          style={{ background: "#15803d" }}
        >
          {loadingH2H ? "Loading…" : "Compare"}
        </button>
      </div>

      {/* Upcoming fixture preview */}
      {upcomingFixture && (
        <div className="card p-4" style={{ borderLeft: "3px solid #22c55e" }}>
          <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
            Upcoming — GW{upcomingFixture.fixture.gameweek}
          </p>
          <div className="flex items-center justify-between">
            <span className="font-bold text-white">{upcomingFixture.fixture.home_team}</span>
            <div className="text-center px-4">
              <div className="text-xs font-mono text-green-400 font-bold">
                xG {upcomingFixture.expected_goals.home.toFixed(1)} — {upcomingFixture.expected_goals.away.toFixed(1)}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">expected goals</div>
            </div>
            <span className="font-bold text-white">{upcomingFixture.fixture.away_team}</span>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden mt-3 bg-white/[0.04]">
            <div className="h-full bg-green-500 transition-all" style={{ width: `${Math.round(upcomingFixture.probabilities["1x2"].home * 100)}%` }} />
            <div className="h-full bg-slate-500" style={{ width: `${Math.round(upcomingFixture.probabilities["1x2"].draw * 100)}%` }} />
            <div className="h-full bg-sky-500" style={{ width: `${Math.round(upcomingFixture.probabilities["1x2"].away * 100)}%` }} />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1">
            <span className="text-green-400">{Math.round(upcomingFixture.probabilities["1x2"].home * 100)}%</span>
            <span>{Math.round(upcomingFixture.probabilities["1x2"].draw * 100)}%</span>
            <span className="text-sky-400">{Math.round(upcomingFixture.probabilities["1x2"].away * 100)}%</span>
          </div>
        </div>
      )}

      {/* Error */}
      {h2hError && (
        <div className="card p-5 text-center">
          <p className="text-slate-400 text-sm">{h2hError}</p>
        </div>
      )}

      {/* Not found */}
      {record === "not-found" && (
        <div className="card p-8 text-center">
          <p className="text-slate-400 text-sm font-medium">No historical data found</p>
          <p className="text-slate-600 text-xs mt-1">
            Head-to-head records between {homeTeam} and {awayTeam} are not in the dataset.
          </p>
        </div>
      )}

      {/* H2H Results */}
      {record && record !== "not-found" && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-white mb-4" style={{ fontFamily: "var(--font-jakarta)" }}>
              {record.home_team} vs {record.away_team} — All Time
            </h2>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-green-400">{record.home_wins}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">{record.home_team} Wins</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-400">{record.draws}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">Draws</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-sky-400">{record.away_wins}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">{record.away_team} Wins</p>
              </div>
            </div>

            {/* Win bar */}
            <div className="mt-4">
              {(() => {
                const total = record.home_wins + record.draws + record.away_wins;
                if (total === 0) return null;
                return (
                  <div className="flex h-2 rounded-full overflow-hidden">
                    <div className="bg-green-500" style={{ width: `${(record.home_wins / total) * 100}%` }} />
                    <div className="bg-slate-500" style={{ width: `${(record.draws / total) * 100}%` }} />
                    <div className="bg-sky-500" style={{ width: `${(record.away_wins / total) * 100}%` }} />
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Recent meetings */}
          {record.matches.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--color-border)" }}>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Recent Meetings
                </h3>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Season</th>
                    <th scope="col" className="text-center">Home</th>
                    <th scope="col" className="text-center font-mono">Score</th>
                    <th scope="col" className="text-center">Away</th>
                  </tr>
                </thead>
                <tbody>
                  {record.matches.slice(0, 10).map((m, i) => {
                    const homeWin = m.home_goals > m.away_goals;
                    const awayWin = m.away_goals > m.home_goals;
                    return (
                      <tr key={i}>
                        <td className="text-slate-400">{m.date}</td>
                        <td className="text-slate-500">{m.season}</td>
                        <td className={`text-center font-medium ${homeWin ? "text-white" : "text-slate-500"}`}>
                          {record.home_team}
                        </td>
                        <td className="text-center font-mono font-bold text-white">
                          {m.home_goals} — {m.away_goals}
                        </td>
                        <td className={`text-center font-medium ${awayWin ? "text-white" : "text-slate-500"}`}>
                          {record.away_team}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function H2HPage() {
  return (
    <ErrorBoundary pageName="Head-to-Head">
      <H2HContent />
    </ErrorBoundary>
  );
}
