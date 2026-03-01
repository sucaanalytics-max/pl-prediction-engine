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
    <div className="space-y-6 animate-slide-up">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 mb-1 flex-wrap">
            <h1
              className="text-3xl font-extrabold tracking-tight"
              style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
            >
              Matchweek {data.metadata.gameweek}
            </h1>
            <span className="badge-green">LIVE</span>
            {derbyCount > 0 && <span className="badge-amber">{derbyCount} DERBY</span>}
          </div>
          <p className="text-sm" style={{ color: "var(--text-3)" }}>
            {data.metadata.season} · {data.predictions.length} fixtures ·{" "}
            Updated {timeAgo(data.metadata.generated_at)}
          </p>
        </div>

        {/* Pipeline pill */}
        <div
          className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px]"
          style={{ color: "var(--text-3)", background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" aria-hidden="true" />
          <span>v{data.metadata.pipeline_version}</span>
          {data.metadata.calibrated && <span className="badge-green text-[8px]">CAL</span>}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
        <Link href="/value-bets" className="block">
          <div
            className="card-hover p-4 flex items-center gap-4"
            style={{ borderLeft: "3px solid var(--accent)" }}
          >
            <div
              className="text-xl font-bold flex-shrink-0"
              style={{ color: "var(--success)", fontFamily: "var(--font-mono)" }}
            >
              +{pct(effectiveEdge(bestBet), 1)}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className="text-[10px] uppercase tracking-wider mb-0.5 font-semibold"
                style={{ color: "var(--text-3)" }}
              >
                Best edge this week
              </div>
              <div
                className="text-sm font-semibold truncate"
                style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
              >
                {bestBet.market}
                {bestBet.selection ? ` — ${bestBet.selection}` : ""}
              </div>
              <div className="text-xs" style={{ color: "var(--text-3)" }}>
                {bestBet.home_team} vs {bestBet.away_team}
                {bestBet.decimal_odds && (
                  <span className="ml-2 font-mono">@ {bestBet.decimal_odds.toFixed(2)}</span>
                )}
              </div>
            </div>
            <span className="badge-green flex-shrink-0">{valueBetCount} total</span>
          </div>
        </Link>
      )}

      <div className="glow-line" />

      {/* Fixtures list */}
      {data.predictions.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm" style={{ color: "var(--text-3)" }}>No fixtures scheduled for this gameweek yet.</p>
          <p className="text-xs mt-1" style={{ color: "var(--text-4)" }}>Check back closer to the matchday.</p>
        </div>
      ) : (
        <FixtureTable predictions={data.predictions} />
      )}

      {/* Model footer */}
      <div className="flex items-center justify-between text-xs gap-2 flex-wrap px-1" style={{ color: "var(--text-4)" }}>
        <span>
          {[...(data.metadata.models ?? []), ...(data.metadata.sub_models ?? [])].join(" · ")}
        </span>
        {data.metadata.odds_source && (
          <span>odds: {data.metadata.odds_source.replace("_", " ")}</span>
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
