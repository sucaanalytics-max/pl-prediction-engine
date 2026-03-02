"use client";

import Link from "next/link";
import { usePredictions } from "@/lib/PredictionsContext";
import { timeAgo, pct } from "@/lib/formats";
import { effectiveEdge, type ValueBet } from "@/lib/predictions";
import FixtureTable from "@/components/FixtureTable";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";

function MatchweekContent() {
  const { predictions: data, loading, error, refresh } = usePredictions();

  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !data) return <PageSkeleton rows={4} />;

  const valueBetCount = data.predictions.reduce((acc, p) => acc + p.value_bets.length, 0);
  const derbyCount = data.predictions.filter((p) => p.fixture.is_derby).length;
  const totalModels =
    (data.metadata.models?.length ?? 0) + (data.metadata.sub_models?.length ?? 0);

  const bestBet = data.predictions
    .flatMap((pred) =>
      pred.value_bets.map((bet) => ({
        ...bet,
        home_team: pred.fixture.home_team,
        away_team: pred.fixture.away_team,
      }))
    )
    .reduce<(ValueBet & { home_team: string; away_team: string }) | null>((best, current) => {
      if (!best) return current;
      return effectiveEdge(current) > effectiveEdge(best) ? current : best;
    }, null);

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap relative z-10">
        <div>
          <div className="flex items-center gap-3 mb-1.5 flex-wrap">
            <h1
              className="text-4xl font-extrabold tracking-tighter bg-clip-text text-transparent drop-shadow-sm"
              style={{ backgroundImage: "linear-gradient(135deg, var(--text-1) 0%, var(--text-3) 100%)", fontFamily: "var(--font-jakarta)" }}
            >
              Matchweek {data.metadata.gameweek}
            </h1>
            <span className="badge-green animate-pulse">LIVE</span>
            {derbyCount > 0 && <span className="badge-amber">{derbyCount} DERBY</span>}
          </div>
          <p className="text-sm font-medium tracking-wide" style={{ color: "var(--text-3)" }}>
            {data.metadata.season} <span className="mx-1.5 opacity-50">•</span> {data.predictions.length} fixtures <span className="mx-1.5 opacity-50">•</span>{" "}
            Updated {timeAgo(data.metadata.generated_at)}
          </p>
        </div>

        {/* Pipeline pill */}
        <div
          className="flex-shrink-0 flex items-center gap-2.5 px-3 py-1.5 rounded-full text-xs font-mono font-bold glass-panel hover:scale-105 transition-transform"
          style={{ color: "var(--text-2)" }}
        >
          <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(16,185,129,0.8)] flex-shrink-0 animate-pulse" aria-hidden="true" />
          <span>v{data.metadata.pipeline_version}</span>
          {data.metadata.calibrated && <span className="badge-green text-[9px] ml-1">CAL</span>}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 relative z-10">
        <StatCard label="Fixtures" value={data.predictions.length} />
        <StatCard
          label="Value Bets"
          value={valueBetCount}
          accent
          sub={valueBetCount > 0 ? "across all markets" : "none found"}
        />
        <StatCard
          label="Models"
          value={totalModels}
          sub={data.metadata.ensemble_method ?? undefined}
        />
        <StatCard
          label="Simulations"
          value={`${(data.metadata.n_simulations / 1000).toFixed(0)}K`}
          sub="Monte Carlo"
        />
      </div>

      {/* Best value bet callout */}
      {bestBet && (
        <Link href="/value-bets" className="block relative z-10">
          <div className="premium-glow-border p-5 flex items-center gap-5 group hover:scale-[1.01] transition-transform duration-300">
            <div
              className="text-3xl font-extrabold flex-shrink-0 bg-clip-text text-transparent drop-shadow-sm group-hover:scale-110 transition-transform duration-300"
              style={{ backgroundImage: "linear-gradient(135deg, var(--success) 0%, #3b82f6 100%)", fontFamily: "var(--font-mono)" }}
            >
              +{pct(effectiveEdge(bestBet), 1)}
            </div>
            <div className="flex-1 min-w-0 border-l border-[var(--border)] pl-5">
              <div
                className="text-[10px] uppercase tracking-[0.2em] mb-1 font-bold flex items-center gap-2"
                style={{ color: "var(--accent)" }}
              >
                Top Value Pick <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)] animate-pulse" />
              </div>
              <div
                className="text-lg font-bold truncate mb-0.5"
                style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
              >
                {bestBet.market}
                {bestBet.selection ? ` — ${bestBet.selection}` : ""}
              </div>
              <div className="text-sm font-medium" style={{ color: "var(--text-3)" }}>
                {bestBet.home_team} vs {bestBet.away_team}
                {bestBet.decimal_odds && (
                  <span className="ml-2 font-mono px-2 py-0.5 rounded-md glass-panel text-xs text-[var(--text-1)]">@ {bestBet.decimal_odds.toFixed(2)}</span>
                )}
              </div>
            </div>
            <span className="badge-green flex-shrink-0 shadow-lg group-hover:shadow-[var(--glow-accent)] transition-shadow">Explore all {valueBetCount}</span>
          </div>
        </Link>
      )}

      <div className="glow-line" />

      {/* Fixtures list */}
      <div className="relative z-10">
        {data.predictions.length === 0 ? (
          <div className="glass-panel p-12 text-center rounded-2xl border-dashed border-2">
            <p className="text-lg font-medium" style={{ color: "var(--text-2)" }}>No fixtures scheduled for this gameweek yet.</p>
            <p className="text-sm mt-2" style={{ color: "var(--text-4)" }}>Check back closer to the matchday as odds become available.</p>
          </div>
        ) : (
          <FixtureTable predictions={data.predictions} />
        )}
      </div>

      {/* Model footer */}
      <div className="flex items-center justify-between text-xs gap-4 flex-wrap px-2 py-4 mt-8 border-t border-[var(--border)] relative z-10" style={{ color: "var(--text-4)" }}>
        <span className="font-mono tracking-wider opacity-80 uppercase text-[10px]">
          Engine: {[...(data.metadata.models ?? []), ...(data.metadata.sub_models ?? [])].join(" + ")}
        </span>
        {data.metadata.odds_source && (
          <span className="font-mono tracking-wider opacity-80 uppercase text-[10px] glass-panel px-2 py-1 rounded">
            Odds: {data.metadata.odds_source.replace("_", " ")}
          </span>
        )}
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
