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
            <div className={`fixture-card relative overflow-hidden ${PRED_CLASS[prediction]} group-hover:scale-[1.02] transition-transform duration-400`}>
              {/* Left accent strip */}
              <div
                className="absolute left-0 top-0 bottom-0 w-1.5"
                style={{ background: CELL_COLOR[prediction], boxShadow: `0 0 15px ${CELL_COLOR[prediction]}` }}
                aria-hidden="true"
              />

              {/* Shimmer effect on hover */}
              <div
                className="absolute inset-0 translate-x-[-100%] group-hover:animate-[pulse-shimmer_2s_infinite]"
                aria-hidden="true"
              />

              <div className="pl-6 pr-5 py-4">
                {/* ── Meta row ─────────────────────────────────── */}
                <div className="flex items-center justify-between mb-4 border-b border-[var(--border)] pb-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-[11px] font-mono uppercase tracking-[0.1em] font-semibold" style={{ color: "var(--text-4)" }}>
                      {shortDate(pred.fixture.date)} <span className="opacity-50 mx-1">•</span> {kickoffTime(pred.fixture.date)}
                    </span>

                    {pred.fixture.is_derby && (
                      <span className="badge-amber">DERBY</span>
                    )}

                    {pred.model_disagreement !== undefined && pred.model_disagreement > 0.15 && (
                      <span className="badge-red flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-none bg-[var(--error)] animate-pulse" /> SPLIT
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 flex-shrink-0">
                    {valueBetCount > 0 && (
                      <span
                        className="text-[10px] font-mono font-extrabold px-2.5 py-0.5 rounded-none relative overflow-hidden group/badge"
                        style={{
                          background: "var(--success-muted)",
                          color: "var(--accent)",
                          border: "1px solid var(--accent-border)",
                        }}
                        aria-label={`${valueBetCount} value bet${valueBetCount > 1 ? "s" : ""}`}
                      >
                        <span className="mr-1 group-hover/badge:animate-pulse">⚡</span>{valueBetCount} EV+
                      </span>
                    )}
                    <span className="text-[10px] font-mono font-bold tracking-widest uppercase px-2 py-0.5 rounded-none glass-panel" style={{ color: "var(--text-3)" }}>
                      GW{pred.fixture.gameweek}
                    </span>
                  </div>
                </div>

                {/* ── Main content ──────────────────────────────── */}
                <div className="flex items-stretch gap-6">
                  {/* Teams + xG column */}
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    {/* Home */}
                    <div className="flex items-baseline gap-3 mb-2">
                      <span
                        className="font-extrabold leading-tight tracking-tight truncate group-hover:pl-1 transition-all duration-300"
                        style={{
                          fontSize: "19px",
                          color: prediction === "home" ? "var(--text-1)" : "var(--text-3)",
                          fontFamily: "var(--font-display)",
                          textShadow: prediction === "home" ? "0 0 10px rgba(255,255,255,0.1)" : "none"
                        }}
                      >
                        {pred.fixture.home_team}
                      </span>
                      <span
                        className="text-sm font-bold flex-shrink-0 ml-auto glass-panel px-2 py-0.5 rounded"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: prediction === "home" ? "var(--home)" : "var(--text-4)",
                        }}
                      >
                        {pred.expected_goals.home.toFixed(1)}
                      </span>
                    </div>

                    {/* xG separator */}
                    <div className="flex items-center gap-2 my-2">
                      <div className="h-[2px] rounded-none flex-1 opacity-50" style={{ background: "linear-gradient(90deg, transparent, var(--border-strong))" }} />
                      <span
                        className="text-[9px] font-extrabold tracking-[0.2em] uppercase px-2 py-0.5 rounded-none glass-panel"
                        style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}
                      >
                        xG
                      </span>
                      <div className="h-[2px] rounded-none flex-1 opacity-50" style={{ background: "linear-gradient(90deg, var(--border-strong), transparent)" }} />
                    </div>

                    {/* Away */}
                    <div className="flex items-baseline gap-3 mt-2">
                      <span
                        className="font-extrabold leading-tight tracking-tight truncate group-hover:pl-1 transition-all duration-300"
                        style={{
                          fontSize: "19px",
                          color: prediction === "away" ? "var(--text-1)" : "var(--text-3)",
                          fontFamily: "var(--font-display)",
                          textShadow: prediction === "away" ? "0 0 10px rgba(255,255,255,0.1)" : "none"
                        }}
                      >
                        {pred.fixture.away_team}
                      </span>
                      <span
                        className="text-sm font-bold flex-shrink-0 ml-auto glass-panel px-2 py-0.5 rounded"
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
                      <div className="mt-4 pt-3 border-t border-[var(--border)] text-[10px] truncate hidden sm:flex items-center gap-2"
                        style={{ fontFamily: "var(--font-mono)", color: "var(--text-4)" }}
                      >
                        <span className="opacity-50 tracking-widest uppercase">REF:</span> {pred.fixture.referee}
                      </div>
                    )}
                  </div>

                  {/* Probability panel */}
                  <div className="flex-shrink-0" style={{ width: "160px" }}>
                    {/* Three probability cells */}
                    <div className="grid grid-cols-3 gap-1.5 mb-3">
                      {PROB_CELLS.map(({ key, label, cellClass }) => {
                        const active = prediction === key;
                        const val = probs[key];
                        return (
                          <div
                            key={key}
                            className={`${cellClass} ${active ? 'scale-105 z-10' : ''}`}
                            data-active={active ? "true" : undefined}
                          >
                            <span
                              className="font-extrabold leading-none prob-val"
                              style={{
                                fontSize: "16px",
                                fontFamily: "var(--font-mono)",
                                color: active ? CELL_COLOR[key] : "var(--text-3)",
                              }}
                            >
                              {val}
                            </span>
                            <span
                              className="text-[9px] font-bold tracking-wider mt-1 uppercase"
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
                    <div className="flex h-2 rounded-none overflow-hidden shadow-inner glass-panel border border-[var(--border)]">
                      <div
                        style={{ width: `${hp}%`, background: "var(--home)", boxShadow: "0 0 10px var(--home)" }}
                        className="transition-all duration-1000 ease-out"
                        aria-hidden="true"
                      />
                      <div style={{ width: `${dp}%`, background: "var(--draw)" }} className="transition-all duration-1000 ease-out" aria-hidden="true" />
                      <div
                        style={{ width: `${ap}%`, background: "var(--away)", boxShadow: "0 0 10px var(--away)" }}
                        className="transition-all duration-1000 ease-out"
                        aria-hidden="true"
                      />
                    </div>

                    {/* Confidence row */}
                    <div className="flex items-center justify-between mt-3 px-1">
                      <span
                        className="text-[10px] font-extrabold uppercase tracking-[0.1em]"
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
                        {tier} CONF
                      </span>
                      <span className={`text-[11px] font-bold font-mono ${confidenceColor(maxProb * 100)}`}>
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
