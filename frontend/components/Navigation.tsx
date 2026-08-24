"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  ChevronRight,
  LayoutDashboard,
  Menu,
  Moon,
  Sparkles,
  Stethoscope,
  Sun,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { proven } from "@/lib/data/artifact";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Three destinations, flat.
 *
 * ## What this replaced
 *
 * Four groups over twelve entries, of which five answered the same question —
 * who do I captain this week — and four landed on the same page through redirect
 * stubs. Grouping twelve entries pushed the FPL screens below the fold and the
 * variety it promised did not exist. The routes those entries pointed at are gone;
 * `test/nav-coverage.test.tsx` is now an allow-list over `app/`, so a fourteenth
 * entry cannot come back without a red build.
 *
 * `/capture` is deliberately absent: it is reached from `/`, where the position it
 * captures is read. `/offline` is not a destination — the service worker serves it
 * when a fetch fails.
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "The call", icon: LayoutDashboard },
  { href: "/players", label: "Players", icon: Users },
  { href: "/evidence", label: "Evidence", icon: Stethoscope },
];

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
  // One artifact, and only for the manager card. The `latest.json` fetch that used
  // to sit beside this one counted value bets for a badge that was rendered
  // nowhere, on every page load of every route.
  const { artifact: liveArtifact } = useHeuristics();
  const live = proven(liveArtifact);

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
          {NAV_ITEMS.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;
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
              </Link>
            );
          })}
        </nav>

        <div className="portal-sidebar-footer">
          {/* No deadline clock here and no artifact-age readout.
              The clock this sidebar used to carry was called "the second" because
              Margin had the first; the route cut deleted `/margin`, so for a week
              the app had none at all. It is now `components/DeadlineClock.tsx`,
              mounted once in the header of `/` — beside the decision it constrains,
              not in the chrome of every page. Do not add a second one here: two
              clocks over one deadline can disagree on a Friday, and
              `app/page.test.tsx` asserts the count.
              The age readout went because the age of `latest.json` said nothing
              about whether the captured position or the live FPL sync was current,
              which is what the words next to it claimed. What is left is the one
              control that belongs in chrome. */}
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
