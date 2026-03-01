"use client";

import Link from "next/link";
import { shortDate, kickoffTime, confidenceColor } from "@/lib/formats";
import { confidenceTier, type MatchPrediction } from "@/lib/predictions";

interface FixtureTableProps {
  predictions: MatchPrediction[];
}

const PRED_CLASS: Record<"home" | "draw" | "away", string> = {
  home: "fixture-home",
  draw: "fixture-draw",
  away: "fixture-away",
};

const PROB_CELLS: { key: "home" | "draw" | "away"; label: string; cellClass: string }[] = [
  { key: "home", label: "H", cellClass: "prob-cell prob-cell-home" },
  { key: "draw", label: "X", cellClass: "prob-cell prob-cell-draw" },
  { key: "away", label: "A", cellClass: "prob-cell prob-cell-away" },
];

const CELL_COLOR: Record<"home" | "draw" | "away", string> = {
  home: "var(--home)",
  draw: "var(--draw)",
  away: "var(--away)",
};

export default function FixtureTable({ predictions }: FixtureTableProps) {
  return (
    <div className="space-y-2.5" role="list" aria-label="Match fixtures">
      {predictions.map((pred, i) => {
        const p = pred.probabilities["1x2"];
        const maxProb = Math.max(p.home, p.draw, p.away);
        const prediction: "home" | "draw" | "away" =
          p.home === maxProb ? "home" : p.away === maxProb ? "away" : "draw";
        const valueBetCount = pred.value_bets.length;
        const tier = confidenceTier(maxProb);
        const hp = Math.round(p.home * 100);
        const dp = Math.round(p.draw * 100);
        const ap = Math.round(p.away * 100);
        const probs = { home: hp, draw: dp, away: ap };

        return (
          <Link
            key={pred.match_id}
            href={`/matches/${pred.match_id}`}
            className="group block animate-slide-up"
            style={{ animationDelay: `${i * 45}ms`, animationFillMode: "both" }}
            role="listitem"
            aria-label={`${pred.fixture.home_team} vs ${pred.fixture.away_team}, predicted ${prediction}`}
          >
            <div className={`fixture-card relative overflow-hidden ${PRED_CLASS[prediction]}`}>
              {/* Left accent strip */}
              <div
                className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl"
                style={{ background: CELL_COLOR[prediction] }}
                aria-hidden="true"
              />

              {/* Top shimmer */}
              <div
                className="absolute top-0 left-0 right-0 h-px opacity-25"
                style={{ background: `linear-gradient(90deg, ${CELL_COLOR[prediction]}, transparent 55%)` }}
                aria-hidden="true"
              />

              <div className="pl-6 pr-5 py-4">
                {/* ── Meta row ─────────────────────────────────── */}
                <div className="flex items-center justify-between mb-3.5">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-4)" }}>
                      {shortDate(pred.fixture.date)}&ensp;·&ensp;{kickoffTime(pred.fixture.date)}
                    </span>

                    {pred.fixture.is_derby && (
                      <span
                        className="inline-flex items-center text-[8px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{
                          background: "var(--warning-muted)",
                          color: "var(--warning)",
                          border: "1px solid var(--warning-border)",
                        }}
                      >
                        DERBY
                      </span>
                    )}

                    {pred.model_disagreement !== undefined && pred.model_disagreement > 0.15 && (
                      <span className="text-[9px] font-mono font-semibold" style={{ color: "var(--warning)" }}>
                        ⚠ SPLIT
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {valueBetCount > 0 && (
                      <span
                        className="text-[9px] font-mono font-bold px-2 py-0.5 rounded-full"
                        style={{
                          background: "var(--success-muted)",
                          color: "var(--accent-text)",
                          border: "1px solid var(--success-border)",
                        }}
                        aria-label={`${valueBetCount} value bet${valueBetCount > 1 ? "s" : ""}`}
                      >
                        ⚡ {valueBetCount}
                      </span>
                    )}
                    <span className="text-[9px] font-mono" style={{ color: "var(--text-4)" }}>
                      GW{pred.fixture.gameweek}
                    </span>
                  </div>
                </div>

                {/* ── Main content ──────────────────────────────── */}
                <div className="flex items-stretch gap-5">
                  {/* Teams + xG column */}
                  <div className="flex-1 min-w-0">
                    {/* Home */}
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <span
                        className="font-bold leading-tight tracking-tight truncate"
                        style={{
                          fontSize: "17px",
                          color: prediction === "home" ? "var(--text-1)" : "var(--text-3)",
                          fontFamily: "var(--font-jakarta)",
                        }}
                      >
                        {pred.fixture.home_team}
                      </span>
                      <span
                        className="text-xs font-bold flex-shrink-0"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: prediction === "home" ? "var(--home)" : "var(--text-4)",
                        }}
                      >
                        {pred.expected_goals.home.toFixed(1)}
                      </span>
                    </div>

                    {/* xG separator */}
                    <div className="flex items-center gap-1.5 my-1.5">
                      <div className="h-px flex-1" style={{ background: "var(--border)" }} />
                      <span
                        className="text-[8px] font-bold tracking-[0.18em] uppercase"
                        style={{ fontFamily: "var(--font-mono)", color: "var(--text-4)" }}
                      >
                        xG
                      </span>
                      <div className="h-px flex-1" style={{ background: "var(--border)" }} />
                    </div>

                    {/* Away */}
                    <div className="flex items-baseline gap-2 mt-1.5">
                      <span
                        className="font-bold leading-tight tracking-tight truncate"
                        style={{
                          fontSize: "17px",
                          color: prediction === "away" ? "var(--text-1)" : "var(--text-3)",
                          fontFamily: "var(--font-jakarta)",
                        }}
                      >
                        {pred.fixture.away_team}
                      </span>
                      <span
                        className="text-xs font-bold flex-shrink-0"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: prediction === "away" ? "var(--away)" : "var(--text-4)",
                        }}
                      >
                        {pred.expected_goals.away.toFixed(1)}
                      </span>
                    </div>

                    {/* Referee */}
                    {pred.fixture.referee && (
                      <div className="mt-2 text-[10px] truncate hidden sm:block"
                        style={{ fontFamily: "var(--font-mono)", color: "var(--text-4)" }}
                      >
                        {pred.fixture.referee}
                      </div>
                    )}
                  </div>

                  {/* Probability panel */}
                  <div className="flex-shrink-0" style={{ width: "152px" }}>
                    {/* Three probability cells */}
                    <div className="grid grid-cols-3 gap-1 mb-2">
                      {PROB_CELLS.map(({ key, label, cellClass }) => {
                        const active = prediction === key;
                        const val = probs[key];
                        return (
                          <div
                            key={key}
                            className={cellClass}
                            data-active={active ? "true" : undefined}
                          >
                            <span
                              className="font-bold leading-none"
                              style={{
                                fontSize: "15px",
                                fontFamily: "var(--font-mono)",
                                color: active ? CELL_COLOR[key] : "var(--text-3)",
                              }}
                            >
                              {val}
                            </span>
                            <span
                              className="text-[8px] font-semibold tracking-wider mt-0.5 uppercase"
                              style={{
                                fontFamily: "var(--font-mono)",
                                color: active ? CELL_COLOR[key] : "var(--text-4)",
                              }}
                            >
                              {label}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Probability bar */}
                    <div className="flex h-[5px] rounded-full overflow-hidden">
                      <div
                        style={{ width: `${hp}%`, background: "var(--home)", borderRadius: "99px 0 0 99px" }}
                        aria-hidden="true"
                      />
                      <div style={{ width: `${dp}%`, background: "var(--border-strong)" }} aria-hidden="true" />
                      <div
                        style={{ width: `${ap}%`, background: "var(--away)", borderRadius: "0 99px 99px 0" }}
                        aria-hidden="true"
                      />
                    </div>

                    {/* Confidence row */}
                    <div className="flex items-center justify-between mt-1.5">
                      <span
                        className="text-[9px] font-semibold uppercase tracking-wider"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color:
                            tier === "high"
                              ? "var(--success)"
                              : tier === "medium"
                              ? "var(--warning)"
                              : "var(--text-4)",
                        }}
                      >
                        {tier}
                      </span>
                      <span className={`text-[9px] font-mono ${confidenceColor(maxProb * 100)}`}>
                        {Math.round(maxProb * 100)}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Chevron */}
              <div
                className="absolute right-3.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                aria-hidden="true"
              >
                <svg
                  className="w-4 h-4"
                  style={{ color: "var(--text-3)" }}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
