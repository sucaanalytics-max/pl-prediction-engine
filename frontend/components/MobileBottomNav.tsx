"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, CalendarRange, Crosshair, Ellipsis, Users } from "lucide-react";

/**
 * Five tabs, one row.
 *
 * Call, Players, Fixtures, Stats, More — the design's order. The masthead on a
 * wide screen still lists the six working destinations flat; here `Evidence` and
 * `Review` (and `/capture`, which no nav ever listed) sit behind More, so a phone
 * gets 52px targets instead of two cramped rows. `test/nav-coverage.test.tsx`
 * holds this list to the allow-list and checks that every route the masthead
 * reaches is either a tab here or one of `MORE_ROUTES`.
 */
const ITEMS = [
  { href: "/", label: "Call", icon: Crosshair },
  { href: "/players", label: "Players", icon: Users },
  { href: "/phases", label: "Fixtures", icon: CalendarRange },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/more", label: "More", icon: Ellipsis },
];

/** Routes that have no tab of their own and light up More. */
export const MORE_ROUTES = ["/more", "/capture", "/evidence", "/review"];

function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/more") {
    return MORE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="mobile-bottom-nav" aria-label="Primary">
      {ITEMS.map((item) => {
        const active = isActive(item.href, pathname);
        const Icon = item.icon;
        return (
          <Link
            href={item.href}
            key={item.href}
            className={active ? "active" : ""}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
