"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { usePredictions } from "@/lib/PredictionsContext";

const NAV_ITEMS = [
  {
    href: "/",
    label: "Matchweek",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    href: "/value-bets",
    label: "Value Bets",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    href: "/table",
    label: "League Table",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 6h18M3 14h18M3 18h18" />
      </svg>
    ),
  },
  {
    href: "/h2h",
    label: "Head-to-Head",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
    ),
  },
  {
    href: "/players",
    label: "Players",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    href: "/bankroll",
    label: "Bankroll",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    href: "/health",
    label: "Model Health",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
  },
];

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="w-7 h-7" />;
  const isDark = resolvedTheme === "dark";
  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-150"
      style={{
        background: "var(--surface2)",
        border: "1px solid var(--border)",
        color: "var(--text-3)",
      }}
    >
      {isDark ? (
        /* Sun — visible in dark mode, clicking switches to light */
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
        </svg>
      ) : (
        /* Moon — visible in light mode, clicking switches to dark */
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  );
}

export default function Navigation() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { predictions, lastUpdated, isStale } = usePredictions();

  const pipelineVersion = predictions?.metadata?.pipeline_version ?? "—";
  const season = predictions?.metadata?.season ?? "2025-26";
  const valueBetCount =
    predictions?.predictions?.reduce((acc, p) => acc + (p.value_bets?.length ?? 0), 0) ?? 0;

  return (
    <>
      {/* Skip to content */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:px-4 focus:py-2 focus:rounded-lg focus:text-sm focus:text-white"
        style={{ background: "var(--accent)" }}
      >
        Skip to content
      </a>

      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-expanded={mobileOpen}
        aria-controls="sidebar-nav"
        aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
        className="fixed top-4 left-4 z-50 lg:hidden p-2 rounded-xl transition-all duration-300 glass-panel hover:scale-105"
        style={{
          color: "var(--text-1)",
        }}
      >
        <svg
          className="w-5 h-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          {mobileOpen ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 lg:hidden"
          style={{ background: "var(--overlay)" }}
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        id="sidebar-nav"
        role="navigation"
        aria-label="Main navigation"
        className={`fixed top-0 left-0 z-40 h-screen w-72 flex flex-col glass-panel shadow-2xl
                     transform transition-all duration-500 cubic-bezier(0.16, 1, 0.3, 1)
                     ${mobileOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}
        style={{
          borderRight: "1px solid var(--border)",
          borderTop: "none",
          borderBottom: "none",
          borderLeft: "none",
          backdropFilter: "blur(40px)",
          WebkitBackdropFilter: "blur(40px)"
        }}
      >
        {/* Logo */}
        <div
          className="px-5 py-4 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <Link
            href="/"
            className="flex items-center gap-3"
            onClick={() => setMobileOpen(false)}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform duration-300 hover:scale-110"
              style={{ background: "var(--accent-muted)", border: "1px solid var(--accent-border)", boxShadow: "var(--glow-accent)" }}
            >
              <svg
                className="w-6 h-6"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
                style={{ color: "var(--accent-text)", filter: "drop-shadow(0 0 8px var(--accent))" }}
              >
                <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9zm-4 4h2v2H5v-2zm4 0h2v2H9v-2zm4 0h2v2h-2v-2z" />
              </svg>
            </div>
            <div>
              <p className="font-extrabold text-base tracking-tight leading-none bg-clip-text text-transparent" style={{ backgroundImage: "linear-gradient(135deg, var(--text-1) 0%, var(--text-3) 100%)" }}>
                PL Engine
              </p>
              <p className="text-[10px] uppercase tracking-[0.2em] font-bold mt-1" style={{ color: "var(--accent)", textShadow: "0 0 10px var(--accent-muted)" }}>
                Prediction Model
              </p>
            </div>
          </Link>
        </div>

        {/* Nav links */}
        <nav className="p-4 space-y-1.5 flex-1 overflow-y-auto" aria-label="Primary">
          {NAV_ITEMS.map((item, idx) => {
            const isActive =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`${isActive ? "nav-link-active" : "nav-link"} stagger-${(idx % 5) + 1} animate-slide-up`}
                aria-current={isActive ? "page" : undefined}
                style={{ animationFillMode: 'both' }}
              >
                <span aria-hidden="true" className="transition-transform duration-300 group-hover:scale-110">{item.icon}</span>
                <span className="flex-1 tracking-wide">{item.label}</span>
                {item.href === "/value-bets" && valueBetCount > 0 && (
                  <span
                    className="ml-auto text-[10px] font-mono font-extrabold px-2 py-0.5 rounded-full shadow-lg"
                    aria-label={`${valueBetCount} value bets available`}
                    style={{
                      background: "var(--success-muted)",
                      color: "var(--accent)",
                      border: "1px solid var(--accent-border)",
                      boxShadow: "var(--glow-accent)"
                    }}
                  >
                    {valueBetCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div
          className="p-5 space-y-3 glass-panel mt-auto rounded-none border-x-0 border-b-0"
        >
          {lastUpdated && (
            <div className="flex items-center gap-2 text-[11px] font-medium" style={{ color: "var(--text-3)" }}>
              {isStale ? (
                <span className="stale-warning !text-[9px] !px-1.5 !py-0.5">STALE</span>
              ) : (
                <span
                  className="w-2 h-2 rounded-full animate-pulse flex-shrink-0"
                  style={{ background: "var(--accent)", boxShadow: "var(--glow-accent)" }}
                  aria-hidden="true"
                />
              )}
              <span>Updated {timeAgo(lastUpdated)}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-bold tracking-wider uppercase" style={{ color: "var(--text-4)" }}>v{pipelineVersion}</span>
            <span className="text-[10px] font-bold tracking-wider uppercase ml-auto" style={{ color: "var(--text-4)" }}>{season}</span>
            <ThemeToggle />
          </div>
        </div>
      </aside>
    </>
  );
}
