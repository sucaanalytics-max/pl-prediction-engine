"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  Activity,
  ChevronRight,
  ArrowLeftRight,
  CalendarRange,
  Crown,
  GitCompareArrows,
  Inbox,
  LayoutDashboard,
  LineChart,
  ListOrdered,
  Newspaper,
  Menu,
  Moon,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Sun,
  Swords,
  Table2,
  Target,
  TrendingUp,
  Users,
  Wand2,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import { REGISTRY, type Latest } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { isStale as artifactIsStale, proven } from "@/lib/data/artifact";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { compactIstDeadline } from "@/lib/formats";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  valueBadge?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Every route, reachable.
 *
 * ## What this fixes
 *
 * Thirteen of the twenty-two built routes were unreachable from here. `/transfers`,
 * `/optimizer`, `/captaincy`, `/rankings`, `/planner`, `/projections`,
 * `/intelligence`, `/table`, `/matches`, `/value-bets` and `/h2h`'s siblings were all
 * deployed, tested, and linked from nowhere — so the app looked far emptier than it
 * was, and the pages carrying the most FPL value were the ones you could not get to.
 *
 * `frontend/test/nav-coverage.test.tsx` asserts that every route under `app/` is
 * either in this list or named in its allow-list with a reason. A route can no longer
 * become unreachable quietly.
 *
 * ## Labels
 *
 * Named for what a reader wants, not for the subsystem that produces it. "Player Lab"
 * and "Match Models" described our architecture; "Players" and "Fixtures" describe
 * the question being asked.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Decide",
    items: [
      { href: "/now", label: "Now", icon: LayoutDashboard },
      { href: "/decide", label: "Decide", icon: Sparkles },
      { href: "/transfers", label: "Transfers", icon: ArrowLeftRight },
      { href: "/captaincy", label: "Captain", icon: Crown },
      { href: "/optimizer", label: "Optimiser", icon: Wand2 },
      { href: "/planner", label: "Planner", icon: CalendarRange },
    ],
  },
  {
    label: "Research",
    items: [
      { href: "/players", label: "Players", icon: Users },
      { href: "/projections", label: "Projections", icon: LineChart },
      { href: "/rankings", label: "Rankings", icon: ListOrdered },
      { href: "/evidence", label: "Injury evidence", icon: Stethoscope },
      { href: "/intelligence", label: "Intelligence", icon: Newspaper },
    ],
  },
  {
    label: "Match model",
    items: [
      { href: "/matches", label: "Fixtures", icon: GitCompareArrows },
      { href: "/table", label: "Table", icon: Table2 },
      { href: "/h2h", label: "Head to head", icon: Swords },
    ],
  },
  {
    label: "Betting",
    items: [
      { href: "/value-bets", label: "Value bets", icon: TrendingUp },
      { href: "/markets", label: "Markets", icon: TrendingUp },
      { href: "/bankroll", label: "Bankroll", icon: WalletCards },
    ],
  },
  {
    label: "Agent · ops",
    items: [
      { href: "/decisions", label: "Agent decisions", icon: Sparkles },
      { href: "/inbox", label: "Agent inbox", icon: Inbox },
      { href: "/accuracy", label: "Accuracy", icon: Target },
      { href: "/health", label: "Model health", icon: Activity },
    ],
  },
];

