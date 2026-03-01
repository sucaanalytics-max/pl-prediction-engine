"use client";

import Link from "next/link";
import { pct, odds, edgeColor } from "@/lib/formats";
import { getHalfKellyPct, marketLabel, type ValueBet } from "@/lib/predictions";

interface BetRow extends ValueBet {
  match_id: string;
  home_team: string;
  away_team: string;
}

interface BetTableProps {
  bets: BetRow[];
}

function marketBadgeClass(market: string): string {
  const cat = marketLabel(market);
  if (cat === "Corners") return "text-violet-400";
  if (cat === "Cards") return "text-amber-400";
  if (cat === "Player") return "text-sky-400";
  return "text-emerald-400";
}

export default function BetTable({ bets }: BetTableProps) {
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
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800/60">
            <th className="text-left py-3 px-3 text-xs uppercase tracking-wider text-slate-500 font-medium">Match</th>
            <th className="text-left py-3 px-3 text-xs uppercase tracking-wider text-slate-500 font-medium">Market</th>
            <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500 font-medium">Model</th>
            <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500 font-medium">Implied</th>
            <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500 font-medium">Odds</th>
            <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500 font-medium">Edge</th>
            <th className="text-right py-3 px-3 text-xs uppercase tracking-wider text-slate-500 font-medium">½ Kelly</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/40">
          {bets.map((bet, i) => (
            <tr
              key={`${bet.match_id}-${bet.market}-${i}`}
              className="hover:bg-slate-800/30 transition-colors"
            >
              <td className="py-3 px-3">
                <Link
                  href={`/matches/${bet.match_id}`}
                  className="text-slate-300 hover:text-white transition-colors"
                >
                  <span className="font-medium">{bet.home_team}</span>
                  <span className="text-slate-600 mx-1">v</span>
                  <span className="font-medium">{bet.away_team}</span>
                </Link>
              </td>
              <td className="py-3 px-3">
                <div className="flex flex-col gap-0.5">
                  <span className={`font-medium text-xs ${marketBadgeClass(bet.market)}`}>
                    {marketLabel(bet.market)}
                  </span>
                  <span className="text-slate-400 text-xs">{bet.market}{bet.selection ? ` · ${bet.selection}` : ""}</span>
                </div>
              </td>
              <td className="py-3 px-3 text-right font-mono text-emerald-400">{pct(bet.model_prob)}</td>
              <td className="py-3 px-3 text-right font-mono text-slate-500">{pct(bet.implied_prob)}</td>
              <td className="py-3 px-3 text-right font-mono text-slate-300">
                {(bet.decimal_odds ?? 0) > 0 ? odds(bet.decimal_odds!) : "—"}
              </td>
              <td className={`py-3 px-3 text-right font-mono font-semibold ${edgeColor(bet.edge)}`}>
                +{pct(bet.edge)}
              </td>
              <td className="py-3 px-3 text-right font-mono text-sky-400">
                {pct(getHalfKellyPct(bet))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
