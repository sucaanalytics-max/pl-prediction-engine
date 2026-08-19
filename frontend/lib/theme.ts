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

// ─── Edge Prefix for Colorblind Safety ──────────────────────────────────────

export function edgePrefix(edge: number): string {
  return edge >= 0 ? "✓ " : "✗ ";
}
