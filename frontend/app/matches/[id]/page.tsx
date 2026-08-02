"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { usePredictions } from "@/lib/PredictionsContext";
import {
  getMatchById, correctScoreToGrid,
  effectiveEdge, confidenceTier, marketLabel, marketIcon,
} from "@/lib/predictions";
import { pct, xg, odds, shortDate, kickoffTime, confidenceColor, edgeColor } from "@/lib/formats";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";
import ReactMarkdown from "react-markdown";
import ScorelineHeatmap from "@/components/ScorelineHeatmap";
import DistributionChart from "@/components/DistributionChart";
import SHAPWaterfall from "@/components/SHAPWaterfall";
import { CONF_BADGES, MARKET_ICON_LABELS, edgePrefix } from "@/lib/theme";

function MatchDetailContent() {
  const params = useParams();
  const matchId = params.id as string;
  const { predictions: data, loading, error, refresh } = usePredictions();

  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !data) return <PageSkeleton rows={6} />;

  const match = getMatchById(data, decodeURIComponent(matchId));
  if (!match) {
    return (
      <div className="card p-8 text-center">
        <p className="text-red-400 font-medium">Match not found</p>
        <Link href="/" className="mt-4 inline-block text-sm" style={{ color: "var(--accent)" }}>
          Back to fixtures
        </Link>
      </div>
    );
  }

  const p = match.probabilities["1x2"];
  const maxProb = Math.max(p.home, p.draw, p.away);
  const prediction = p.home === maxProb ? "home" : p.away === maxProb ? "away" : "draw";
  const { home_team, away_team, referee, is_derby } = match.fixture;

  const scoreGrid = correctScoreToGrid(match.probabilities.correct_score);
  const ahLines = Object.entries(match.probabilities.asian_handicap)
    .filter(([k]) => k.startsWith("home_"))
    .sort(([a], [b]) => parseFloat(a.replace("home_", "")) - parseFloat(b.replace("home_", "")));
  const cornerLines = ["8.5", "9.5", "10.5", "11.5"];
  const cardLines = ["2.5", "3.5", "4.5"];

  const goalsHome = match.distributions.goals_home ?? [];
  const goalsAway = match.distributions.goals_away ?? [];
  const cornersDist = match.distributions.corners ?? match.distributions.total_corners ?? [];
  const cardsDist = match.distributions.cards ?? match.distributions.total_cards ?? [];
  const bookings = match.player_bookings?.top_bookings ?? [];
  const goalscorer = match.goalscorer;
  const oddsComp = match.odds_comparison;

  return (
    <div className="space-y-8">
      {/* Back */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm transition-colors"
        style={{ color: "var(--text-3)" }}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to fixtures
      </Link>

      {/* Header card */}
      <div className={`card p-8 md:p-10 relative overflow-hidden ${prediction === 'home' ? 'fixture-home' : prediction === 'away' ? 'fixture-away' : 'fixture-draw'}`}>
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4 relative z-10">
          <div className="flex items-center gap-3 text-xs uppercase tracking-[0.15em] font-bold flex-wrap" style={{ color: "var(--text-3)" }}>
            <span className="glass-panel px-3 py-1 rounded-md shadow-sm">{shortDate(match.fixture.date)} <span className="opacity-50 mx-1">•</span> {kickoffTime(match.fixture.date)} <span className="opacity-50 mx-1">•</span> GW{match.fixture.gameweek}</span>
            {is_derby && <span className="badge-amber shadow-[0_0_15px_var(--warning-muted)]">DERBY</span>}
            {referee && (
              <span className="glass-panel px-3 py-1 rounded-md tracking-wider flex items-center gap-1.5" style={{ color: "var(--text-2)" }}>
                <span className="opacity-50">REF:</span> <span style={{ color: "var(--text-1)" }}>{referee}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {match.model_disagreement !== undefined && match.model_disagreement > 0.15 && (
              <span className="badge-red shadow-[0_0_15px_var(--error-muted)] px-3 py-1 text-[10px] animate-pulse">MODELS DISAGREE</span>
            )}
            <span className={`px-3 py-1 rounded-md glass-panel text-xs font-mono font-bold ${confidenceColor(maxProb * 100)}`}>
              {pct(maxProb)} CONF
            </span>
          </div>
        </div>

        {/* Teams & xG */}
        <div className="flex items-center justify-center gap-4 md:gap-10 my-8 relative z-10">
          <div className="text-right flex-1">
            <h2
              className="text-3xl md:text-5xl font-extrabold tracking-tighter drop-shadow-md"
              style={{ color: prediction === "home" ? "var(--text-1)" : "var(--text-2)", textShadow: prediction === "home" ? "0 0 20px rgba(255,255,255,0.15)" : "none" }}
            >
              {home_team}
            </h2>
            <p className="text-sm font-mono mt-3 opacity-90" style={{ color: "var(--text-3)" }}>
              <span className="uppercase tracking-[0.2em] text-[10px] font-bold mr-2">xG</span>
              <span className="glass-panel px-2.5 py-1 rounded-md font-bold text-[15px]" style={{ color: "var(--home)", boxShadow: "var(--glow-home)" }}>{xg(match.expected_goals.home)}</span>
            </p>
          </div>

          <div className="flex flex-col items-center px-6 md:px-10 py-4 glass-panel rounded-2xl border-t border-b border-[var(--border)] shadow-[var(--shadow-lg)] relative">
            <div className="absolute inset-0 bg-gradient-to-b from-white/[0.05] to-transparent rounded-2xl pointer-events-none" />
            <div className="text-4xl md:text-6xl font-black tracking-tighter flex items-center gap-3">
              <span className="bg-clip-text text-transparent" style={{ backgroundImage: "linear-gradient(135deg, var(--home) 0%, #10b981 100%)", filter: "drop-shadow(0 0 10px var(--home-muted))" }}>{match.expected_goals.home.toFixed(1)}</span>
              <span className="text-[var(--border-strong)] mx-1 font-light">—</span>
              <span className="bg-clip-text text-transparent" style={{ backgroundImage: "linear-gradient(135deg, var(--away) 0%, #3b82f6 100%)", filter: "drop-shadow(0 0 10px var(--away-muted))" }}>{match.expected_goals.away.toFixed(1)}</span>
            </div>
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold mt-3 opacity-70" style={{ color: "var(--text-3)" }}>Expected</span>
          </div>

          <div className="text-left flex-1">
            <h2
              className="text-3xl md:text-5xl font-extrabold tracking-tighter drop-shadow-md"
              style={{ color: prediction === "away" ? "var(--text-1)" : "var(--text-2)", textShadow: prediction === "away" ? "0 0 20px rgba(255,255,255,0.15)" : "none" }}
            >
              {away_team}
            </h2>
            <p className="text-sm font-mono mt-3 opacity-90" style={{ color: "var(--text-3)" }}>
              <span className="glass-panel px-2.5 py-1 rounded-md font-bold text-[15px]" style={{ color: "var(--away)", boxShadow: "var(--glow-away)" }}>{xg(match.expected_goals.away)}</span>
              <span className="uppercase tracking-[0.2em] text-[10px] font-bold ml-2">xG</span>
            </p>
          </div>
        </div>

        {/* 1X2 bar */}
        <div className="space-y-3 relative z-10 mt-10 p-5 glass-panel rounded-2xl border border-[var(--border)] bg-black/5 dark:bg-white/5 shadow-inner">
          <div className="flex h-3.5 rounded-full overflow-hidden shadow-inner border border-[var(--border-strong)]" style={{ background: "var(--surface2)" }}>
            <div className="prob-bar rounded-l-full shadow-[0_0_15px_var(--home)] relative" style={{ width: pct(p.home), background: "var(--home)" }}>
              <div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/20" />
            </div>
            <div className="prob-bar relative shadow-[0_0_15px_var(--draw)]" style={{ width: pct(p.draw), background: "var(--draw)" }}>
              <div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/20" />
            </div>
            <div className="prob-bar rounded-r-full shadow-[0_0_15px_var(--away)] relative" style={{ width: pct(p.away), background: "var(--away)" }}>
              <div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/20" />
            </div>
          </div>

          <div className="flex justify-between text-sm md:text-base font-bold font-mono px-1">
            <span style={{ color: "var(--home)", textShadow: "0 0 10px var(--home-muted)" }}>{pct(p.home)} <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)] ml-1">H</span></span>
            <span style={{ color: "var(--draw)", textShadow: "0 0 10px var(--draw-muted)" }}>{pct(p.draw)} <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)] ml-1">D</span></span>
            <span style={{ color: "var(--away)", textShadow: "0 0 10px var(--away-muted)" }}>{pct(p.away)} <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)] ml-1">A</span></span>
          </div>
        </div>

        {/* Clean sheet */}
        {match.probabilities.clean_sheet && (
          <div className="mt-6 pt-5 flex justify-between text-xs font-semibold tracking-wide uppercase relative z-10" style={{ borderTop: "1px dashed var(--border-strong)", color: "var(--text-3)" }}>
            <span className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--home)", boxShadow: "var(--glow-home)" }} />
              {home_team} CS: <span className="font-mono text-sm px-2 py-0.5 rounded glass-panel" style={{ color: "var(--home)" }}>{pct(match.probabilities.clean_sheet.home)}</span>
            </span>
            <span className="flex items-center gap-2">
              Away CS: <span className="font-mono text-sm px-2 py-0.5 rounded glass-panel" style={{ color: "var(--away)" }}>{pct(match.probabilities.clean_sheet.away)}</span>
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--away)", boxShadow: "var(--glow-away)" }} />
            </span>
          </div>
        )}
      </div>

      {/* Model vs Odds Comparison */}
      {oddsComp?.h2h && Object.keys(oddsComp.h2h).length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Model vs Odds</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider" style={{ borderBottom: "1px solid var(--border)", color: "var(--text-3)" }}>
                  <th scope="col" className="pb-2 font-medium">Bookmaker</th>
                  <th scope="col" className="pb-2 font-medium text-center">Home</th>
                  <th scope="col" className="pb-2 font-medium text-center">Draw</th>
                  <th scope="col" className="pb-2 font-medium text-center">Away</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-2 font-medium" style={{ color: "var(--success)" }}>Model</td>
                  <td className="py-2 text-center font-mono" style={{ color: "var(--text-1)" }}>{pct(p.home)}</td>
                  <td className="py-2 text-center font-mono" style={{ color: "var(--text-1)" }}>{pct(p.draw)}</td>
                  <td className="py-2 text-center font-mono" style={{ color: "var(--text-1)" }}>{pct(p.away)}</td>
                </tr>
                {Object.entries(oddsComp.h2h).slice(0, 5).map(([bk, o]) => {
                  const impH = 1 / o.home;
                  const impD = 1 / o.draw;
                  const impA = 1 / o.away;
                  const total = impH + impD + impA;
                  return (
                    <tr key={bk} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td className="py-2" style={{ color: "var(--text-3)" }}>{bk.replace(/_/g, " ")}</td>
                      <td className="py-2 text-center font-mono">
                        <span style={{ color: p.home > impH / total ? "var(--success)" : "var(--text-3)" }}>
                          {pct(impH / total)}
                        </span>
                      </td>
                      <td className="py-2 text-center font-mono">
                        <span style={{ color: p.draw > impD / total ? "var(--success)" : "var(--text-3)" }}>
                          {pct(impD / total)}
                        </span>
                      </td>
                      <td className="py-2 text-center font-mono">
                        <span style={{ color: p.away > impA / total ? "var(--success)" : "var(--text-3)" }}>
                          {pct(impA / total)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] mt-2" style={{ color: "var(--text-4)" }}>Green = model gives higher probability (potential edge).</p>
        </div>
      )}

      {/* Markets grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* O/U 2.5 */}
        <div className="card-hover p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--text-3)" }}>Over/Under 2.5 Goals</h3>
            <div className="w-8 h-8 rounded-full glass-panel flex items-center justify-center text-emerald-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
            </div>
          </div>
          {match.probabilities.over_under["2.5"] ? (
            <>
              <div className="flex justify-between items-end">
                <div>
                  <div className="text-[10px] uppercase font-bold tracking-widest mb-1" style={{ color: "var(--text-4)" }}>Over</div>
                  <span className="text-3xl font-display font-black bg-clip-text text-transparent" style={{ backgroundImage: "linear-gradient(135deg, var(--text-1) 0%, var(--text-3) 100%)" }}>
                    {pct(match.probabilities.over_under["2.5"].over)}
                  </span>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase font-bold tracking-widest mb-1" style={{ color: "var(--text-4)" }}>Under</div>
                  <span className="text-3xl font-display font-black" style={{ color: "var(--text-3)" }}>
                    {pct(match.probabilities.over_under["2.5"].under)}
                  </span>
                </div>
              </div>
              <div className="flex h-2.5 rounded-full overflow-hidden shadow-inner border border-[var(--border)]" style={{ background: "var(--surface2)" }}>
                <div className="prob-bar bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" style={{ width: pct(match.probabilities.over_under["2.5"].over) }} />
              </div>
            </>
          ) : <span className="text-sm" style={{ color: "var(--text-4)" }}>—</span>}
        </div>

        {/* BTTS */}
        <div className="card-hover p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--text-3)" }}>Both Teams to Score</h3>
            <div className="w-8 h-8 rounded-full glass-panel flex items-center justify-center text-amber-500">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
            </div>
          </div>
          <div className="flex justify-between items-end">
            <div>
              <div className="text-[10px] uppercase font-bold tracking-widest mb-1" style={{ color: "var(--text-4)" }}>Yes</div>
              <span className="text-3xl font-display font-black bg-clip-text text-transparent" style={{ backgroundImage: "linear-gradient(135deg, var(--text-1) 0%, var(--text-3) 100%)" }}>{pct(match.probabilities.btts.yes)}</span>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase font-bold tracking-widest mb-1" style={{ color: "var(--text-4)" }}>No</div>
              <span className="text-3xl font-display font-black" style={{ color: "var(--text-3)" }}>{pct(match.probabilities.btts.no)}</span>
            </div>
          </div>
          <div className="flex h-2.5 rounded-full overflow-hidden shadow-inner border border-[var(--border)]" style={{ background: "var(--surface2)" }}>
            <div className="prob-bar bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]" style={{ width: pct(match.probabilities.btts.yes) }} />
          </div>
        </div>

        {/* Corners */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>Corners</h3>
          <div className="stat-value">
            {match.expected_corners.toFixed(1)}
            <span className="text-xs font-normal ml-1" style={{ color: "var(--text-3)" }}>expected</span>
          </div>
          <div className="space-y-1">
            {cornerLines.map((line) => {
              const ou = match.probabilities.corners[line];
              if (!ou) return null;
              return (
                <div key={line} className="flex justify-between text-xs font-mono" style={{ color: "var(--text-3)" }}>
                  <span>O/U {line}</span>
                  <span className="text-emerald-400">{pct(ou.over)}</span>
                  <span>/</span>
                  <span>{pct(ou.under)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Cards */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>Cards</h3>
          <div className="stat-value">
            {match.expected_cards.toFixed(1)}
            <span className="text-xs font-normal ml-1" style={{ color: "var(--text-3)" }}>expected</span>
          </div>
          <div className="space-y-1">
            {cardLines.map((line) => {
              const ou = match.probabilities.cards[line];
              if (!ou) return null;
              return (
                <div key={line} className="flex justify-between text-xs font-mono" style={{ color: "var(--text-3)" }}>
                  <span>O/U {line}</span>
                  <span className="text-amber-400">{pct(ou.over)}</span>
                  <span>/</span>
                  <span>{pct(ou.under)}</span>
                </div>
              );
            })}
          </div>
          {is_derby && (
            <p className="text-[10px] text-amber-500/70 pt-1">Derby boost applied</p>
          )}
        </div>

        {/* HT/FT */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>HT/FT Combos</h3>
          <div className="grid grid-cols-3 gap-1 text-center text-xs font-mono">
            {Object.entries(match.probabilities.ht_ft)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 6)
              .map(([combo, prob]) => (
                <div key={combo} className="glass-inset rounded px-1.5 py-1.5">
                  <span style={{ color: "var(--text-2)" }}>{combo}</span>
                  <span className="ml-1" style={{ color: "var(--text-3)" }}>{pct(prob, 0)}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Asian Handicap */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>Asian Handicap (Home)</h3>
          <div className="space-y-1">
            {ahLines.slice(0, 7).map(([line, prob]) => {
              const lineNum = line.replace("home_", "");
              return (
                <div key={line} className="flex justify-between text-xs font-mono">
                  <span style={{ color: "var(--text-3)" }}>AH {lineNum}</span>
                  <span style={{ color: "var(--home)" }}>{pct(prob as number)}</span>
                  <span style={{ color: "var(--away)" }}>{pct(1 - (prob as number))}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Goalscorer Probabilities */}
      {goalscorer && (goalscorer.home_scorers.length > 0 || goalscorer.away_scorers.length > 0) && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Goalscorer Probabilities</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Home scorers */}
            {goalscorer.home_scorers.length > 0 && (
              <div>
                <h4 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--home)" }}>{home_team}</h4>
                <div className="space-y-2">
                  {goalscorer.home_scorers.slice(0, 6).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 glass-inset rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{s.web_name}</span>
                        <span className="text-[10px] ml-1.5" style={{ color: "var(--text-3)" }}>{s.position}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono flex-shrink-0">
                        <span style={{ color: "var(--text-3)" }}>xG/90 {s.xg_per_90.toFixed(2)}</span>
                        <span className="text-emerald-400 font-semibold">{pct(s.anytime_prob)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Away scorers */}
            {goalscorer.away_scorers.length > 0 && (
              <div>
                <h4 className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--away)" }}>{away_team}</h4>
                <div className="space-y-2">
                  {goalscorer.away_scorers.slice(0, 6).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 glass-inset rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{s.web_name}</span>
                        <span className="text-[10px] ml-1.5" style={{ color: "var(--text-3)" }}>{s.position}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono flex-shrink-0">
                        <span style={{ color: "var(--text-3)" }}>xG/90 {s.xg_per_90.toFixed(2)}</span>
                        <span className="text-emerald-400 font-semibold">{pct(s.anytime_prob)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="text-[10px] mt-3" style={{ color: "var(--text-4)" }}>
            Anytime scorer probability from Poisson model. Match xG: {home_team} {goalscorer.match_xg?.home.toFixed(2) ?? "—"} / {away_team} {goalscorer.match_xg?.away.toFixed(2) ?? "—"}.
          </p>
        </div>
      )}

      {/* Scoreline Heatmap */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Correct Score Probabilities</h3>
        <ScorelineHeatmap grid={scoreGrid} homeTeam={home_team} awayTeam={away_team} />
      </div>

      {/* Distributions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {goalsHome.length > 0 && (
          <div className="card p-4">
            <DistributionChart data={goalsHome} label={`${home_team} Goals`} color="#2aad1f" />
          </div>
        )}
        {goalsAway.length > 0 && (
          <div className="card p-4">
            <DistributionChart data={goalsAway} label={`${away_team} Goals`} color="#38bdf8" />
          </div>
        )}
        {cornersDist.length > 0 && (
          <div className="card p-4">
            <DistributionChart data={cornersDist} label="Total Corners" color="#a78bfa" startLabel={0} />
          </div>
        )}
        {cardsDist.length > 0 && (
          <div className="card p-4">
            <DistributionChart data={cardsDist} label="Total Cards" color="#fbbf24" startLabel={0} />
          </div>
        )}
      </div>

      {/* Player Bookings */}
      {bookings.length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Player Booking Probabilities</h3>
          <div className="space-y-2">
            {bookings.map((b, i) => (
              <div key={i} className="flex items-center gap-3 glass-inset rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{b.web_name}</span>
                  <span className="text-xs ml-2" style={{ color: "var(--text-3)" }}>{b.team}</span>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono flex-shrink-0">
                  <div className="w-20 rounded-full h-1.5 overflow-hidden" style={{ background: "var(--surface2)" }}>
                    <div
                      className="h-full bg-amber-500 rounded-full"
                      style={{ width: `${Math.min(b.adjusted_prob * 400, 100)}%` }}
                    />
                  </div>
                  <span className="text-amber-400 w-10 text-right">{pct(b.adjusted_prob)}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] mt-3" style={{ color: "var(--text-4)" }}>
            Adjusted for referee profile{referee ? ` (${referee})` : ""}, derby context, and foul rates.
          </p>
        </div>
      )}

      {/* SHAP */}
      {match.shap_features.length > 0 && (
        <div className="card p-6">
          <SHAPWaterfall features={match.shap_features} />
        </div>
      )}

      {/* Value Bets */}
      {match.value_bets.length > 0 && (
        <div className="card-hover p-8 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 pointer-events-none" />
          <h3 className="text-lg font-bold mb-6 flex items-center gap-3" style={{ color: "var(--text-1)" }}>
            <span className="w-8 h-8 rounded-lg bg-[var(--accent-muted)] flex items-center justify-center border border-[var(--accent-border)] font-black text-[var(--accent)]">
              {match.value_bets.length}
            </span>
            Value Bets Found
          </h3>
          <div className="space-y-4 relative z-10">
            {match.value_bets.map((bet, i) => {
              const tier = bet.confidence_tier ?? confidenceTier(effectiveEdge(bet));
              const badge = CONF_BADGES[tier] ?? CONF_BADGES.low;
              return (
                <div key={i} className="flex flex-col md:flex-row md:items-center justify-between glass-inset rounded-xl p-4 gap-4 transition-all hover:-translate-y-1 hover:shadow-md hover:border-[var(--accent-border)]">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full glass-panel flex flex-shrink-0 items-center justify-center text-[var(--accent)] shadow-inner">
                      <span className="text-lg opacity-80" role="img" aria-label={MARKET_ICON_LABELS[marketIcon(bet.market)] ?? "Market"}>{marketIcon(bet.market)}</span>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-bold" style={{ color: "var(--text-1)" }}>{bet.selection ?? bet.market}</span>
                        <span className={`${badge.cls} shadow-sm px-2 text-[9px]`}>{badge.label}</span>
                      </div>
                      {bet.selection && (
                        <span className="text-[11px] font-semibold tracking-wider uppercase mt-1 block" style={{ color: "var(--text-4)" }}>{marketLabel(bet.market)}</span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:flex md:items-center gap-3 md:gap-4 text-sm font-mono p-3 md:p-0 rounded-lg bg-[var(--surface)] md:bg-transparent">
                    <div className="flex flex-col md:items-end">
                      <span className="text-[9px] uppercase tracking-wider text-[var(--text-4)] mb-0.5 font-bold">Model Prob</span>
                      <span className="text-emerald-400 font-extrabold">{pct(bet.model_prob)}</span>
                    </div>

                    <div className="flex flex-col md:items-end">
                      <span className="text-[9px] uppercase tracking-wider text-[var(--text-4)] mb-0.5 font-bold">Implied</span>
                      <span style={{ color: "var(--text-2)" }}>{pct(bet.implied_prob)}</span>
                    </div>

                    <div className="flex flex-col md:items-end col-span-2 md:col-span-1 pl-0 md:pl-2 border-t md:border-t-0 md:border-l border-[var(--border)] pt-2 md:pt-0">
                      <span className="text-[9px] uppercase tracking-wider mb-0.5 font-bold" style={{ color: "var(--accent)" }}>Est. Edge</span>
                      <span className={`font-black text-base drop-shadow-sm ${edgeColor(effectiveEdge(bet))}`}>
                        {edgePrefix(effectiveEdge(bet))}{pct(effectiveEdge(bet))}
                      </span>
                    </div>

                    {(bet.decimal_odds ?? 0) > 0 && (
                      <div className="flex flex-col md:items-end md:ml-2">
                        <span className="text-[9px] uppercase tracking-wider text-[var(--text-4)] mb-0.5 font-bold">Top Odds</span>
                        <span className="glass-panel px-2.5 py-1 rounded-md" style={{ color: "var(--info)", background: "var(--info-muted)", border: "1px solid var(--info-border)" }}>
                          {odds(bet.decimal_odds!)}
                        </span>
                        {bet.bookmaker && (
                          <span className="text-[8px] mt-1 text-[var(--text-4)] truncate max-w-[80px] text-right">{bet.bookmaker.replace(/_/g, " ")}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Narrative */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}>
          Match Preview
        </h3>
        <div
          className="text-sm leading-relaxed space-y-2 [&_strong]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:uppercase [&_h3]:tracking-wider [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold"
          style={{ color: "var(--text-2)" }}
        >
          <ReactMarkdown>{match.narrative}</ReactMarkdown>
        </div>
      </div>

      {/* Confidence / entropy */}
      {match.confidence && (
        <div className="card p-4 flex items-center justify-between text-xs gap-2 flex-wrap" style={{ color: "var(--text-3)" }}>
          <span>Entropy: {match.confidence.entropy.toFixed(3)}</span>
          {match.confidence.home_goals_ci && (
            <span>{home_team} goals 95% CI: [{match.confidence.home_goals_ci[0].toFixed(1)}, {match.confidence.home_goals_ci[1].toFixed(1)}]</span>
          )}
          {match.confidence.away_goals_ci && (
            <span>{away_team} goals 95% CI: [{match.confidence.away_goals_ci[0].toFixed(1)}, {match.confidence.away_goals_ci[1].toFixed(1)}]</span>
          )}
          {match.n_simulations && (
            <span>{(match.n_simulations / 1000).toFixed(0)}K simulations</span>
          )}
        </div>
      )}
    </div>
  );
}

export default function MatchDetailPage() {
  return (
    <ErrorBoundary pageName="Match Detail">
      <MatchDetailContent />
    </ErrorBoundary>
  );
}
