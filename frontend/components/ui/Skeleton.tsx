import { CSSProperties } from "react";
import clsx from "clsx";

interface SkeletonProps {
  className?: string;
  rows?: number;
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      className={clsx("animate-pulse rounded bg-white/[0.06]", className)}
      style={style}
    />
  );
}

export function SkeletonCard({ rows = 3 }: SkeletonProps) {
  return (
    <div className="card p-4 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: `${70 + (i % 3) * 10}%` }} />
      ))}
    </div>
  );
}

export function PageSkeleton({ rows = 4 }: SkeletonProps) {
  return (
    <div role="status" aria-label="Loading" className="space-y-4 animate-slide-up">
      <Skeleton className="h-8 w-48" />
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonCard key={i} rows={3} />
      ))}
    </div>
  );
}
