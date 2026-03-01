"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { pct } from "@/lib/formats";

interface DistributionChartProps {
  data: number[];
  label: string;
  color?: string;
  startLabel?: number;
}

export default function DistributionChart({
  data,
  label,
  color = "#2aad1f",
  startLabel = 0,
}: DistributionChartProps) {
  const chartData = data.map((prob, i) => ({
    name: `${startLabel + i}`,
    probability: prob,
    pctStr: pct(prob),
  }));

  const maxProb = Math.max(...data);

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <XAxis
            dataKey="name"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#64748b", fontSize: 11, fontFamily: "var(--font-mono)" }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#475569", fontSize: 10 }}
            tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
          />
          <Tooltip
            contentStyle={{
              background: "rgba(10, 15, 28, 0.92)",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: "1px solid rgba(255, 255, 255, 0.10)",
              borderRadius: "8px",
              fontSize: "12px",
              color: "#e2e8f0",
              fontFamily: "var(--font-mono)",
              boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
            }}
            formatter={(value: number) => [pct(value), "Probability"]}
            labelFormatter={(l) => `${label}: ${l}`}
          />
          <Bar dataKey="probability" radius={[3, 3, 0, 0]} maxBarSize={28}>
            {chartData.map((entry, i) => (
              <Cell
                key={i}
                fill={color}
                fillOpacity={0.3 + 0.7 * (entry.probability / maxProb)}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
