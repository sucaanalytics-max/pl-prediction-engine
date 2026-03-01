"use client";

import Link from "next/link";
import { pct, shortDate, kickoffTime, confidenceColor } from "@/lib/formats";
import { confidenceTier, type MatchPrediction } from "@/lib/predictions";

interface FixtureTableProps {
  predictions: MatchPrediction[];
}

// Lookup tables — avoids repeated ternary chains
const ACCENT: Record<"home" | "draw" | "away", { color: string; bg: string; label: string }> = {
  home: { color: "#22c55e", bg: "rgba(34,197,94,0.045)", label: "HOME WIN" },
  draw: { color: "#f59e0b", bg: "rgba(245,158,11,0.040)", label: "DRAW" },
  away: { color: "#38bdf8", bg: "rgba(56,189,248,0.040)", label: "AWAY WIN" },
};

const PROB_CELLS = [
  { key: "home" as const, label: "H", color: "#22c55e" },
  { key: "draw" as const, label: "X", color: "#94a3b8" },
  { key: "away" as const, label: "A", color: "#38bdf8" },
];

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
        const { color, bg } = ACCENT[prediction];

        return (
          <Link
            key={pred.match_id}
            href={`/matches/${pred.match_id}`}
            className="group block animate-slide-up"
            style={{ animationDelay: `${i * 45}ms`, animationFillMode: "both" }}
            role="listitem"
            aria-label={`${pred.fixture.home_team} vs ${pred.fixture.away_team}, predicted ${prediction}`}
          >
            <div
              className="fixture-card relative overflow-hidden"
              style={{
                background: `linear-gradient(115deg, ${bg} 0%, #111827 42%)`,
              }}
            >
              {/* Left accent strip */}
              <div
                className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl"
                style={{ background: color }}
                aria-hidden="true"
              />

              {/* Top shimmer */}
              <div
                className="absolute top-0 left-0 right-0 h-px opacity-25"
                style={{ background: `linear-gradient(90deg, ${color}, transparent 55%)` }}
                aria-hidden="true"
              />

              <div className="pl-6 pr-5 py-4">
                {/* ── Meta row ─────────────────────────────────── */}
                <div className="flex items-center justify-between mb-3.5">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-[10px] font-mono text-slate-600 uppercase tracking-wider">
                      {shortDate(pred.fixture.date)}&ensp;·&ensp;{kickoffTime(pred.fixture.date)}
                    </span>

                    {pred.fixture.is_derby && (
                      <span
                        className="inline-flex items-center text-[8px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{
                          background: "rgba(245,158,11,0.1)",
                          color: "#fbbf24",
                          border: "1px solid rgba(245,158,11,0.2)",
                        }}
                      >
                        DERBY
                      </span>
                    )}

                    {pred.model_disagreement !== undefined && pred.model_disagreement > 0.15 && (
                      <span className="text-[9px] font-mono font-semibold text-amber-500">
                        ⚠ SPLIT
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {valueBetCount > 0 && (
                      <span
                        className="text-[9px] font-mono font-bold px-2 py-0.5 rounded-full"
                        style={{
                          background: "rgba(34,197,94,0.1)",
                          color: "#4ade80",
                          border: "1px solid rgba(34,197,94,0.18)",
                        }}
                        aria-label={`${valueBetCount} value bet${valueBetCount > 1 ? "s" : ""}`}
                      >
                        ⚡ {valueBetCount}
                      </span>
                    )}
                    <span className="text-[9px] font-mono text-slate-700">
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
                          color: prediction === "home" ? "#f8fafc" : "#475569",
                          fontFamily: "var(--font-jakarta)",
                        }}
                      >
                        {pred.fixture.home_team}
                      </span>
                      <span
                        className="text-xs font-bold flex-shrink-0"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: prediction === "home" ? "#4ade80" : "#1e293b",
                        }}
                      >
                        {pred.expected_goals.home.toFixed(1)}
                      </span>
                    </div>

                    {/* xG separator */}
                    <div className="flex items-center gap-1.5 my-1.5">
                      <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.04)" }} />
                      <span
                        className="text-[8px] font-bold tracking-[0.18em] uppercase"
                        style={{ fontFamily: "var(--font-mono)", color: "#1e293b" }}
                      >
                        xG
                      </span>
                      <div className="h-px flex-1" style={{ background: "rgba(255,255,255,0.04)" }} />
                    </div>

                    {/* Away */}
                    <div className="flex items-baseline gap-2 mt-1.5">
                      <span
                        className="font-bold leading-tight tracking-tight truncate"
                        style={{
                          fontSize: "17px",
                          color: prediction === "away" ? "#f8fafc" : "#475569",
                          fontFamily: "var(--font-jakarta)",
                        }}
                      >
                        {pred.fixture.away_team}
                      </span>
                      <span
                        className="text-xs font-bold flex-shrink-0"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: prediction === "away" ? "#38bdf8" : "#1e293b",
                        }}
                      >
                        {pred.expected_goals.away.toFixed(1)}
                      </span>
                    </div>

                    {/* Referee — only shown on wider viewports */}
                    {pred.fixture.referee && (
                      <div className="mt-2 text-[10px] text-slate-700 truncate hidden sm:block"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {pred.fixture.referee}
                      </div>
                    )}
                  </div>

                  {/* Probability panel */}
                  <div className="flex-shrink-0" style={{ width: "152px" }}>
                    {/* Three probability cells */}
                    <div className="grid grid-cols-3 gap-1 mb-2">
                      {PROB_CELLS.map(({ key, label, color: cellColor }) => {
                        const active = prediction === key;
                        const val = probs[key];
                        return (
                          <div
                            key={key}
                            className="flex flex-col items-center py-2 rounded-lg"
                            style={{
                              background: active ? `${cellColor}14` : "rgba(255,255,255,0.025)",
                              border: `1px solid ${active ? `${cellColor}28` : "rgba(255,255,255,0.04)"}`,
                            }}
                          >
                            <span
                              className="font-bold leading-none"
                              style={{
                                fontSize: "15px",
                                fontFamily: "var(--font-mono)",
                                color: active ? cellColor : "#334155",
                              }}
                            >
                              {val}
                            </span>
                            <span
                              className="text-[8px] font-semibold tracking-wider mt-0.5 uppercase"
                              style={{
                                fontFamily: "var(--font-mono)",
                                color: active ? `${cellColor}88` : "#1e293b",
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
                        style={{ width: `${hp}%`, background: "#22c55e", borderRadius: "99px 0 0 99px" }}
                        aria-hidden="true"
                      />
                      <div style={{ width: `${dp}%`, background: "#334155" }} aria-hidden="true" />
                      <div
                        style={{ width: `${ap}%`, background: "#38bdf8", borderRadius: "0 99px 99px 0" }}
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
                              ? "#4ade80"
                              : tier === "medium"
                              ? "#fbbf24"
                              : "#334155",
                        }}
                      >
                        {tier}
                      </span>
                      <span
                        className={`text-[9px] font-mono ${confidenceColor(maxProb * 100)}`}
                      >
                        {Math.round(maxProb * 100)}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Chevron — appears on hover */}
              <div
                className="absolute right-3.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                aria-hidden="true"
              >
                <svg
                  className="w-4 h-4 text-slate-600"
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
