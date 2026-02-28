/**
 * Number formatting utilities for the PL Prediction Engine.
 */

/** Format a probability as a percentage string (e.g. 0.523 → "52.3%") */
export function pct(value: number, decimals: number = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Format decimal odds (e.g. 2.15 → "2.15") */
export function odds(value: number): string {
  return value.toFixed(2);
}

/** Format expected goals / xG (e.g. 1.723 → "1.72") */
export function xg(value: number): string {
  return value.toFixed(2);
}

/** Format a date string to "Sat 1 Mar" style */
export function shortDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Format a date string to "15:00" style */
export function kickoffTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Format a feature name for display (snake_case → Title Case) */
export function featureName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Confidence color class based on percentage */
export function confidenceColor(pct: number): string {
  if (pct >= 55) return "text-emerald-400";
  if (pct >= 45) return "text-amber-400";
  return "text-red-400";
}

/** Edge color for value bets */
export function edgeColor(edge: number): string {
  if (edge >= 0.10) return "text-emerald-400";
  if (edge >= 0.05) return "text-amber-400";
  return "text-slate-400";
}

/** Get result indicator emoji/label */
export function predictionLabel(pred: string): string {
  switch (pred) {
    case "home": return "H";
    case "draw": return "D";
    case "away": return "A";
    default: return pred.toUpperCase();
  }
}

/** Probability → implied odds */
export function impliedOdds(prob: number): string {
  if (prob <= 0) return "∞";
  return (1 / prob).toFixed(2);
}

/** Time since last update */
export function timeAgo(dateStr: string): string {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHrs > 0) return `${diffHrs}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return "just now";
}
