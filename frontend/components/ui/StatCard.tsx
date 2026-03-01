import { HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}

export function StatCard({ label, value, sub, accent = false, className, ...props }: StatCardProps) {
  return (
    <div
      className={clsx("card p-4", className)}
      {...props}
    >
      <p className="stat-label mb-2">{label}</p>
      <p
        className="font-bold text-3xl tracking-tight leading-none"
        style={{ fontFamily: "var(--font-jakarta)", color: accent ? "var(--accent-text)" : "var(--text-1)" }}
      >
        {value}
      </p>
      {sub && <p className="text-xs mt-1" style={{ color: "var(--text-3)" }}>{sub}</p>}
    </div>
  );
}
