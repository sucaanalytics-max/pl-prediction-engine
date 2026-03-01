"use client";

import Link from "next/link";
import { pct, shortDate, kickoffTime, confidenceColor, predictionLabel } from "@/lib/formats";
import { confidenceTier, type MatchPrediction } from "@/lib/predictions";
import { ProbabilityBar } from "@/components/ui/ProgressBar";

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

        return (
          <Link
            key={pred.match_id}
            href={`/matches/${pred.match_id}`}
            className="card-hover block animate-slide-up"
            style={{ animationDelay: `${i * 30}ms`, animationFillMode: "both", padding: "16px 20px" }}
            role="listitem"
            aria-label={`${pred.fixture.home_team} vs ${pred.fixture.away_team}`}
          >
            {/* Top row */}
            <div className="flex items-start gap-4">
              {/* Date column */}
              <div className="w-16 flex-shrink-0 pt-0.5">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                  {shortDate(pred.fixture.date)}
                </div>
                <div className="text-xs font-mono text-slate-500 mt-0.5">
                  {kickoffTime(pred.fixture.date)}
                </div>
              </div>

              {/* Teams + bar */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-2">
                  <span
                    className="font-bold text-base leading-tight"
                    style={{
                      color: prediction === "home" ? "#fff" : "#64748b",
                      fontFamily: "var(--font-jakarta)",
                    }}
                  >
                    {pred.fixture.home_team}
                  </span>

                  <div className="flex flex-col items-center mx-4 flex-shrink-0">
                    <span className="text-[10px] text-slate-600 font-semibold">VS</span>
                    {pred.fixture.is_derby && (
                      <span className="badge-amber text-[8px] mt-0.5 !px-1">DERBY</span>
                    )}
                  </div>

                  <span
                    className="font-bold text-base leading-tight text-right"
                    style={{
                      color: prediction === "away" ? "#fff" : "#64748b",
                      fontFamily: "var(--font-jakarta)",
                    }}
                  >
                    {pred.fixture.away_team}
                  </span>
                </div>

                <ProbabilityBar home={p.home} draw={p.draw} away={p.away} />

                {/* Sub-row */}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  <span className="text-[10px] font-mono text-slate-600">
                    xG {pred.expected_goals.home.toFixed(1)}–{pred.expected_goals.away.toFixed(1)}
                  </span>
                  {pred.fixture.referee && (
                    <span className="text-[10px] text-slate-600 truncate max-w-[140px]">
                      {pred.fixture.referee}
                    </span>
                  )}
                  {pred.model_disagreement !== undefined && pred.model_disagreement > 0.15 && (
                    <span className="text-[9px] text-amber-500 font-semibold">⚠ SPLIT</span>
                  )}
                </div>
              </div>

              {/* Right column — prediction badge + value */}
              <div className="flex-shrink-0 text-right space-y-1.5 min-w-[72px]">
                <div className="flex items-center justify-end gap-1.5">
                  <span
                    className={`font-bold text-sm ${confidenceColor(maxProb * 100)}`}
                    style={{ fontFamily: "var(--font-jakarta)" }}
                  >
                    {predictionLabel(prediction)}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">{pct(maxProb, 0)}</span>
                </div>
                <div className="flex items-center justify-end gap-1">
                  {valueBetCount > 0 && (
                    <span className="badge-green text-[9px]">{valueBetCount} val</span>
                  )}
                  {tier === "high" && valueBetCount === 0 && (
                    <span className="badge-sky text-[9px]">HIGH</span>
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
