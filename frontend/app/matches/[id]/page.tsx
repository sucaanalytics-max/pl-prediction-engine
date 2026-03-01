"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { usePredictions } from "@/lib/PredictionsContext";
import {
  getMatchById, correctScoreToGrid, getHalfKellyPct,
  effectiveEdge, confidenceTier, marketLabel, marketIcon,
  type MatchPrediction,
} from "@/lib/predictions";
import { pct, xg, odds, shortDate, kickoffTime, featureName, confidenceColor, edgeColor, impliedOdds } from "@/lib/formats";
import { ErrorBoundary, PageSkeleton, ErrorMessage } from "@/components/ErrorBoundary";
import ScorelineHeatmap from "@/components/ScorelineHeatmap";
import DistributionChart from "@/components/DistributionChart";
import SHAPWaterfall from "@/components/SHAPWaterfall";

const CONF_BADGES: Record<string, { label: string; cls: string }> = {
  high: { label: "HIGH", cls: "badge-green" },
  medium: { label: "MED", cls: "badge-amber" },
  low: { label: "LOW", cls: "text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider" },
};

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
        <Link href="/" className="mt-4 inline-block text-sm text-pitch-400 hover:text-pitch-300">
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
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-white transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to fixtures
      </Link>

      {/* Header card */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2 text-xs text-slate-500 uppercase tracking-wider flex-wrap">
            <span>{shortDate(match.fixture.date)} · {kickoffTime(match.fixture.date)} · GW{match.fixture.gameweek}</span>
            {is_derby && <span className="badge-amber">DERBY</span>}
            {referee && (
              <span className="text-slate-400 normal-case tracking-normal">
                Ref: <span className="text-slate-300">{referee}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {match.model_disagreement !== undefined && match.model_disagreement > 0.15 && (
              <span className="badge-amber text-[9px]">MODELS DISAGREE</span>
            )}
            <span className={confidenceColor(maxProb * 100) + " text-xs font-mono"}>
              {pct(maxProb)} confidence
            </span>
          </div>
        </div>

        {/* Teams & xG */}
        <div className="flex items-center justify-center gap-6 my-6">
          <div className="text-right flex-1">
            <h2 className={`font-display text-2xl font-bold ${prediction === "home" ? "text-white" : "text-slate-400"}`}>
              {home_team}
            </h2>
            <p className="text-sm font-mono text-slate-500 mt-1">xG {xg(match.expected_goals.home)}</p>
          </div>
          <div className="flex flex-col items-center px-4">
            <div className="text-3xl font-display font-bold text-pitch-500">
              {match.expected_goals.home.toFixed(1)} — {match.expected_goals.away.toFixed(1)}
            </div>
            <span className="text-[10px] text-slate-600 uppercase tracking-wider mt-1">Expected</span>
          </div>
          <div className="text-left flex-1">
            <h2 className={`font-display text-2xl font-bold ${prediction === "away" ? "text-white" : "text-slate-400"}`}>
              {away_team}
            </h2>
            <p className="text-sm font-mono text-slate-500 mt-1">xG {xg(match.expected_goals.away)}</p>
          </div>
        </div>

        {/* 1X2 bar */}
        <div className="space-y-2">
          <div className="flex h-3 rounded-full overflow-hidden bg-slate-800">
            <div className="prob-bar bg-pitch-500 rounded-l-full" style={{ width: pct(p.home) }} />
            <div className="prob-bar bg-slate-500" style={{ width: pct(p.draw) }} />
            <div className="prob-bar bg-sky-500 rounded-r-full" style={{ width: pct(p.away) }} />
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-pitch-400 font-mono">{pct(p.home)} H ({impliedOdds(p.home)})</span>
            <span className="text-slate-400 font-mono">{pct(p.draw)} D ({impliedOdds(p.draw)})</span>
            <span className="text-sky-400 font-mono">{pct(p.away)} A ({impliedOdds(p.away)})</span>
          </div>
        </div>

        {/* Clean sheet */}
        {match.probabilities.clean_sheet && (
          <div className="mt-4 pt-4 border-t border-slate-800/40 flex justify-between text-xs text-slate-500">
            <span>{home_team} CS: <span className="text-white font-mono">{pct(match.probabilities.clean_sheet.home)}</span></span>
            <span>{away_team} CS: <span className="text-white font-mono">{pct(match.probabilities.clean_sheet.away)}</span></span>
          </div>
        )}
      </div>

      {/* Model vs Odds Comparison */}
      {oddsComp?.h2h && Object.keys(oddsComp.h2h).length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-display font-semibold text-white mb-4">Model vs Odds</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] text-slate-500 uppercase tracking-wider border-b border-slate-800/50">
                  <th className="pb-2 font-medium">Bookmaker</th>
                  <th className="pb-2 font-medium text-center">Home</th>
                  <th className="pb-2 font-medium text-center">Draw</th>
                  <th className="pb-2 font-medium text-center">Away</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-800/30">
                  <td className="py-2 text-pitch-400 font-medium">Model</td>
                  <td className="py-2 text-center text-white font-mono">{pct(p.home)}</td>
                  <td className="py-2 text-center text-white font-mono">{pct(p.draw)}</td>
                  <td className="py-2 text-center text-white font-mono">{pct(p.away)}</td>
                </tr>
                {Object.entries(oddsComp.h2h).slice(0, 5).map(([bk, o]) => {
                  const impH = 1 / o.home;
                  const impD = 1 / o.draw;
                  const impA = 1 / o.away;
                  const total = impH + impD + impA;
                  return (
                    <tr key={bk} className="border-b border-slate-800/20">
                      <td className="py-2 text-slate-400">{bk.replace(/_/g, " ")}</td>
                      <td className="py-2 text-center font-mono">
                        <span className={p.home > impH / total ? "text-emerald-400" : "text-slate-400"}>
                          {pct(impH / total)}
                        </span>
                      </td>
                      <td className="py-2 text-center font-mono">
                        <span className={p.draw > impD / total ? "text-emerald-400" : "text-slate-400"}>
                          {pct(impD / total)}
                        </span>
                      </td>
                      <td className="py-2 text-center font-mono">
                        <span className={p.away > impA / total ? "text-emerald-400" : "text-slate-400"}>
                          {pct(impA / total)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-slate-600 mt-2">Green = model gives higher probability (potential edge).</p>
        </div>
      )}

      {/* Markets grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* O/U 2.5 */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Over/Under 2.5 Goals</h3>
          {match.probabilities.over_under["2.5"] ? (
            <>
              <div className="flex justify-between items-center">
                <div>
                  <span className="text-lg font-display font-bold text-white">
                    {pct(match.probabilities.over_under["2.5"].over)}
                  </span>
                  <span className="text-xs text-slate-500 ml-1">over</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500 mr-1">under</span>
                  <span className="text-lg font-display font-bold text-slate-400">
                    {pct(match.probabilities.over_under["2.5"].under)}
                  </span>
                </div>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden bg-slate-800">
                <div className="prob-bar bg-emerald-500" style={{ width: pct(match.probabilities.over_under["2.5"].over) }} />
              </div>
            </>
          ) : <span className="text-slate-600 text-sm">—</span>}
        </div>

        {/* BTTS */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Both Teams to Score</h3>
          <div className="flex justify-between items-center">
            <div>
              <span className="text-lg font-display font-bold text-white">{pct(match.probabilities.btts)}</span>
              <span className="text-xs text-slate-500 ml-1">yes</span>
            </div>
            <div>
              <span className="text-xs text-slate-500 mr-1">no</span>
              <span className="text-lg font-display font-bold text-slate-400">{pct(1 - match.probabilities.btts)}</span>
            </div>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden bg-slate-800">
            <div className="prob-bar bg-amber-500" style={{ width: pct(match.probabilities.btts) }} />
          </div>
        </div>

        {/* Corners */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Corners</h3>
          <div className="stat-value text-white">
            {match.expected_corners.toFixed(1)}
            <span className="text-xs text-slate-500 font-normal ml-1">expected</span>
          </div>
          <div className="space-y-1">
            {cornerLines.map((line) => {
              const ou = match.probabilities.corners[line];
              if (!ou) return null;
              return (
                <div key={line} className="flex justify-between text-xs font-mono text-slate-500">
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
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Cards</h3>
          <div className="stat-value text-white">
            {match.expected_cards.toFixed(1)}
            <span className="text-xs text-slate-500 font-normal ml-1">expected</span>
          </div>
          <div className="space-y-1">
            {cardLines.map((line) => {
              const ou = match.probabilities.cards[line];
              if (!ou) return null;
              return (
                <div key={line} className="flex justify-between text-xs font-mono text-slate-500">
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
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">HT/FT Combos</h3>
          <div className="grid grid-cols-3 gap-1 text-center text-xs font-mono">
            {Object.entries(match.probabilities.ht_ft)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 6)
              .map(([combo, prob]) => (
                <div key={combo} className="bg-slate-800/60 rounded px-1.5 py-1.5">
                  <span className="text-slate-300">{combo}</span>
                  <span className="text-slate-500 ml-1">{pct(prob, 0)}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Asian Handicap */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Asian Handicap (Home)</h3>
          <div className="space-y-1">
            {ahLines.slice(0, 7).map(([line, prob]) => {
              const lineNum = line.replace("home_", "");
              return (
                <div key={line} className="flex justify-between text-xs font-mono">
                  <span className="text-slate-400">AH {lineNum}</span>
                  <span className="text-pitch-400">{pct(prob as number)}</span>
                  <span className="text-sky-400">{pct(1 - (prob as number))}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Goalscorer Probabilities */}
      {goalscorer && (goalscorer.home_scorers.length > 0 || goalscorer.away_scorers.length > 0) && (
        <div className="card p-6">
          <h3 className="text-sm font-display font-semibold text-white mb-4">Goalscorer Probabilities</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Home scorers */}
            {goalscorer.home_scorers.length > 0 && (
              <div>
                <h4 className="text-xs text-pitch-400 uppercase tracking-wider mb-3">{home_team}</h4>
                <div className="space-y-2">
                  {goalscorer.home_scorers.slice(0, 6).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-white">{s.web_name}</span>
                        <span className="text-[10px] text-slate-500 ml-1.5">{s.position}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono flex-shrink-0">
                        <span className="text-slate-500">xG/90 {s.xg_per_90.toFixed(2)}</span>
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
                <h4 className="text-xs text-sky-400 uppercase tracking-wider mb-3">{away_team}</h4>
                <div className="space-y-2">
                  {goalscorer.away_scorers.slice(0, 6).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-white">{s.web_name}</span>
                        <span className="text-[10px] text-slate-500 ml-1.5">{s.position}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono flex-shrink-0">
                        <span className="text-slate-500">xG/90 {s.xg_per_90.toFixed(2)}</span>
                        <span className="text-emerald-400 font-semibold">{pct(s.anytime_prob)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="text-[10px] text-slate-600 mt-3">
            Anytime scorer probability from Poisson model. Match xG: {home_team} {goalscorer.match_xg?.home.toFixed(2) ?? "—"} / {away_team} {goalscorer.match_xg?.away.toFixed(2) ?? "—"}.
          </p>
        </div>
      )}

      {/* Scoreline Heatmap */}
      <div className="card p-6">
        <h3 className="text-sm font-display font-semibold text-white mb-4">Correct Score Probabilities</h3>
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
          <h3 className="text-sm font-display font-semibold text-white mb-4">Player Booking Probabilities</h3>
          <div className="space-y-2">
            {bookings.map((b, i) => (
              <div key={i} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-3 py-2">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-white">{b.web_name}</span>
                  <span className="text-xs text-slate-500 ml-2">{b.team}</span>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono flex-shrink-0">
                  <div className="w-20 bg-slate-700 rounded-full h-1.5 overflow-hidden">
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
          <p className="text-[10px] text-slate-600 mt-3">
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
        <div className="card p-6">
          <h3 className="text-sm font-display font-semibold text-white mb-4">Value Bets</h3>
          <div className="space-y-3">
            {match.value_bets.map((bet, i) => {
              const tier = bet.confidence_tier ?? confidenceTier(effectiveEdge(bet));
              const badge = CONF_BADGES[tier] ?? CONF_BADGES.low;
              return (
                <div key={i} className="flex items-center justify-between bg-slate-800/40 rounded-lg p-3 gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs opacity-60">{marketIcon(bet.market)}</span>
                    <div>
                      <span className="text-sm font-medium text-white">{bet.selection ?? bet.market}</span>
                      {bet.selection && (
                        <span className="text-[10px] text-slate-500 ml-2">{marketLabel(bet.market)}</span>
                      )}
                    </div>
                    <span className={`${badge.cls} text-[9px] ml-1`}>{badge.label}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono">
                    <span className="text-emerald-400">{pct(bet.model_prob)} model</span>
                    <span className="text-slate-500">{pct(bet.implied_prob)} impl.</span>
                    {bet.devigged_prob && (
                      <span className="text-slate-400">{pct(bet.devigged_prob)} devig</span>
                    )}
                    <span className={`font-semibold ${edgeColor(effectiveEdge(bet))}`}>
                      +{pct(effectiveEdge(bet))} edge
                    </span>
                    {(bet.decimal_odds ?? 0) > 0 && (
                      <span className="text-sky-400">{odds(bet.decimal_odds!)}</span>
                    )}
                    <span className="text-slate-400">½K {pct(getHalfKellyPct(bet))}</span>
                    {bet.bookmaker && (
                      <span className="text-slate-600">{bet.bookmaker.replace(/_/g, " ")}</span>
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
        <h3 className="text-sm font-display font-semibold text-white mb-3">Match Preview</h3>
        <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
          {match.narrative}
        </div>
      </div>

      {/* Confidence / entropy */}
      {match.confidence && (
        <div className="card p-4 flex items-center justify-between text-xs text-slate-500 gap-2 flex-wrap">
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
