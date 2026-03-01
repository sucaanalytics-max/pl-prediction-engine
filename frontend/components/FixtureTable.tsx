"use client";

import Link from "next/link";
import { pct, shortDate, kickoffTime, confidenceColor, predictionLabel } from "@/lib/formats";
import { confidenceTier, type MatchPrediction } from "@/lib/predictions";

interface FixtureTableProps {
  predictions: MatchPrediction[];
}

export default function FixtureTable({ predictions }: FixtureTableProps) {
  return (
    <div className="space-y-2" role="list" aria-label="Match fixtures">
      {predictions.map((pred, i) => {
        const p = pred.probabilities["1x2"];
        const maxProb = Math.max(p.home, p.draw, p.away);
        const prediction = p.home === maxProb ? "home" : p.away === maxProb ? "away" : "draw";
        const valueBetCount = pred.value_bets.length;
        const tier = confidenceTier(maxProb);
        const hasGoalscorer = (pred.goalscorer?.top_scorers?.length ?? 0) > 0;

        return (
          <Link
            key={pred.match_id}
            href={`/matches/${pred.match_id}`}
            className="card-hover block p-4 animate-slide-up focus-visible:ring-2 focus-visible:ring-pitch-500 focus-visible:outline-none"
            style={{ animationDelay: `${i * 40}ms`, animationFillMode: "both" }}
            role="listitem"
            aria-label={`${pred.fixture.home_team} vs ${pred.fixture.away_team}, ${predictionLabel(prediction)} predicted at ${pct(maxProb, 0)}`}
          >
            <div className="flex items-center justify-between">
              {/* Date & time */}
              <div className="w-20 flex-shrink-0 text-center">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">
                  {shortDate(pred.fixture.date)}
                </div>
                <div className="text-xs font-mono text-slate-400">
                  {kickoffTime(pred.fixture.date)}
                </div>
              </div>

              {/* Teams */}
              <div className="flex-1 px-4">
                <div className="flex items-center justify-between">
                  <span
                    className={`font-display font-semibold text-[15px] ${
                      prediction === "home" ? "text-white" : "text-slate-400"
                    }`}
                  >
                    {pred.fixture.home_team}
                  </span>
                  <div className="flex flex-col items-center mx-3 gap-0.5 flex-shrink-0">
                    <span className="text-[10px] font-mono text-slate-600" aria-hidden="true">vs</span>
                    {pred.fixture.is_derby && (
                      <span className="badge-amber text-[9px] px-1.5 leading-tight">DERBY</span>
                    )}
                  </div>
                  <span
                    className={`font-display font-semibold text-[15px] ${
                      prediction === "away" ? "text-white" : "text-slate-400"
                    }`}
                  >
                    {pred.fixture.away_team}
                  </span>
                </div>

                {/* Probability bar */}
                <div className="flex h-1.5 rounded-full overflow-hidden mt-2 bg-slate-800" role="img" aria-label={`Home ${pct(p.home, 0)}, Draw ${pct(p.draw, 0)}, Away ${pct(p.away, 0)}`}>
                  <div className="prob-bar bg-pitch-500" style={{ width: pct(p.home) }} />
                  <div className="prob-bar bg-slate-500" style={{ width: pct(p.draw) }} />
                  <div className="prob-bar bg-sky-500" style={{ width: pct(p.away) }} />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1">
                  <span>{pct(p.home, 0)}</span>
                  <span>{pct(p.draw, 0)}</span>
                  <span>{pct(p.away, 0)}</span>
                </div>
                {/* Metadata row */}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {pred.fixture.referee && (
                    <span className="text-[10px] text-slate-500 truncate">
                      Ref: {pred.fixture.referee}
                    </span>
                  )}
                  {pred.model_disagreement !== undefined && pred.model_disagreement > 0.15 && (
                    <span className="text-[9px] text-amber-500/80 font-medium">⚠ MODELS DISAGREE</span>
                  )}
                </div>
              </div>

              {/* Prediction & xG */}
              <div className="w-28 flex-shrink-0 text-right space-y-1">
                <div className="flex items-center justify-end gap-2">
                  <span className={`text-lg font-display font-bold ${confidenceColor(maxProb * 100)}`}>
                    {predictionLabel(prediction)}
                  </span>
                  <span className="text-xs font-mono text-slate-500">
                    {pct(maxProb, 0)}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-slate-600">
                  xG {pred.expected_goals.home.toFixed(1)} - {pred.expected_goals.away.toFixed(1)}
                </div>
                <div className="flex items-center justify-end gap-1">
                  {valueBetCount > 0 && (
                    <span className="badge-green text-[9px]">
                      {valueBetCount} VALUE
                    </span>
                  )}
                  {hasGoalscorer && (
                    <span className="text-[8px] text-slate-600">⚽</span>
                  )}
                </div>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
