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
        className={clsx(
          "font-bold text-2xl tracking-tight leading-none",
          accent ? "text-green-400" : "text-white"
        )}
        style={{ fontFamily: "var(--font-jakarta)" }}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}
