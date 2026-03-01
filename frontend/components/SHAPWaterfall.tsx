"use client";

import { featureName } from "@/lib/formats";
import type { ShapFeature } from "@/lib/predictions";

interface SHAPWaterfallProps {
  features: ShapFeature[];
  maxFeatures?: number;
}

export default function SHAPWaterfall({ features, maxFeatures = 8 }: SHAPWaterfallProps) {
  const topFeatures = features.slice(0, maxFeatures);
  const maxAbs = Math.max(...topFeatures.map((f) => Math.abs(f.shap_value)), 0.01);

  return (
    <div className="space-y-3">
      <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-3)" }}>
        Key Prediction Drivers (SHAP)
      </p>
      <div className="space-y-2">
        {topFeatures.map((feat, i) => {
          const barWidth = Math.abs(feat.shap_value) / maxAbs;
          const isPositive = feat.shap_value > 0;

          return (
            <div key={feat.feature} className="flex items-center gap-3 group">
              {/* Feature name */}
              <div className="w-36 flex-shrink-0 text-right">
                <span
                  className="text-xs transition-colors truncate block"
                  style={{ color: "var(--text-3)" }}
                >
                  {featureName(feat.feature)}
                </span>
              </div>

              {/* Bar */}
              <div className="flex-1 flex items-center h-6">
                <div className="relative w-full flex items-center">
                  {/* Center line */}
                  <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ background: "var(--border-strong)" }} />

                  {/* Bar */}
                  <div
                    className={`absolute h-5 rounded-sm transition-all duration-500 ${isPositive ? "shap-bar-pos" : "shap-bar-neg"}`}
                    style={{
                      width: `${barWidth * 48}%`,
                      left: isPositive ? "50%" : `${50 - barWidth * 48}%`,
                      animationDelay: `${i * 60}ms`,
                    }}
                  />
                </div>
              </div>

              {/* Value */}
              <div className="w-16 flex-shrink-0 text-right">
                <span
                  className="text-xs font-mono font-medium"
                  style={{ color: isPositive ? "var(--success)" : "var(--error)" }}
                >
                  {isPositive ? "+" : ""}
                  {feat.shap_value.toFixed(2)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] pt-1" style={{ color: "var(--text-4)" }}>
        Positive values push prediction toward more goals, negative toward fewer
      </p>
    </div>
  );
}
