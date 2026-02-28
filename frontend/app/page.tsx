"use client";

import { useEffect, useState } from "react";
import { loadPredictions, type PredictionData } from "@/lib/predictions";
import { pct, timeAgo } from "@/lib/formats";
import FixtureTable from "@/components/FixtureTable";

export default function MatchweekPage() {
  const [data, setData] = useState<PredictionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPredictions()
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="card p-8 text-center">
        <p className="text-red-400 font-medium">Failed to load predictions</p>
        <p className="text-sm text-slate-500 mt-1">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="card p-6 animate-pulse">
            <div className="h-4 bg-slate-800 rounded w-1/3 mb-3" />
            <div className="h-3 bg-slate-800 rounded w-full mb-2" />
            <div className="h-3 bg-slate-800 rounded w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  const valueBetCount = data.predictions.reduce(
    (acc, p) => acc + p.value_bets.length,
    0
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="font-display text-2xl font-bold text-white tracking-tight">
            Matchweek {data.metadata.gameweek}
          </h1>
          <span className="badge-green text-[10px]">LIVE</span>
        </div>
        <p className="text-sm text-slate-500">
          {data.metadata.season} season · {data.predictions.length} fixtures ·
          Updated {timeAgo(data.metadata.generated_at)}
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card p-4">
          <div className="stat-label">Fixtures</div>
          <div className="stat-value text-white">{data.predictions.length}</div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Value Bets</div>
          <div className="stat-value text-emerald-400">{valueBetCount}</div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Models</div>
          <div className="stat-value text-sky-400">{data.metadata.models.length}</div>
        </div>
        <div className="card p-4">
          <div className="stat-label">Simulations</div>
          <div className="stat-value text-amber-400">
            {(data.metadata.n_simulations / 1000).toFixed(0)}K
          </div>
        </div>
      </div>

      <div className="glow-line" />

      {/* Fixtures */}
      <FixtureTable predictions={data.predictions} />

      {/* Pipeline info */}
      <div className="card p-4 flex items-center justify-between text-xs text-slate-500">
        <span>
          Pipeline v{data.metadata.pipeline_version} ·{" "}
          {data.metadata.models.join(" + ")}
        </span>
        <span>
          {data.metadata.calibrated ? (
            <span className="badge-green">Calibrated</span>
          ) : (
            <span className="badge-amber">Uncalibrated</span>
          )}
        </span>
      </div>
    </div>
  );
}
