"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, BarChart3, CalendarRange, Stethoscope, Users, History,
} from "lucide-react";

/**
 * The same destinations the masthead has, in the same order.
 *
 * Two of the five entries here — `/optimizer` and `/captaincy` — were redirect
 * stubs onto `/decide`, and `/projections` was a stub onto `/players`. On a phone
 * that made five tabs out of three screens. Those routes are gone, so this lists
 * the destinations that exist; `test/nav-coverage.test.tsx` holds the allow-list
 * and asserts this list matches the masthead, which is what keeps the two from
 * drifting when a route is added.
 */
const ITEMS = [
  { href: "/", label: "The call", icon: LayoutDashboard },
  { href: "/players", label: "Players", icon: Users },
  { href: "/phases", label: "Phases", icon: CalendarRange },
  { href: "/stats", label: "Stats", icon: BarChart3 },
  { href: "/evidence", label: "Evidence", icon: Stethoscope },
  { href: "/review", label: "Review", icon: History },
];

export default function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
      {ITEMS.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            href={item.href}
            key={item.href}
            className={active ? "active" : ""}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={18} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
