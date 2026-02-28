"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

interface PnLChartProps {
  data: Array<{ gameweek: number; bankroll: number; peak: number }>;
  initialBankroll: number;
}

export default function PnLChart({ data, initialBankroll }: PnLChartProps) {
  return (
    <div className="space-y-2">
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 10 }}>
          <defs>
            <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2aad1f" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#2aad1f" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="peakGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#64748b" stopOpacity={0.1} />
              <stop offset="100%" stopColor="#64748b" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="gameweek"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#64748b", fontSize: 11, fontFamily: "var(--font-mono)" }}
            label={{
              value: "Gameweek",
              position: "insideBottomRight",
              offset: -5,
              style: { fill: "#475569", fontSize: 10 },
            }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#475569", fontSize: 10, fontFamily: "var(--font-mono)" }}
            tickFormatter={(v: number) => `£${v}`}
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
              `£${value.toFixed(2)}`,
              name === "bankroll" ? "Bankroll" : "Peak",
            ]}
          />
          <ReferenceLine
            y={initialBankroll}
            stroke="#475569"
            strokeDasharray="4 4"
            label={{
              value: "Start",
              position: "right",
              style: { fill: "#64748b", fontSize: 10 },
            }}
          />
          <Area
            type="monotone"
            dataKey="peak"
            stroke="#475569"
            strokeWidth={1}
            fillOpacity={1}
            fill="url(#peakGrad)"
            strokeDasharray="3 3"
          />
          <Area
            type="monotone"
            dataKey="bankroll"
            stroke="#2aad1f"
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#pnlGrad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
