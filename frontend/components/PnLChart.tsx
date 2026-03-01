"use client";

import { useState, useEffect } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { useTheme } from "next-themes";
import { useChartTheme } from "@/lib/hooks";

interface PnLChartProps {
  data: Array<{ gameweek: number; bankroll: number; peak: number }>;
  initialBankroll: number;
}

export default function PnLChart({ data, initialBankroll }: PnLChartProps) {
  const chart = useChartTheme();
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = !mounted || resolvedTheme === "dark";
  const accentColor = isDark ? "#22c55e" : "#15803d";

  return (
    <div className="space-y-2">
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 10 }}>
          <defs>
            <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accentColor} stopOpacity={0.3} />
              <stop offset="100%" stopColor={accentColor} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="peakGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={chart.tick} stopOpacity={0.1} />
              <stop offset="100%" stopColor={chart.tick} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="gameweek"
            axisLine={false}
            tickLine={false}
            tick={{ fill: chart.tick, fontSize: 11, fontFamily: "var(--font-mono)" }}
            label={{
              value: "Gameweek",
              position: "insideBottomRight",
              offset: -5,
              style: { fill: chart.tick, fontSize: 10 },
            }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: chart.tick, fontSize: 10, fontFamily: "var(--font-mono)" }}
            tickFormatter={(v: number) => `£${v}`}
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
            formatter={(value: number, name: string) => [
              `£${value.toFixed(2)}`,
              name === "bankroll" ? "Bankroll" : "Peak",
            ]}
          />
          <ReferenceLine
            y={initialBankroll}
            stroke={chart.tick}
            strokeDasharray="4 4"
            label={{
              value: "Start",
              position: "right",
              style: { fill: chart.tick, fontSize: 10 },
            }}
          />
          <Area
            type="monotone"
            dataKey="peak"
            stroke={chart.tick}
            strokeWidth={1}
            fillOpacity={1}
            fill="url(#peakGrad)"
            strokeDasharray="3 3"
          />
          <Area
            type="monotone"
            dataKey="bankroll"
            stroke={accentColor}
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#pnlGrad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
