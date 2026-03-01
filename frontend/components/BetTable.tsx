"use client";

import Link from "next/link";
import { pct, odds, edgeColor } from "@/lib/formats";
import { getHalfKellyPct, marketLabel, marketIcon, effectiveEdge, confidenceTier, type ValueBet } from "@/lib/predictions";

interface BetRow extends ValueBet {
  match_id: string;
  home_team: string;
  away_team: string;
}

interface BetTableProps {
  bets: BetRow[];
  compact?: boolean;
}

const CONF_BADGES: Record<string, { label: string; cls: string }> = {
  high: { label: "HIGH", cls: "badge-green" },
  medium: { label: "MED", cls: "badge-amber" },
  low: { label: "LOW", cls: "text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider" },
};

function marketBadgeClass(market: string): string {
  const cat = marketLabel(market);
  if (cat === "Corners") return "text-violet-400";
  if (cat === "Cards") return "text-amber-400";
  if (cat === "Goalscorer") return "text-emerald-400";
  if (cat === "Player") return "text-sky-400";
  if (cat === "BTTS") return "text-orange-400";
  return "text-emerald-400";
}

export default function BetTable({ bets, compact = false }: BetTableProps) {
  if (bets.length === 0) {
    return (
      <div className="card p-8 text-center">
        <div className="text-slate-600 text-sm">No value bets identified this matchweek</div>
        <p className="text-[10px] text-slate-700 mt-1">Edge threshold: 5% minimum</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" role="table">
        <thead>
          <tr className="border-b border-slate-800/60">
            <th className="text-left py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium">Match</th>
            <th className="text-left py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium">Market</th>
            <th className="text-right py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium">Model</th>
            <th className="text-right py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium hidden sm:table-cell">Implied</th>
            {!compact && (
              <th className="text-right py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium hidden md:table-cell">Devig</th>
            )}
            <th className="text-right py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium">Odds</th>
            <th className="text-right py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium">Edge</th>
            <th className="text-right py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium hidden sm:table-cell">½ Kelly</th>
            {!compact && (
              <th className="text-center py-3 px-3 text-[10px] uppercase tracking-wider text-slate-500 font-medium hidden md:table-cell">Conf</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/40">
          {bets.map((bet, i) => {
            const edge = effectiveEdge(bet);
            const tier = bet.confidence_tier ?? confidenceTier(edge);
            const badge = CONF_BADGES[tier] ?? CONF_BADGES.low;

            return (
              <tr
                key={`${bet.match_id}-${bet.market}-${i}`}
                className="hover:bg-slate-800/30 transition-colors"
              >
                <td className="py-3 px-3">
                  <Link
                    href={`/matches/${bet.match_id}`}
                    className="text-slate-300 hover:text-white transition-colors focus-visible:ring-1 focus-visible:ring-pitch-500 focus-visible:outline-none rounded"
                  >
                    <span className="font-medium text-xs">{bet.home_team}</span>
                    <span className="text-slate-600 mx-1 text-xs">v</span>
                    <span className="font-medium text-xs">{bet.away_team}</span>
                  </Link>
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs opacity-60" aria-hidden="true">{marketIcon(bet.market)}</span>
                    <div>
                      <span className={`font-medium text-xs ${marketBadgeClass(bet.market)}`}>
                        {bet.selection ?? bet.market}
                      </span>
                      <span className="text-slate-600 text-[10px] ml-1 hidden sm:inline">{marketLabel(bet.market)}</span>
                    </div>
                  </div>
                </td>
                <td className="py-3 px-3 text-right font-mono text-xs text-emerald-400">{pct(bet.model_prob)}</td>
                <td className="py-3 px-3 text-right font-mono text-xs text-slate-500 hidden sm:table-cell">{pct(bet.implied_prob)}</td>
                {!compact && (
                  <td className="py-3 px-3 text-right font-mono text-xs text-slate-400 hidden md:table-cell">
                    {bet.devigged_prob ? pct(bet.devigged_prob) : "—"}
                  </td>
                )}
                <td className="py-3 px-3 text-right font-mono text-xs text-slate-300">
                  {(bet.decimal_odds ?? 0) > 0 ? odds(bet.decimal_odds!) : "—"}
                </td>
                <td className={`py-3 px-3 text-right font-mono text-xs font-semibold ${edgeColor(edge)}`}>
                  +{pct(edge)}
                </td>
                <td className="py-3 px-3 text-right font-mono text-xs text-sky-400 hidden sm:table-cell">
                  {getHalfKellyPct(bet) > 0 ? pct(getHalfKellyPct(bet)) : "—"}
                </td>
                {!compact && (
                  <td className="py-3 px-3 text-center hidden md:table-cell">
                    <span className={`${badge.cls} text-[9px]`}>{badge.label}</span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
