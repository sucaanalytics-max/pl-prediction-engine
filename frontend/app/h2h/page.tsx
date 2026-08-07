"use client";

import { Fragment, useState, useMemo } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { usePredictions } from "@/lib/PredictionsContext";
import {
  findHistoricalMatchEvents,
  loadH2H,
  loadH2HEvents,
  type H2HRecord,
  type HistoricalMatchEventsFile,
} from "@/lib/predictions";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";
import HistoricalMatchDetails from "@/components/HistoricalMatchDetails";
import { calendarDate } from "@/lib/formats";

function H2HContent() {
  const { predictions: data, loading, error } = usePredictions();

  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");
  const [record, setRecord] = useState<H2HRecord | null | "not-found">(null);
  const [loadingH2H, setLoadingH2H] = useState(false);
  const [h2hError, setH2hError] = useState<string | null>(null);
  const [eventFile, setEventFile] = useState<HistoricalMatchEventsFile | null>(null);
  const [expandedMatch, setExpandedMatch] = useState<string | null>(null);

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const pred of data?.predictions ?? []) {
      set.add(pred.fixture.home_team);
      set.add(pred.fixture.away_team);
    }
    return Array.from(set).sort();
  }, [data?.predictions]);

  async function handleSearch() {
    if (!homeTeam || !awayTeam || homeTeam === awayTeam) return;
    setLoadingH2H(true);
    setH2hError(null);
    try {
      const [result, events] = await Promise.all([
        loadH2H(homeTeam, awayTeam),
        loadH2HEvents(homeTeam, awayTeam),
      ]);
      setRecord(result ?? "not-found");
      setEventFile(events);
      setExpandedMatch(null);
    } catch (e) {
      setH2hError("Head-to-head data is not available yet.");
      setRecord(null);
    } finally {
      setLoadingH2H(false);
    }
  }

  // Find upcoming fixture between selected teams
  const upcomingFixture = useMemo(() => {
    if (!data || !homeTeam || !awayTeam) return null;
    return (
      data.predictions.find(
        (p) =>
          (p.fixture.home_team === homeTeam && p.fixture.away_team === awayTeam) ||
          (p.fixture.home_team === awayTeam && p.fixture.away_team === homeTeam)
      ) ?? null
    );
  }, [data, homeTeam, awayTeam]);

  if (error) return <ErrorMessage message={error} />;
  if (loading || !data) return <PageSkeleton rows={3} />;

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Header */}
      <div className="relative z-10 mb-6">
        <h1
          className="text-4xl md:text-5xl font-extrabold tracking-tighter bg-clip-text text-transparent drop-shadow-sm mb-2"
          style={{ backgroundImage: "linear-gradient(135deg, var(--text-1) 0%, var(--accent) 100%)", fontFamily: "var(--font-jakarta)" }}
        >
          Head-to-Head
        </h1>
        <p className="text-sm font-medium tracking-wide" style={{ color: "var(--text-3)" }}>Compare two clubs across recent meetings</p>
      </div>

      {/* Team selectors */}
      <div className="glass-panel rounded-2xl shadow-[var(--shadow-custom)] p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="home-team" className="form-label">Home Team</label>
            <select
              id="home-team"
              value={homeTeam}
              onChange={(e) => { setHomeTeam(e.target.value); setRecord(null); setEventFile(null); }}
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
              onChange={(e) => { setAwayTeam(e.target.value); setRecord(null); setEventFile(null); }}
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
          style={{ background: "var(--accent)" }}
        >
          {loadingH2H ? "Loading…" : "Compare"}
        </button>
      </div>

      {/* Upcoming fixture preview */}
      {upcomingFixture && (
        <div className="glass-panel p-5 rounded-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1.5 h-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]" />
          <p className="text-[10px] uppercase tracking-wider font-semibold mb-2" style={{ color: "var(--text-3)" }}>
            Upcoming — GW{upcomingFixture.fixture.gameweek}
          </p>
          <div className="flex items-center justify-between">
            <span className="font-bold" style={{ color: "var(--text-1)" }}>{upcomingFixture.fixture.home_team}</span>
            <div className="text-center px-4">
              <div className="text-xs font-mono font-bold" style={{ color: "var(--home)" }}>
                xG {upcomingFixture.expected_goals.home.toFixed(1)} — {upcomingFixture.expected_goals.away.toFixed(1)}
              </div>
              <div className="text-[10px] mt-0.5" style={{ color: "var(--text-3)" }}>expected goals</div>
            </div>
            <span className="font-bold" style={{ color: "var(--text-1)" }}>{upcomingFixture.fixture.away_team}</span>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden mt-3" style={{ background: "var(--surface2)" }}>
            <div className="h-full transition-all" style={{ width: `${Math.round(upcomingFixture.probabilities["1x2"].home * 100)}%`, background: "var(--home)" }} />
            <div className="h-full" style={{ width: `${Math.round(upcomingFixture.probabilities["1x2"].draw * 100)}%`, background: "var(--draw)" }} />
            <div className="h-full" style={{ width: `${Math.round(upcomingFixture.probabilities["1x2"].away * 100)}%`, background: "var(--away)" }} />
          </div>
          <div className="flex justify-between text-[10px] font-mono mt-1" style={{ color: "var(--text-3)" }}>
            <span style={{ color: "var(--home)" }}>{Math.round(upcomingFixture.probabilities["1x2"].home * 100)}%</span>
            <span>{Math.round(upcomingFixture.probabilities["1x2"].draw * 100)}%</span>
            <span style={{ color: "var(--away)" }}>{Math.round(upcomingFixture.probabilities["1x2"].away * 100)}%</span>
          </div>
        </div>
      )}

      {/* Error */}
      {h2hError && (
        <div className="card p-5 text-center">
          <p className="text-sm" style={{ color: "var(--text-2)" }}>{h2hError}</p>
        </div>
      )}

      {/* Not found */}
      {record === "not-found" && (
        <div className="card p-8 text-center">
          <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>No historical data found</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-4)" }}>
            Head-to-head records between {homeTeam} and {awayTeam} are not in the dataset.
          </p>
        </div>
      )}

      {/* H2H Results */}
      {record && record !== "not-found" && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="glass-panel rounded-2xl shadow-[var(--shadow-custom)] p-6">
            <h2 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}>
              {record.home_team} vs {record.away_team} — All Time
            </h2>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold" style={{ color: "var(--home)" }}>{record.home_wins}</p>
                <p className="text-[10px] uppercase tracking-wider mt-1" style={{ color: "var(--text-3)" }}>{record.home_team} Wins</p>
              </div>
              <div>
                <p className="text-2xl font-bold" style={{ color: "var(--text-3)" }}>{record.draws}</p>
                <p className="text-[10px] uppercase tracking-wider mt-1" style={{ color: "var(--text-3)" }}>Draws</p>
              </div>
              <div>
                <p className="text-2xl font-bold" style={{ color: "var(--away)" }}>{record.away_wins}</p>
                <p className="text-[10px] uppercase tracking-wider mt-1" style={{ color: "var(--text-3)" }}>{record.away_team} Wins</p>
              </div>
            </div>

            {/* Win bar */}
            <div className="mt-4">
              {(() => {
                const total = record.home_wins + record.draws + record.away_wins;
                if (total === 0) return null;
                return (
                  <div className="flex h-2 rounded-full overflow-hidden">
                    <div style={{ width: `${(record.home_wins / total) * 100}%`, background: "var(--home)" }} />
                    <div style={{ width: `${(record.draws / total) * 100}%`, background: "var(--draw)" }} />
                    <div style={{ width: `${(record.away_wins / total) * 100}%`, background: "var(--away)" }} />
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Recent meetings */}
          {record.matches.length > 0 && (
            <div className="glass-panel rounded-2xl shadow-[var(--shadow-custom)] overflow-hidden">
              <div className="px-5 py-4 bg-[var(--surface2)]" style={{ borderBottom: "1px solid var(--border)" }}>
                <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-3)" }}>
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
                    <th scope="col" className="text-right">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {record.matches.slice(0, 10).map((m) => {
                    const homeWin = m.home_goals > m.away_goals;
                    const awayWin = m.away_goals > m.home_goals;
                    const matchHome = m.home_team ?? record.home_team;
                    const matchAway = m.away_team ?? record.away_team;
                    const matchKey = `${m.season}-${m.date}-${matchHome}-${matchAway}`;
                    const expanded = expandedMatch === matchKey;
                    const events = findHistoricalMatchEvents(
                      eventFile,
                      m,
                      record.home_team,
                      record.away_team
                    );
                    return (
                      <Fragment key={matchKey}>
                        <tr>
                          <td style={{ color: "var(--text-3)" }}>
                            {calendarDate(m.date)}
                          </td>
                          <td style={{ color: "var(--text-4)" }}>{m.season}</td>
                          <td className="text-center font-medium" style={{ color: homeWin ? "var(--text-1)" : "var(--text-3)" }}>
                            {matchHome}
                          </td>
                          <td className="text-center font-mono font-bold" style={{ color: "var(--text-1)" }}>
                            {m.home_goals} — {m.away_goals}
                          </td>
                          <td className="text-center font-medium" style={{ color: awayWin ? "var(--text-1)" : "var(--text-3)" }}>
                            {matchAway}
                          </td>
                          <td className="text-right">
                            <button
                              className={expanded ? "historical-toggle active" : "historical-toggle"}
                              onClick={() => setExpandedMatch(expanded ? null : matchKey)}
                              aria-expanded={expanded}
                            >
                              {expanded ? "Hide" : "Match stats"}
                              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                            </button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="historical-detail-row">
                            <td colSpan={6}>
                              <HistoricalMatchDetails
                                events={events}
                                homeTeam={matchHome}
                                awayTeam={matchAway}
                                date={m.date.slice(0, 10)}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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
