"use client";

/**
 * Betting — the entry point for the half of this app that is not FPL.
 *
 * ## Why this page exists
 *
 * Five screens here answer "is there a bet, and what is the stake": markets,
 * bankroll, matches and h2h, at 2,087 lines. That is 40% of the app's real code
 * and none of the FPL job, and the two halves were interleaved in one sidebar —
 * so a reader looking for their captain scrolled past a Kelly staking table.
 *
 * The fix is not deletion. The betting screens work and are used; they simply do
 * not belong in the same navigation as the planner. So they move behind this one
 * door, and the FPL sidebar carries a single entry to it.
 *
 * ## Why an index rather than an allow-list entry
 *
 * `test/nav-coverage.test.tsx` exists because thirteen routes were once linked
 * from nowhere and only a test noticed. Excusing four more routes as "not a
 * destination" would be the same bug wearing a reason: they ARE destinations.
 * They are reached from here, and the test now asserts exactly that — a route
 * excused from the sidebar as a betting screen must be linked on this page.
 *
 * The guard is redirected, not weakened.
 */

import Link from "next/link";
import { ArrowLeft, GitCompareArrows, Swords, TrendingUp, WalletCards } from "lucide-react";

/** The betting screens, and what each one answers. */
const SCREENS = [
  {
    href: "/markets",
    label: "Markets",
    icon: TrendingUp,
    blurb: "Where the model disagrees with the price, and what to stake.",
  },
  {
    href: "/bankroll",
    label: "Bankroll",
    icon: WalletCards,
    blurb: "What is at risk, what it has returned, and the staking ladder.",
  },
  {
    href: "/matches",
    label: "Fixtures & table",
    icon: GitCompareArrows,
    blurb: "The model's call on each fixture, and where the league stands.",
  },
  {
    href: "/h2h",
    label: "Head to head",
    icon: Swords,
    blurb: "Two clubs, their record, and what it implies for the next meeting.",
  },
] as const;

export default function BettingIndex() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 space-y-8">
      <div className="space-y-3">
        <Link
          href="/margin"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to FPL
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Betting</h1>
        <p className="max-w-prose text-sm text-slate-600 dark:text-slate-400">
          Kept separate from the FPL side on purpose. These screens answer what to
          stake, which is a different question on a different schedule from who to
          pick.
        </p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        {SCREENS.map(({ href, label, icon: Icon, blurb }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex h-full flex-col gap-1.5 rounded-md border border-slate-200 p-4 transition-colors hover:border-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-slate-800 dark:hover:border-slate-600"
            >
              <span className="flex items-center gap-2 font-medium">
                <Icon className="h-4 w-4 text-slate-500" aria-hidden="true" />
                {label}
              </span>
              <span className="text-sm text-slate-600 dark:text-slate-400">{blurb}</span>
            </Link>
          </li>
        ))}
      </ul>

      <p className="max-w-prose text-xs text-slate-500">
        Fixtures appears here rather than under FPL because the page is mostly the
        match-outcome model and the league table. The fixture-difficulty grid it
        also renders is available on the planner, which is where it is used.
      </p>
    </div>
  );
}
