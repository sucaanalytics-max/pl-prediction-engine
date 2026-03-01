"use client";

import Link from "next/link";
import { pct, odds, edgeColor } from "@/lib/formats";
import { getHalfKellyPct, marketLabel, marketIcon, effectiveEdge, confidenceTier, type ValueBet } from "@/lib/predictions";
import { CONF_BADGES, marketBadgeColor, MARKET_ICON_LABELS, edgePrefix } from "@/lib/theme";

interface BetRow extends ValueBet {
  match_id: string;
  home_team: string;
  away_team: string;
}

interface BetTableProps {
  bets: BetRow[];
  compact?: boolean;
}

export default function BetTable({ bets, compact = false }: BetTableProps) {
  if (bets.length === 0) {
    return (
      <div className="card p-8 text-center">
        <div className="text-sm" style={{ color: "var(--text-3)" }}>No value bets identified this matchweek</div>
        <p className="text-[10px] mt-1" style={{ color: "var(--text-4)" }}>Edge threshold: 5% minimum</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table" role="table">
        <thead>
          <tr>
            <th scope="col" className="text-left">Match</th>
            <th scope="col" className="text-left">Market</th>
            <th scope="col" className="text-right">Model</th>
            <th scope="col" className="text-right hidden sm:table-cell">Implied</th>
            {!compact && (
              <th scope="col" className="text-right hidden md:table-cell">Devig</th>
            )}
            <th scope="col" className="text-right">Odds</th>
            <th scope="col" className="text-right">Edge</th>
            <th scope="col" className="text-right hidden sm:table-cell">½ Kelly</th>
            {!compact && (
              <th scope="col" className="text-center hidden md:table-cell">Conf</th>
            )}
          </tr>
        </thead>
        <tbody>
          {bets.map((bet, i) => {
            const edge = effectiveEdge(bet);
            const tier = bet.confidence_tier ?? confidenceTier(edge);
            const badge = CONF_BADGES[tier] ?? CONF_BADGES.low;

            return (
              <tr
                key={`${bet.match_id}-${bet.market}-${i}`}
                className="hover:bg-[var(--surface2)] transition-colors"
              >
                <td className="py-3 px-3">
                  <Link
                    href={`/matches/${bet.match_id}`}
                    className="transition-colors focus-visible:ring-1 focus-visible:outline-none rounded"
                    style={{ color: "var(--text-2)" }}
                  >
                    <span className="font-medium text-xs">{bet.home_team}</span>
                    <span className="mx-1 text-xs" style={{ color: "var(--text-4)" }}>v</span>
                    <span className="font-medium text-xs">{bet.away_team}</span>
                  </Link>
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs opacity-60" role="img" aria-label={MARKET_ICON_LABELS[marketIcon(bet.market)] ?? "Market"}>{marketIcon(bet.market)}</span>
                    <div>
                      <span className={`font-medium text-xs ${marketBadgeColor(bet.market)}`}>
                        {bet.selection ?? bet.market}
                      </span>
                      <span className="text-[10px] ml-1 hidden sm:inline" style={{ color: "var(--text-4)" }}>{marketLabel(bet.market)}</span>
                    </div>
                  </div>
                </td>
                <td className="py-3 px-3 text-right font-mono text-xs" style={{ color: "var(--success)" }}>{pct(bet.model_prob)}</td>
                <td className="py-3 px-3 text-right font-mono text-xs hidden sm:table-cell" style={{ color: "var(--text-3)" }}>{pct(bet.implied_prob)}</td>
                {!compact && (
                  <td className="py-3 px-3 text-right font-mono text-xs hidden md:table-cell" style={{ color: "var(--text-3)" }}>
                    {bet.devigged_prob ? pct(bet.devigged_prob) : "—"}
                  </td>
                )}
                <td className="py-3 px-3 text-right font-mono text-xs" style={{ color: "var(--text-2)" }}>
                  {(bet.decimal_odds ?? 0) > 0 ? odds(bet.decimal_odds!) : "—"}
                </td>
                <td className={`py-3 px-3 text-right font-mono text-xs font-semibold ${edgeColor(edge)}`}>
                  {edgePrefix(edge)}{pct(edge)}
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
