import clsx from "clsx";

interface ProgressBarProps {
  value: number; // 0–1
  color?: string;
  className?: string;
  label?: string;
  showPct?: boolean;
}

export function ProgressBar({
  value,
  color = "#22c55e",
  className,
  label,
  showPct = false,
}: ProgressBarProps) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <div className={clsx("flex items-center gap-2", className)}>
      {label && <span className="text-xs text-[var(--text-3)] w-16 flex-shrink-0">{label}</span>}
      <div className="flex-1 h-2 rounded-none overflow-hidden bg-white/[0.07]">
        <div
          className="h-full rounded-none transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      {showPct && (
        <span className="text-xs font-mono text-[var(--text-3)] w-8 text-right flex-shrink-0">
          {pct}%
        </span>
      )}
    </div>
  );
}

/** 3-segment probability bar (home / draw / away) */
interface ProbBarProps {
  home: number;
  draw: number;
  away: number;
}

export function ProbabilityBar({ home, draw, away }: ProbBarProps) {
  const hp = Math.round(home * 100);
  const dp = Math.round(draw * 100);
  const ap = Math.round(away * 100);
  return (
    <div className="space-y-1">
      <div className="flex h-2 rounded-none overflow-hidden gap-px bg-white/[0.04]">
        <div
          className="transition-all duration-500"
          style={{ width: `${hp}%`, background: "#22c55e" }}
          title={`Home ${hp}%`}
        />
        <div
          className="transition-all duration-500"
          style={{ width: `${dp}%`, background: "#64748b" }}
          title={`Draw ${dp}%`}
        />
        <div
          className="transition-all duration-500"
          style={{ width: `${ap}%`, background: "#38bdf8" }}
          title={`Away ${ap}%`}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-[var(--text-3)]">
        <span className="text-green-400">{hp}%</span>
        <span>{dp}%</span>
        <span className="text-sky-400">{ap}%</span>
      </div>
    </div>
  );
}