function timeAgo(timestamp: number) {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="w-8 h-8" />;
  const dark = resolvedTheme === "dark";
  return (
    <button
      className="sidebar-icon-button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

export default function Navigation() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  // One artifact, not two contexts. The nav needs exactly two facts — how many
  // value bets there are, and whether the data is fresh — and mounting a
  // provider pair in the layout to answer them made every page in the tree pay
  // for five fetches it did not use.
  const { artifact: latest } = useArtifact<Latest>(REGISTRY.latest);
  const { artifact: liveArtifact } = useHeuristics();
  const predictions = proven(latest);
  const live = proven(liveArtifact);
  const liveFailed =
    liveArtifact.state === "absent" || liveArtifact.state === "unreadable";
  const lastUpdated = latest.provenance.producedAt
    ? Date.parse(latest.provenance.producedAt)
    : null;
  // `unreadable` and `absent` are not stale, they are worse — so the dot goes
  // amber for those too rather than reading as fresh because no age is known.
  const isStale =
    artifactIsStale(latest) ||
    latest.state === "absent" ||
    latest.state === "unreadable";
  const valueBetCount = predictions?.predictions.reduce(
    (count, prediction) => count + prediction.value_bets.length,
    0
  ) ?? 0;

  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[80] primary-action">
        Skip to content
      </a>
      <button
        className="mobile-nav-toggle lg:hidden"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={mobileOpen}
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>
      {mobileOpen && <button className="mobile-nav-overlay lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation overlay" />}

      <aside className={`portal-sidebar ${mobileOpen ? "open" : ""}`}>
        <div className="portal-brand">
          <Link href="/" onClick={() => setMobileOpen(false)}>
            <span className="brand-mark"><Sparkles size={20} /></span>
            <span><strong>Suca</strong><small>FPL Decision OS</small></span>
          </Link>
          <span className="season-pill">26/27</span>
        </div>

        <div className="manager-card">
          <div className="manager-avatar">
            {live?.entry.teamName?.slice(0, 1).toUpperCase() ?? "M"}
          </div>
          <div>
            <strong>{live?.entry.teamName ?? "My FPL team"}</strong>
            <span>{live?.entry.id !== null && live?.entry.id !== undefined ? `Manager ID ${live.entry.id}` : "Manager ID unavailable"}</span>
          </div>
          {/* Only linkable once the real entry id is known. The hardcoded
              20945 that used to sit here opened somebody else's team whenever
              the live route was unavailable. */}
          {live?.entry.id != null ? (
            <a
              href={`https://fantasy.premierleague.com/en/entry/${live.entry.id}/history`}
              target="_blank"
              rel="noreferrer"
              aria-label="Open official FPL team"
            >
              <ChevronRight size={16} />
            </a>
          ) : null}
        </div>

        <nav className="portal-nav" aria-label="Primary navigation">
          {NAV_GROUPS.map((group) => (
            <div className="portal-nav-group" key={group.label}>
              <span className="portal-nav-label">{group.label}</span>
              {group.items.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                const Icon = item.icon;
                const badge = item.valueBadge ? valueBetCount : item.badge;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={active ? "active" : ""}
                    onClick={() => setMobileOpen(false)}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon size={17} />
                    <span>{item.label}</span>
                    {badge ? <small>{badge}</small> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="portal-sidebar-footer">
          {/* The other-sports link is gone.
              CLAUDE.md rule 7 puts the F1, darts and other-sport providers out of
              scope for this repo, and a prominent sidebar card pointing at them made
              a single-purpose FPL tool read as a sports portal — on a page whose own
              content was empty. The dashboard still exists at its own URL; it just
              does not belong in this navigation. */}
          <div className="deadline-mini">
            <span><ShieldCheck size={14} /> {live?.event.id != null ? `GW${live.event.id} planning` : "Gameweek unknown"}</span>
            <strong>{compactIstDeadline(live?.event.deadlineTime ?? undefined)}</strong>
          </div>
          <div className="sidebar-status">
            <span className={isStale ? "status-dot stale" : "status-dot"} />
            <div>
              <strong>
                {liveFailed
                  ? "FPL sync needs attention"
                  : live?.squadSource === "captured"
                    ? "Live FPL · draft captured"
                    : isStale
                      ? "Pipeline needs refresh"
                      : "Live workspace ready"}
              </strong>
              <small>
                {lastUpdated
                  ? `Updated ${timeAgo(lastUpdated)}`
                  : "Connecting official FPL data"}
              </small>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </aside>
    </>
  );
}
