"use client";

import { useEffect, useState } from "react";
import { loadPredictions, getAllValueBets, type PredictionData } from "@/lib/predictions";
import { pct, timeAgo } from "@/lib/formats";
import BetTable from "@/components/BetTable";

export default function ValueBetsPage() {
  const [data, setData] = useState<PredictionData | null>(null);

  useEffect(() => {
    loadPredictions().then(setData);
  }, []);

  if (!data) {
    return (
      <div className="card p-8 animate-pulse">
        <div className="h-6 bg-slate-800 rounded w-1/3 mb-4" />
        <div className="h-4 bg-slate-800 rounded w-full mb-2" />
        <div className="h-4 bg-slate-800 rounded w-2/3" />
      </div>
    );
  }

  const bets = getAllValueBets(data);
  const totalEdge = bets.reduce((s, b) => s + b.edge, 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-white tracking-tight">
          Value Bets
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Matchweek {data.metadata.gameweek} · {bets.length} opportunities ·
          Updated {timeAgo(data.metadata.generated_at)}
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card p-4">
          <div className="stat-label">Bets Found</div>
          <div className="stat-value text-white">{bets.length}</div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Avg Edge</div>
          <div className="stat-value text-emerald-400">
            {bets.length > 0 ? pct(totalEdge / bets.length) : "—"}
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Best Edge</div>
          <div className="stat-value text-emerald-400">
            {bets.length > 0 ? pct(bets[0].edge) : "—"}
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Min Edge Filter</div>
          <div className="stat-value text-slate-400">5%</div>
        </div>
      </div>

      <div className="glow-line" />

      {/* Table */}
      <div className="card p-4">
        <BetTable bets={bets} />
      </div>

      {/* Disclaimer */}
      <div className="text-[10px] text-slate-600 text-center max-w-xl mx-auto">
        All predictions are model-generated and for informational purposes only.
        Past performance does not guarantee future results. Always bet responsibly.
        Kelly stakes assume independent events and no vig adjustment.
      </div>
    </div>
  );
}
