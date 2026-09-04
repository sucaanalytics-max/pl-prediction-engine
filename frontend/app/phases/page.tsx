"use client";

/**
 * Phases — whose next month is soft enough to buy into.
 *
 * ## Why this is its own route
 *
 * The fixture run already appeared on `/` as an eight-column strip for the squad's
 * own players, which answers "is my defender's month kind". It cannot answer the
 * question this page exists for — "who in the LEAGUE has the kindest run" — because
 * that needs all twenty clubs at once, and twenty rows of anything is a page rather
 * than a panel.
 *
 * It also has a different warrant from every other screen here. Projections are
 * simulated; a fixture list is published. Keeping the two apart means neither
 * borrows the other's authority.
 */

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PhaseMatrix } from "@/components/phases/PhaseMatrix";
import { TeamStrength } from "@/components/phases/TeamStrength";
import { proven } from "@/lib/data/artifact";
import { useHeuristics } from "@/lib/data/useHeuristics";

export default function PhasesPage() {
  const { artifact } = useHeuristics();
  const live = proven(artifact);
  const fixtures = live?.fixtureMatrix ?? [];

  return (
    <ErrorBoundary pageName="Phases">
      <div className="space-y-6">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Phases
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Runs of three or more kind fixtures — where to hop on, and when to hop off
          </p>
        </header>

        {fixtures.length === 0 ? (
          // One line, not a panel: there is no other substance on this page for a
          // panel to outweigh, and the whole screen is the fixture list.
          <p className="text-xs" style={{ color: "var(--text-3)" }}>
            {artifact.reason
              ?? "FPL's fixture list could not be read, so there is no matrix to draw."}
          </p>
        ) : (
          <PhaseMatrix fixtures={fixtures} />
        )}

        {/* A third warrant, below the fixture list and labelled as such.
            The matrix says whose fixtures are kind; this says who has actually
            been good, as a provider that is not us measured it. Kept apart for
            the reason stated at the top of this file: neither may borrow the
            other's authority. */}
        <section className="space-y-2">
          <h2
            className="text-sm font-semibold tracking-tight"
            style={{ color: "var(--text-1)" }}
          >
            Who has actually been good
          </h2>
          <p className="text-xs" style={{ color: "var(--text-3)" }}>
            A kind run only helps a club that can use it — measured, not simulated
          </p>
          <TeamStrength />
        </section>
      </div>
    </ErrorBoundary>
  );
}
