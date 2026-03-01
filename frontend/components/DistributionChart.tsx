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
import { useChartTheme } from "@/lib/hooks";

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
  const chart = useChartTheme();

  const chartData = data.map((prob, i) => ({
    name: `${startLabel + i}`,
    probability: prob,
    pctStr: pct(prob),
  }));

  const maxProb = Math.max(...data);

  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>{label}</p>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <XAxis
            dataKey="name"
            axisLine={false}
            tickLine={false}
            tick={{ fill: chart.tick, fontSize: 11, fontFamily: "var(--font-mono)" }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: chart.tick, fontSize: 10 }}
            tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
          />
          <Tooltip
            contentStyle={{
              background: chart.tooltip.background,
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              border: `1px solid ${chart.tooltip.border}`,
              borderRadius: "8px",
              fontSize: "12px",
              color: chart.tooltip.color,
              fontFamily: "var(--font-mono)",
              boxShadow: chart.tooltip.shadow,
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
