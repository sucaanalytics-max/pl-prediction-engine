"use client";

import { useEffect, useState } from "react";
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ScatterChart,
  Scatter,
  CartesianGrid,
} from "recharts";
import { loadHealth, type HealthData } from "@/lib/predictions";
import { timeAgo } from "@/lib/formats";

export default function HealthPage() {
  const [health, setHealth] = useState<HealthData | null>(null);

  useEffect(() => {
    loadHealth().then(setHealth);
  }, []);

  if (!health) {
    return (
      <div className="card p-8 animate-pulse">
        <div className="h-6 bg-slate-800 rounded w-1/3 mb-4" />
        <div className="h-64 bg-slate-800 rounded" />
      </div>
    );
  }

  const isHealthy = health.status === "healthy";
  const metrics = health.model_metrics ?? {};

  // Calibration chart data — add perfect calibration line
  const calData = (health.calibration?.bins ?? []).map((b) => ({
    predicted: b.predicted_mean,
    actual: b.actual_mean,
    count: b.count,
  }));

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-white tracking-tight">
            Model Health
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Calibration, accuracy metrics, pipeline status · Updated {timeAgo(health.last_updated)}
          </p>
        </div>
        <span className={isHealthy ? "badge-green" : "badge-red"}>
          {health.status.toUpperCase()}
        </span>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard
          label="Brier (H)"
          value={metrics.brier_1x2_home?.toFixed(3) ?? "—"}
          target="< 0.220"
          good={(metrics.brier_1x2_home ?? 1) < 0.22}
        />
        <MetricCard
          label="Brier (D)"
          value={metrics.brier_1x2_draw?.toFixed(3) ?? "—"}
          target="< 0.230"
          good={(metrics.brier_1x2_draw ?? 1) < 0.23}
        />
        <MetricCard
          label="Brier (A)"
          value={metrics.brier_1x2_away?.toFixed(3) ?? "—"}
          target="< 0.220"
          good={(metrics.brier_1x2_away ?? 1) < 0.22}
        />
        <MetricCard
          label="RPS"
          value={metrics.rps_mean?.toFixed(3) ?? "—"}
          target="< 0.200"
          good={(metrics.rps_mean ?? 1) < 0.2}
        />
        <MetricCard
          label="ECE"
          value={metrics.ece?.toFixed(3) ?? "—"}
          target="< 0.050"
          good={(metrics.ece ?? 1) < 0.05}
        />
        <MetricCard
          label="Log Loss"
          value={metrics.log_loss_home?.toFixed(3) ?? "—"}
          target="< 0.650"
          good={(metrics.log_loss_home ?? 1) < 0.65}
        />
      </div>

      <div className="glow-line" />

      {/* Calibration Plot */}
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
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#1e293b"
            />
            <XAxis
              dataKey="predicted"
              type="number"
              domain={[0, 1]}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#64748b", fontSize: 11, fontFamily: "var(--font-mono)" }}
              label={{
                value: "Predicted Probability",
                position: "insideBottom",
                offset: -10,
                style: { fill: "#64748b", fontSize: 11 },
              }}
            />
            <YAxis
              dataKey="actual"
              type="number"
              domain={[0, 1]}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#64748b", fontSize: 11, fontFamily: "var(--font-mono)" }}
              label={{
                value: "Actual Frequency",
                angle: -90,
                position: "insideLeft",
                offset: 10,
                style: { fill: "#64748b", fontSize: 11 },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1e293b",
                border: "1px solid #334155",
                borderRadius: "8px",
                fontSize: "12px",
                color: "#e2e8f0",
                fontFamily: "var(--font-mono)",
              }}
              formatter={(value: number, name: string) => [
                value.toFixed(3),
                name === "actual" ? "Actual" : "Predicted",
              ]}
            />
            {/* Perfect calibration line */}
            <ReferenceLine
              segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]}
              stroke="#475569"
              strokeDasharray="5 5"
            />
            <Scatter
              data={calData}
              fill="#2aad1f"
              fillOpacity={0.8}
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Pipeline info */}
      <div className="card p-6 space-y-4">
        <h3 className="text-sm font-display font-semibold text-white">Pipeline Status</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-slate-800/40 rounded-lg p-3">
            <div className="stat-label">Last Run</div>
            <div className="text-sm font-mono text-white mt-1">
              {new Date(health.last_updated).toLocaleString("en-GB")}
            </div>
          </div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <div className="stat-label">Gameweek</div>
            <div className="text-sm font-mono text-white mt-1">
              GW {health.gameweek}
            </div>
          </div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <div className="stat-label">Predictions</div>
            <div className="text-sm font-mono text-white mt-1">
              {health.n_predictions} matches
            </div>
          </div>
        </div>
      </div>

      {/* Benchmarks */}
      <div className="card p-6 space-y-3">
        <h3 className="text-sm font-display font-semibold text-white">Benchmarks</h3>
        <div className="text-xs text-slate-400 space-y-2">
          <div className="flex justify-between">
            <span>Bookmaker consensus Brier (1X2)</span>
            <span className="font-mono text-slate-300">~0.200</span>
          </div>
          <div className="flex justify-between">
            <span>Naive home-bias model Brier</span>
            <span className="font-mono text-slate-300">~0.250</span>
          </div>
          <div className="flex justify-between">
            <span>Target ECE (well-calibrated)</span>
            <span className="font-mono text-slate-300">&lt; 0.050</span>
          </div>
          <div className="flex justify-between">
            <span>Target RPS (competitive model)</span>
            <span className="font-mono text-slate-300">&lt; 0.200</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  target,
  good,
}: {
  label: string;
  value: string;
  target: string;
  good: boolean;
}) {
  return (
    <div className="card p-4">
      <div className="stat-label">{label}</div>
      <div className={`text-xl font-display font-bold mt-1 ${good ? "text-emerald-400" : "text-amber-400"}`}>
        {value}
      </div>
      <div className="text-[10px] text-slate-600 mt-1">Target: {target}</div>
    </div>
  );
}
