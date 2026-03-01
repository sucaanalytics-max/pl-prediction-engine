"use client";

import Link from "next/link";
import { usePredictions } from "@/lib/PredictionsContext";
import { timeAgo, pct } from "@/lib/formats";
import { effectiveEdge, type ValueBet } from "@/lib/predictions";
import FixtureTable from "@/components/FixtureTable";
import { ErrorBoundary, PageSkeleton, ErrorMessage } from "@/components/ErrorBoundary";

function MatchweekContent() {
  const { predictions: data, loading, error, refresh } = usePredictions();

  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !data) return <PageSkeleton rows={4} />;

  const valueBetCount = data.predictions.reduce((acc, p) => acc + p.value_bets.length, 0);
  const derbyCount = data.predictions.filter((p) => p.fixture.is_derby).length;
  const totalModels = (data.metadata.models?.length ?? 0) + (data.metadata.sub_models?.length ?? 0);

  // Find best value bet
  let bestBet: (ValueBet & { home_team: string; away_team: string }) | null = null;
  for (const pred of data.predictions) {
    for (const bet of pred.value_bets) {
      const edge = effectiveEdge(bet);
      if (!bestBet || edge > effectiveEdge(bestBet)) {
        bestBet = { ...bet, home_team: pred.fixture.home_team, away_team: pred.fixture.away_team };
      }
    }
  }

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

      {/* Best value bet callout */}
      {bestBet && (
        <Link href="/value-bets" className="block">
          <div className="card-hover p-4 flex items-center gap-4" style={{ borderLeft: "3px solid rgba(42,173,31,0.6)" }}>
            <div className="flex-shrink-0 text-pitch-500 text-lg font-bold font-mono">
              +{pct(effectiveEdge(bestBet), 1)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">Best edge this week</div>
              <div className="text-sm font-display font-semibold text-white truncate">
                {bestBet.market}{bestBet.selection ? ` — ${bestBet.selection}` : ""}
              </div>
              <div className="text-xs text-slate-500">
                {bestBet.home_team} vs {bestBet.away_team}
                {bestBet.decimal_odds && <span className="ml-2 font-mono">@ {bestBet.decimal_odds.toFixed(2)}</span>}
              </div>
            </div>
            <span className="badge-green text-[9px] flex-shrink-0">{valueBetCount} TOTAL</span>
          </div>
        </Link>
      )}

      <div className="glow-line" />

      {/* Fixtures */}
      {data.predictions.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-slate-500 text-sm">No fixtures scheduled for this gameweek yet.</div>
          <div className="text-slate-600 text-xs mt-1">Check back closer to the matchday.</div>
        </div>
      ) : (
        <FixtureTable predictions={data.predictions} />
      )}

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
