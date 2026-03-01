/**
 * Centralized theme module — single source of truth for all repeated
 * UI constants across the PL Prediction Engine frontend.
 */

// ─── Confidence Badges ──────────────────────────────────────────────────────

export const CONF_BADGES: Record<string, { label: string; cls: string }> = {
  high: { label: "HIGH", cls: "badge-green" },
  medium: { label: "MED", cls: "badge-amber" },
  low: {
    label: "LOW",
    cls: "text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider",
  },
};

// ─── Position Colors ────────────────────────────────────────────────────────

export const POS_COLORS: Record<string, string> = {
  GKP: "text-purple-400",
  DEF: "text-emerald-400",
  MID: "text-sky-400",
  FWD: "text-red-400",
};

export const POS_BG: Record<string, string> = {
  GKP: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  DEF: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  MID: "bg-sky-500/15 text-sky-400 border-sky-500/25",
  FWD: "bg-red-500/15 text-red-400 border-red-500/25",
};

// ─── Market Badge Colors ────────────────────────────────────────────────────

export function marketBadgeColor(category: string): string {
  switch (category) {
    case "Corners":
      return "text-violet-400";
    case "Cards":
      return "text-amber-400";
    case "Goalscorer":
      return "text-emerald-400";
    case "Player":
      return "text-sky-400";
    case "BTTS":
      return "text-orange-400";
    default:
      return "text-emerald-400";
  }
}

// ─── Market Icon Aria Labels ────────────────────────────────────────────────

export const MARKET_ICON_LABELS: Record<string, string> = {
  "⚽": "Football (goals market)",
  "⚑": "Corner flag (corners market)",
  "□": "Card (bookings market)",
  "👤": "Player (player market)",
};

// ─── Sort Arrow Helper ──────────────────────────────────────────────────────

export function sortArrow(
  currentKey: string,
  activeKey: string,
  dir: "asc" | "desc"
): string {
  return currentKey === activeKey ? (dir === "desc" ? " ↓" : " ↑") : "";
}

// ─── Edge Prefix for Colorblind Safety ──────────────────────────────────────

export function edgePrefix(edge: number): string {
  return edge >= 0 ? "✓ " : "✗ ";
}

// ─── Stale Data Threshold ───────────────────────────────────────────────────

export const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
export const VERY_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
