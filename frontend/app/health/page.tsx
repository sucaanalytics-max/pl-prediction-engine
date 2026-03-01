"use client";

import {
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
  ScatterChart, Scatter, CartesianGrid, BarChart, Bar,
} from "recharts";
import { usePredictions } from "@/lib/PredictionsContext";
import { useChartTheme } from "@/lib/hooks";
import { pct, timeAgo } from "@/lib/formats";
import { ErrorBoundary, ErrorMessage } from "@/components/ErrorBoundary";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";

const STALE_HEALTH_MS = 24 * 60 * 60 * 1000; // 24 hours

function HealthContent() {
  const { health, predictions: data, loading, error, refresh } = usePredictions();
  const chart = useChartTheme();

  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !health) return <PageSkeleton rows={5} />;

  const isHealthy = health.status === "healthy";
  const isStaleHealth = Date.now() - new Date(health.last_updated).getTime() > STALE_HEALTH_MS;
  const metrics = health.model_metrics ?? {};

  // Calibration chart data
  const calData = (health.calibration?.bins ?? []).map((b) => ({
    predicted: b.predicted_mean,
    actual: b.actual_mean,
    count: b.count,
  }));

  // Stacking weights from predictions metadata
  const stackingWeights = data?.metadata.stacking_weights;
  const stackingData = stackingWeights
    ? Object.entries(stackingWeights)
        .sort(([, a], [, b]) => b - a)
        .map(([name, weight]) => ({ name: name.replace(/_/g, " "), weight }))
    : null;

  // Ensemble method
  const ensembleMethod = data?.metadata.ensemble_method;

  // Per-market metrics (extract from model_metrics if available)
  const marketMetrics = [
    { market: "1X2 Home", key: "brier_1x2_home", target: 0.22 },
    { market: "1X2 Draw", key: "brier_1x2_draw", target: 0.23 },
    { market: "1X2 Away", key: "brier_1x2_away", target: 0.22 },
    { market: "Over/Under", key: "brier_ou25", target: 0.24 },
    { market: "BTTS", key: "brier_btts", target: 0.24 },
    { market: "Corners", key: "brier_corners", target: 0.24 },
    { market: "Cards", key: "brier_cards", target: 0.24 },
  ].filter((m) => metrics[m.key] !== undefined);

  const tooltipStyle = {
    background: chart.tooltip.background,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: chart.tooltip.border,
    borderRadius: "8px",
    fontSize: "12px",
    color: chart.tooltip.color,
    fontFamily: "var(--font-mono)",
    boxShadow: chart.tooltip.shadow,
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
          >
            Model Health
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Calibration, accuracy, pipeline status · Updated {timeAgo(health.last_updated)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {ensembleMethod && (
            <span className="badge-green text-[9px]">{ensembleMethod.toUpperCase()}</span>
          )}
          {isStaleHealth && (
            <span className="stale-warning">DATA &gt; 24H OLD</span>
          )}
          <span className={isHealthy ? "badge-green" : "text-red-400 bg-red-500/10 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"}>
            {health.status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Core metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard label="Brier (H)" value={metrics.brier_1x2_home?.toFixed(3) ?? "—"} target="< 0.220" good={(metrics.brier_1x2_home ?? 1) < 0.22} />
        <MetricCard label="Brier (D)" value={metrics.brier_1x2_draw?.toFixed(3) ?? "—"} target="< 0.230" good={(metrics.brier_1x2_draw ?? 1) < 0.23} />
        <MetricCard label="Brier (A)" value={metrics.brier_1x2_away?.toFixed(3) ?? "—"} target="< 0.220" good={(metrics.brier_1x2_away ?? 1) < 0.22} />
        <MetricCard label="RPS" value={metrics.rps_mean?.toFixed(3) ?? "—"} target="< 0.200" good={(metrics.rps_mean ?? 1) < 0.2} />
        <MetricCard label="ECE" value={metrics.ece?.toFixed(3) ?? "—"} target="< 0.050" good={(metrics.ece ?? 1) < 0.05} />
        <MetricCard label="Log Loss" value={metrics.log_loss_home?.toFixed(3) ?? "—"} target="< 0.650" good={(metrics.log_loss_home ?? 1) < 0.65} />
      </div>

      <div className="glow-line" />

      {/* Stacking Weights + Per-Market side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Stacking Weights */}
        {stackingData && stackingData.length > 0 ? (
          <div className="card p-6">
            <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>
              Ensemble Weights (Meta-Learner)
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stackingData} layout="vertical" margin={{ left: 80, right: 20, top: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} horizontal={false} />
                <XAxis type="number" domain={[0, 1]} tick={{ fill: chart.tick, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: chart.tick, fontSize: 11 }} axisLine={false} tickLine={false} width={75} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [pct(v), "Weight"]} />
                <Bar dataKey="weight" fill="var(--accent)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-[10px] mt-2" style={{ color: "var(--text-4)" }}>
              Learned via logistic regression on out-of-fold predictions.
            </p>
          </div>
        ) : (
          <div className="card p-6">
            <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>
              Ensemble Weights
            </h3>
            <div className="text-sm" style={{ color: "var(--text-3)" }}>
              Using static ensemble weights — insufficient data for stacking meta-learner.
            </div>
            <p className="text-[10px] mt-3" style={{ color: "var(--text-4)" }}>
              Stacking weights will be learned automatically once enough out-of-fold predictions are available.
            </p>
          </div>
        )}

        {/* Per-Market Brier */}
        {marketMetrics.length > 0 && (
          <div className="card p-6">
            <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>Per-Market Calibration</h3>
            <div className="space-y-3">
              {marketMetrics.map(({ market, key, target }) => {
                const val = metrics[key] ?? 0;
                const good = val < target;
                const pctWidth = Math.min((val / 0.3) * 100, 100);
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span style={{ color: "var(--text-3)" }}>{market}</span>
                      <span className={`font-mono ${good ? "text-emerald-400" : "text-amber-400"}`}>
                        {val.toFixed(3)}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface2)" }}>
                      <div
                        className={`h-full rounded-full ${good ? "bg-emerald-500" : "bg-amber-500"}`}
                        style={{ width: `${pctWidth}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] mt-3" style={{ color: "var(--text-4)" }}>Lower Brier score = better calibration.</p>
          </div>
        )}
      </div>

      {/* Calibration Plot */}
      {calData.length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--text-1)" }}>
            Calibration Curve
          </h3>
          <p className="text-xs mb-4" style={{ color: "var(--text-3)" }}>
            Points close to the diagonal line indicate well-calibrated predictions.
            Dot size = sample count.
          </p>
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
              <XAxis
                dataKey="predicted" type="number" domain={[0, 1]}
                axisLine={false} tickLine={false}
                tick={{ fill: chart.tick, fontSize: 11, fontFamily: "var(--font-mono)" }}
                label={{ value: "Predicted Probability", position: "insideBottom", offset: -10, style: { fill: chart.tick, fontSize: 11 } }}
              />
              <YAxis
                dataKey="actual" type="number" domain={[0, 1]}
                axisLine={false} tickLine={false}
                tick={{ fill: chart.tick, fontSize: 11, fontFamily: "var(--font-mono)" }}
                label={{ value: "Actual Frequency", angle: -90, position: "insideLeft", offset: 10, style: { fill: chart.tick, fontSize: 11 } }}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: number, name: string) => [value.toFixed(3), name === "actual" ? "Actual" : "Predicted"]}
              />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={chart.tick} strokeDasharray="5 5" />
              <Scatter
                data={calData}
                fill="var(--accent)"
                fillOpacity={0.8}
                label={({ x, y, index }: any) => (
                  <text x={x} y={y - 10} textAnchor="middle" fill={chart.tick} fontSize={9} fontFamily="var(--font-mono)">
                    n={calData[index]?.count}
                  </text>
                )}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Pipeline info */}
      <div className="card p-6 space-y-4">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>Pipeline Status</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="glass-inset p-3">
            <div className="stat-label">Last Run</div>
            <div className="text-sm font-mono mt-1" style={{ color: "var(--text-1)" }}>{new Date(health.last_updated).toLocaleString("en-GB")}</div>
          </div>
          <div className="glass-inset p-3">
            <div className="stat-label">Gameweek</div>
            <div className="text-sm font-mono mt-1" style={{ color: "var(--text-1)" }}>GW {health.gameweek}</div>
          </div>
          <div className="glass-inset p-3">
            <div className="stat-label">Predictions</div>
            <div className="text-sm font-mono mt-1" style={{ color: "var(--text-1)" }}>{health.n_predictions} matches</div>
          </div>
          {data && (
            <>
              <div className="glass-inset p-3">
                <div className="stat-label">Models</div>
                <div className="text-sm font-mono mt-1" style={{ color: "var(--text-1)" }}>
                  {(data.metadata.models?.length ?? 0) + (data.metadata.sub_models?.length ?? 0)}
                </div>
              </div>
              <div className="glass-inset p-3">
                <div className="stat-label">Simulations</div>
                <div className="text-sm font-mono mt-1" style={{ color: "var(--text-1)" }}>{(data.metadata.n_simulations / 1000).toFixed(0)}K</div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Benchmarks */}
      <div className="card p-6 space-y-3">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>Benchmarks</h3>
        <div className="text-xs space-y-2" style={{ color: "var(--text-2)" }}>
          <div className="flex justify-between"><span>Bookmaker consensus Brier (1X2)</span><span className="font-mono" style={{ color: "var(--text-1)" }}>~0.200</span></div>
          <div className="flex justify-between"><span>Naive home-bias model Brier</span><span className="font-mono" style={{ color: "var(--text-1)" }}>~0.250</span></div>
          <div className="flex justify-between"><span>Target ECE (well-calibrated)</span><span className="font-mono" style={{ color: "var(--text-1)" }}>&lt; 0.050</span></div>
          <div className="flex justify-between"><span>Target RPS (competitive model)</span><span className="font-mono" style={{ color: "var(--text-1)" }}>&lt; 0.200</span></div>
        </div>
      </div>

      {/* Model list */}
      {data && (
        <div className="card p-4 flex items-center justify-between text-xs gap-2 flex-wrap" style={{ color: "var(--text-3)" }}>
          <span>
            Models: {[...(data.metadata.models ?? []), ...(data.metadata.sub_models ?? [])].join(" + ")}
          </span>
          <div className="flex items-center gap-2">
            {data.metadata.calibrated ? (
              <span className="badge-green">Calibrated</span>
            ) : (
              <span className="badge-amber">Uncalibrated</span>
            )}
            {data.metadata.odds_source && (
              <span style={{ color: "var(--text-4)" }}>odds: {data.metadata.odds_source.replace("_", " ")}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, target, good }: { label: string; value: string; target: string; good: boolean }) {
  return (
    <div className="card p-4">
      <div className="stat-label">{label}</div>
      <div className={`text-xl font-bold mt-1 ${good ? "text-green-400" : "text-amber-400"}`}>{value}</div>
      <div className="text-[10px] mt-1" style={{ color: "var(--text-4)" }}>Target: {target}</div>
    </div>
  );
}

export default function HealthPage() {
  return (
    <ErrorBoundary pageName="Model Health">
      <HealthContent />
    </ErrorBoundary>
  );
}
