"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BarChart3,
  CalendarRange,
  Stethoscope,
  Users,
  History,
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
  { href: "/players", label: "Projections", icon: Users },
  { href: "/phases", label: "Phases", icon: CalendarRange },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/evidence", label: "Evidence", icon: Stethoscope },
  // Last on purpose: the bar runs in the order of the week, and what the last
  // gameweek cost is read after the team is picked, not before.
  { href: "/review", label: "Review", icon: History },
];

/**
 * A top bar, not a sidebar.
 *
 * ## Why the side went away
 *
 * The sidebar spent 264px of every viewport to carry three links and a wordmark,
 * on screens whose whole job is a wide table: the projection grid is players
 * across eight gameweeks, and the phase matrix is twenty clubs across eight. Both
 * were scrolling horizontally to make room for navigation that fits in a strip.
 * The references this redesign was benchmarked against are all top-bar for the
 * same reason — this is 264px returned to the data, not a change of taste.
 *
 * ## No clock here
 *
 * The deadline renders exactly once, in `components/DeadlineClock.tsx` on `/`,
 * and `app/page.test.tsx` asserts that count. Two clocks is not hypothetical:
 * a countdown recomputed on every tick once sat near a duration stamped by the
 * phase resolver, and hours later the screen showed a frozen "71.0h" beside a
 * live "2d 23h". What this bar carries is the gameweek NUMBER — a label, not a
 * second measurement of the same instant.
 *
 * ## One artifact, the one already loaded
 *
 * The gameweek comes off `useHeuristics`, which this bar fetches for the team
 * name regardless. Reading it from `agent_status.json` instead would add a
 * request to every page load of every route to render four characters — which is
 * exactly what the `latest.json` fetch removed from here used to do for a badge
 * that was rendered nowhere.
 *
 * ## No theme toggle either
 *
 * `globals.css` now defines the same floodlit values under `:root` and `.dark`,
 * because the surface stopped encoding a reading mode. A control that changes
 * nothing is worse than no control, so it is gone rather than left as furniture.
 */
export default function Navigation() {
  const pathname = usePathname();
  const { artifact: liveArtifact } = useHeuristics();
  const live = proven(liveArtifact);
  const gameweek = live?.event?.id ?? null;

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[80] primary-action"
      >
        Skip to content
      </a>

      <header className="masthead">
        <div className="masthead-left">
          <Link href="/" className="masthead-mark">
            Suca
          </Link>

          <nav className="masthead-nav" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active ? "active" : ""}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={15} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="masthead-right">
          {gameweek != null ? (
            <span className="masthead-gw">GW{gameweek}</span>
          ) : null}

          <div className="masthead-team">
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
                <strong>{live.entry.teamName ?? "My FPL team"}</strong>
                <span>{live.entry.id}</span>
              </a>
            ) : (
              <span className="masthead-team-plain">
                <strong>{live?.entry.teamName ?? "My FPL team"}</strong>
                <span>id unavailable</span>
              </span>
            )}
          </div>
        </div>
      </header>
    </>
  );
}
