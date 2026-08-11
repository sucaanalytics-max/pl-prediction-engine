"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Crown, LayoutDashboard, Layers3, Stethoscope } from "lucide-react";

const ITEMS = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/optimizer", label: "Optimize", icon: Layers3 },
  { href: "/projections", label: "Players", icon: BarChart3 },
  { href: "/captaincy", label: "Captain", icon: Crown },
  { href: "/evidence", label: "Evidence", icon: Stethoscope },
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
