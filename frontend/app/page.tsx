"use client";

import { usePredictions } from "@/lib/PredictionsContext";
import { timeAgo } from "@/lib/formats";
import FixtureTable from "@/components/FixtureTable";
import { ErrorBoundary, PageSkeleton, ErrorMessage } from "@/components/ErrorBoundary";

function MatchweekContent() {
  const { predictions: data, loading, error, refresh } = usePredictions();

  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !data) return <PageSkeleton rows={4} />;

  const valueBetCount = data.predictions.reduce((acc, p) => acc + p.value_bets.length, 0);
  const derbyCount = data.predictions.filter((p) => p.fixture.is_derby).length;
  const totalModels = (data.metadata.models?.length ?? 0) + (data.metadata.sub_models?.length ?? 0);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="font-display text-2xl font-bold text-white tracking-tight">
            Matchweek {data.metadata.gameweek}
          </h1>
          <span className="badge-green text-[10px]">LIVE</span>
          {derbyCount > 0 && (
            <span className="badge-amber text-[10px]">{derbyCount} DERBY</span>
          )}
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
          <div className="stat-value text-sky-400">{totalModels}</div>
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
      <div className="card p-4 flex items-center justify-between text-xs text-slate-500 gap-2 flex-wrap">
        <span>
          Pipeline v{data.metadata.pipeline_version} ·{" "}
          {[...(data.metadata.models ?? []), ...(data.metadata.sub_models ?? [])].join(" + ")}
        </span>
        <div className="flex items-center gap-2">
          {data.metadata.odds_source && (
            <span className="text-slate-600">
              odds: {data.metadata.odds_source.replace("_", " ")}
            </span>
          )}
          {data.metadata.ensemble_method && (
            <span className="badge-green text-[9px]">{data.metadata.ensemble_method.toUpperCase()}</span>
          )}
          {data.metadata.calibrated ? (
            <span className="badge-green">Calibrated</span>
          ) : (
            <span className="badge-amber">Uncalibrated</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MatchweekPage() {
  return (
    <ErrorBoundary pageName="Matchweek">
      <MatchweekContent />
    </ErrorBoundary>
  );
}
