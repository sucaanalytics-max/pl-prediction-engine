"use client";

import {
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
  ScatterChart, Scatter, CartesianGrid, BarChart, Bar, LineChart, Line,
} from "recharts";
import { usePredictions } from "@/lib/PredictionsContext";
import { pct, timeAgo } from "@/lib/formats";
import { ErrorBoundary, PageSkeleton, ErrorMessage } from "@/components/ErrorBoundary";

const TOOLTIP_STYLE = {
  background: "rgba(10, 15, 28, 0.92)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  border: "1px solid rgba(255, 255, 255, 0.10)",
  borderRadius: "8px",
  fontSize: "12px",
  color: "#e2e8f0",
  fontFamily: "var(--font-mono)",
  boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
};

function HealthContent() {
  const { health, predictions: data, loading, error, refresh } = usePredictions();

  if (error) return <ErrorMessage message={error} onRetry={refresh} />;
  if (loading || !health) return <PageSkeleton rows={5} />;

  const isHealthy = health.status === "healthy";
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

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="font-display text-2xl font-bold text-white tracking-tight">
            Model Health
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Calibration, accuracy, pipeline status · Updated {timeAgo(health.last_updated)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {ensembleMethod && (
            <span className="badge-green text-[9px]">{ensembleMethod.toUpperCase()}</span>
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
        {stackingData && stackingData.length > 0 && (
          <div className="card p-6">
            <h3 className="text-sm font-display font-semibold text-white mb-4">
              Ensemble Weights (Meta-Learner)
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stackingData} layout="vertical" margin={{ left: 80, right: 20, top: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                <XAxis type="number" domain={[0, 1]} tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} width={75} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [pct(v), "Weight"]} />
                <Bar dataKey="weight" fill="#2aad1f" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-[10px] text-slate-600 mt-2">
              Learned via logistic regression on out-of-fold predictions.
            </p>
          </div>
        )}

        {/* Per-Market Brier */}
        {marketMetrics.length > 0 && (
          <div className="card p-6">
            <h3 className="text-sm font-display font-semibold text-white mb-4">Per-Market Calibration</h3>
            <div className="space-y-3">
              {marketMetrics.map(({ market, key, target }) => {
                const val = metrics[key] ?? 0;
                const good = val < target;
                const pctWidth = Math.min((val / 0.3) * 100, 100);
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400">{market}</span>
                      <span className={`font-mono ${good ? "text-emerald-400" : "text-amber-400"}`}>
                        {val.toFixed(3)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${good ? "bg-emerald-500" : "bg-amber-500"}`}
                        style={{ width: `${pctWidth}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-600 mt-3">Lower Brier score = better calibration.</p>
          </div>
        )}
      </div>

      {/* Calibration Plot */}
      {calData.length > 0 && (
        <div className="card p-6">
          <h3 className="text-sm font-display font-semibold text-white mb-4">
            Calibration Curve
          </h3>
          <p className="text-xs text-slate-500 mb-4">
            Points close to the diagonal line indicate well-calibrated predictions.
            Dot size = sample count.
          </p>
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="predicted" type="number" domain={[0, 1]}
                axisLine={false} tickLine={false}
                tick={{ fill: "#64748b", fontSize: 11, fontFamily: "var(--font-mono)" }}
                label={{ value: "Predicted Probability", position: "insideBottom", offset: -10, style: { fill: "#64748b", fontSize: 11 } }}
              />
              <YAxis
                dataKey="actual" type="number" domain={[0, 1]}
                axisLine={false} tickLine={false}
                tick={{ fill: "#64748b", fontSize: 11, fontFamily: "var(--font-mono)" }}
                label={{ value: "Actual Frequency", angle: -90, position: "insideLeft", offset: 10, style: { fill: "#64748b", fontSize: 11 } }}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value: number, name: string) => [value.toFixed(3), name === "actual" ? "Actual" : "Predicted"]}
              />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#475569" strokeDasharray="5 5" />
              <Scatter data={calData} fill="#2aad1f" fillOpacity={0.8} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Pipeline info */}
      <div className="card p-6 space-y-4">
        <h3 className="text-sm font-display font-semibold text-white">Pipeline Status</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="bg-slate-800/40 rounded-lg p-3">
            <div className="stat-label">Last Run</div>
            <div className="text-sm font-mono text-white mt-1">{new Date(health.last_updated).toLocaleString("en-GB")}</div>
          </div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <div className="stat-label">Gameweek</div>
            <div className="text-sm font-mono text-white mt-1">GW {health.gameweek}</div>
          </div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <div className="stat-label">Predictions</div>
            <div className="text-sm font-mono text-white mt-1">{health.n_predictions} matches</div>
          </div>
          {data && (
            <>
              <div className="bg-slate-800/40 rounded-lg p-3">
                <div className="stat-label">Models</div>
                <div className="text-sm font-mono text-white mt-1">
                  {(data.metadata.models?.length ?? 0) + (data.metadata.sub_models?.length ?? 0)}
                </div>
              </div>
              <div className="bg-slate-800/40 rounded-lg p-3">
                <div className="stat-label">Simulations</div>
                <div className="text-sm font-mono text-white mt-1">{(data.metadata.n_simulations / 1000).toFixed(0)}K</div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Benchmarks */}
      <div className="card p-6 space-y-3">
        <h3 className="text-sm font-display font-semibold text-white">Benchmarks</h3>
        <div className="text-xs text-slate-400 space-y-2">
          <div className="flex justify-between"><span>Bookmaker consensus Brier (1X2)</span><span className="font-mono text-slate-300">~0.200</span></div>
          <div className="flex justify-between"><span>Naive home-bias model Brier</span><span className="font-mono text-slate-300">~0.250</span></div>
          <div className="flex justify-between"><span>Target ECE (well-calibrated)</span><span className="font-mono text-slate-300">&lt; 0.050</span></div>
          <div className="flex justify-between"><span>Target RPS (competitive model)</span><span className="font-mono text-slate-300">&lt; 0.200</span></div>
        </div>
      </div>

      {/* Model list */}
      {data && (
        <div className="card p-4 flex items-center justify-between text-xs text-slate-500 gap-2 flex-wrap">
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
              <span className="text-slate-600">odds: {data.metadata.odds_source.replace("_", " ")}</span>
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
      <div className={`text-xl font-display font-bold mt-1 ${good ? "text-emerald-400" : "text-amber-400"}`}>{value}</div>
      <div className="text-[10px] text-slate-600 mt-1">Target: {target}</div>
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
