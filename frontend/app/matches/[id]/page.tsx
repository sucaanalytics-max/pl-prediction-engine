"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { loadPredictions, getMatchById, type MatchPrediction, type PredictionData } from "@/lib/predictions";
import { pct, xg, odds, shortDate, kickoffTime, featureName, confidenceColor, impliedOdds } from "@/lib/formats";
import ScorelineHeatmap from "@/components/ScorelineHeatmap";
import DistributionChart from "@/components/DistributionChart";
import SHAPWaterfall from "@/components/SHAPWaterfall";

export default function MatchDetailPage() {
  const params = useParams();
  const matchId = params.id as string;
  const [data, setData] = useState<PredictionData | null>(null);
  const [match, setMatch] = useState<MatchPrediction | null>(null);

  useEffect(() => {
    loadPredictions().then((d) => {
      setData(d);
      const m = getMatchById(d, decodeURIComponent(matchId));
      setMatch(m || null);
    });
  }, [matchId]);

  if (!match) {
    return (
      <div className="card p-8 text-center animate-pulse">
        <div className="h-6 bg-slate-800 rounded w-1/2 mx-auto mb-4" />
        <div className="h-4 bg-slate-800 rounded w-1/3 mx-auto" />
      </div>
    );
  }

  const p = match.probabilities["1x2"];
  const maxProb = Math.max(p.home, p.draw, p.away);
  const prediction = p.home === maxProb ? "home" : p.away === maxProb ? "away" : "draw";
  const { home_team, away_team } = match.fixture;

  return (
    <div className="space-y-8">
      {/* Back */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-white transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back to fixtures
      </Link>

      {/* Header */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs text-slate-500 uppercase tracking-wider">
            {shortDate(match.fixture.date)} · {kickoffTime(match.fixture.date)} · GW{match.fixture.gameweek}
          </span>
          <span className={confidenceColor(maxProb * 100) + " text-xs font-mono"}>
            {pct(maxProb)} confidence
          </span>
        </div>

        {/* Teams & score */}
        <div className="flex items-center justify-center gap-6 my-6">
          <div className="text-right flex-1">
            <h2 className={`font-display text-2xl font-bold ${prediction === "home" ? "text-white" : "text-slate-400"}`}>
              {home_team}
            </h2>
            <p className="text-sm font-mono text-slate-500 mt-1">
              xG {xg(match.expected_goals.home)}
            </p>
          </div>

          <div className="flex flex-col items-center px-4">
            <div className="text-3xl font-display font-bold text-pitch-500">
              {match.expected_goals.home.toFixed(1)} - {match.expected_goals.away.toFixed(1)}
            </div>
            <span className="text-[10px] text-slate-600 uppercase tracking-wider mt-1">
              Expected
            </span>
          </div>

          <div className="text-left flex-1">
            <h2 className={`font-display text-2xl font-bold ${prediction === "away" ? "text-white" : "text-slate-400"}`}>
              {away_team}
            </h2>
            <p className="text-sm font-mono text-slate-500 mt-1">
              xG {xg(match.expected_goals.away)}
            </p>
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
      </div>

      {/* Markets grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* O/U 2.5 */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Over/Under 2.5 Goals</h3>
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
            <div
              className="prob-bar bg-emerald-500"
              style={{ width: pct(match.probabilities.over_under["2.5"].over) }}
            />
          </div>
        </div>

        {/* BTTS */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Both Teams to Score</h3>
          <div className="flex justify-between items-center">
            <div>
              <span className="text-lg font-display font-bold text-white">
                {pct(match.probabilities.btts)}
              </span>
              <span className="text-xs text-slate-500 ml-1">yes</span>
            </div>
            <div>
              <span className="text-xs text-slate-500 mr-1">no</span>
              <span className="text-lg font-display font-bold text-slate-400">
                {pct(1 - match.probabilities.btts)}
              </span>
            </div>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden bg-slate-800">
            <div
              className="prob-bar bg-amber-500"
              style={{ width: pct(match.probabilities.btts) }}
            />
          </div>
        </div>

        {/* Corners */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Expected Corners</h3>
          <div className="stat-value text-white">{match.expected_corners.toFixed(1)}</div>
          <div className="text-xs text-slate-500">
            O/U 9.5: {pct(match.probabilities.corners.over_under["9.5"].over)} /
            {" "}{pct(match.probabilities.corners.over_under["9.5"].under)}
          </div>
        </div>

        {/* Cards */}
        <div className="card p-4 space-y-2">
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Expected Cards</h3>
          <div className="stat-value text-white">{match.expected_cards.toFixed(1)}</div>
          <div className="text-xs text-slate-500">
            O/U 3.5: {pct(match.probabilities.cards.over_under["3.5"].over)} /
            {" "}{pct(match.probabilities.cards.over_under["3.5"].under)}
          </div>
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
          <h3 className="text-xs text-slate-500 uppercase tracking-wider">Asian Handicap</h3>
          {Object.entries(match.probabilities.asian_handicap).map(([line, probs]) => (
            <div key={line} className="flex justify-between text-xs font-mono">
              <span className="text-slate-400">AH {line}</span>
              <span className="text-pitch-400">{pct(probs.home)} H</span>
              <span className="text-sky-400">{pct(probs.away)} A</span>
            </div>
          ))}
        </div>
      </div>

      {/* Scoreline Heatmap */}
      <div className="card p-6">
        <h3 className="text-sm font-display font-semibold text-white mb-4">Correct Score Probabilities</h3>
        <ScorelineHeatmap
          grid={match.probabilities.correct_score.grid}
          homeTeam={home_team}
          awayTeam={away_team}
        />
      </div>

      {/* Distributions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4">
          <DistributionChart
            data={match.distributions.goals_home}
            label={`${home_team} Goals`}
            color="#2aad1f"
          />
        </div>
        <div className="card p-4">
          <DistributionChart
            data={match.distributions.goals_away}
            label={`${away_team} Goals`}
            color="#38bdf8"
          />
        </div>
        <div className="card p-4">
          <DistributionChart
            data={match.distributions.total_goals}
            label="Total Goals"
            color="#fbbf24"
          />
        </div>
        <div className="card p-4">
          <DistributionChart
            data={match.distributions.total_corners}
            label="Total Corners"
            color="#a78bfa"
          />
        </div>
      </div>

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
            {match.value_bets.map((bet, i) => (
              <div key={i} className="flex items-center justify-between bg-slate-800/40 rounded-lg p-3">
                <div>
                  <span className="text-sm font-medium text-white">{bet.market}</span>
                  <span className="text-xs text-slate-500 ml-2">{bet.selection}</span>
                </div>
                <div className="flex items-center gap-4 text-xs font-mono">
                  <span className="text-emerald-400">{pct(bet.model_prob)} model</span>
                  <span className="text-slate-500">{pct(bet.implied_prob)} implied</span>
                  <span className="text-amber-400 font-semibold">+{pct(bet.edge)} edge</span>
                  <span className="text-sky-400">{odds(bet.decimal_odds)}</span>
                </div>
              </div>
            ))}
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
    </div>
  );
}
