"use client";

import Link from "next/link";
import { pct, shortDate, kickoffTime, confidenceColor, predictionLabel } from "@/lib/formats";
import type { MatchPrediction } from "@/lib/predictions";

interface FixtureTableProps {
  predictions: MatchPrediction[];
}

export default function FixtureTable({ predictions }: FixtureTableProps) {
  return (
    <div className="space-y-2">
      {predictions.map((pred, i) => {
        const p = pred.probabilities["1x2"];
        const maxProb = Math.max(p.home, p.draw, p.away);
        const prediction = p.home === maxProb ? "home" : p.away === maxProb ? "away" : "draw";
        const hasValue = pred.value_bets.length > 0;

        return (
          <Link
            key={pred.match_id}
            href={`/matches/${pred.match_id}`}
            className="card-hover block p-4 animate-slide-up"
            style={{ animationDelay: `${i * 80}ms`, animationFillMode: "both" }}
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
                    className={`font-display font-semibold text-sm ${
                      prediction === "home" ? "text-white" : "text-slate-400"
                    }`}
                  >
                    {pred.fixture.home_team}
                  </span>
                  <span className="text-xs font-mono text-slate-600 mx-2">vs</span>
                  <span
                    className={`font-display font-semibold text-sm ${
                      prediction === "away" ? "text-white" : "text-slate-400"
                    }`}
                  >
                    {pred.fixture.away_team}
                  </span>
                </div>

                {/* Probability bar */}
                <div className="flex h-1.5 rounded-full overflow-hidden mt-2 bg-slate-800">
                  <div
                    className="prob-bar bg-pitch-500"
                    style={{ width: pct(p.home) }}
                  />
                  <div
                    className="prob-bar bg-slate-500"
                    style={{ width: pct(p.draw) }}
                  />
                  <div
                    className="prob-bar bg-sky-500"
                    style={{ width: pct(p.away) }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 mt-1">
                  <span>{pct(p.home, 0)}</span>
                  <span>{pct(p.draw, 0)}</span>
                  <span>{pct(p.away, 0)}</span>
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
                {hasValue && (
                  <span className="badge-green text-[9px]">
                    VALUE
                  </span>
                )}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
