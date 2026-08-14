"use client";

import { useEffect, useState } from "react";
import {
  classifyDecision,
  formatRemaining,
  loadDecision,
  type DecisionTeam,
  type DecisionView,
} from "@/lib/fpl-decision";
import { istDateTime } from "@/lib/formats";
import { useHeuristics } from "@/lib/data/useHeuristics";
import { proven } from "@/lib/data/artifact";

/**
 * The agent's published decision.
 *
 * Deliberately unglamorous. The job of this page is to be unambiguous about
 * whether the advice on it is safe to act on: a decision past its deadline still
 * parses and still looks authoritative, and acting on one costs a whole
 * gameweek. So freshness is the loudest thing on the page, and an expired or
 * stale decision is banner-first with the recommendation visibly de-emphasised.
 */

const BANNER: Record<
  DecisionView["freshness"],
  { label: string; className: string }
> = {
  ready: {
    label: "Ready",
    className: "border-[var(--success-border)] bg-[var(--success)]/10 text-[var(--success)]",
  },
  expired: {
    label: "Expired — do not act on this",
    className: "border-[var(--error-border)] bg-[var(--error-muted)] text-[var(--error)]",
  },
  stale: {
    label: "Stale — not published for the current gameweek",
    className: "border-[var(--warning-border)] bg-[var(--warning)]/10 text-[var(--warning)]",
  },
  absent: {
    label: "Nothing published yet",
    className: "border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)]",
  },
};

function TeamCard({ team, muted }: { team: DecisionTeam; muted: boolean }) {
  const transfers = team.transfers ?? [];
  return (
    <section
      className={`rounded-none border border-[var(--border)] bg-[var(--surface)] p-5 ${
        muted ? "opacity-50" : ""
      }`}
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold capitalize">{team.label}</h2>
        {team.projectedPoints !== undefined && (
          <span className="text-sm text-[var(--text-3)]">
            {team.projectedPoints.toFixed(1)} pts
            {team.projectedInterval ? ` · 90% ${team.projectedInterval}` : ""}
          </span>
        )}
      </header>

      {team.status && team.status !== "ok" && (
        <p className="mb-3 rounded border border-[var(--warning-border)] bg-[var(--warning)]/10 px-3 py-2 text-xs uppercase tracking-wide text-[var(--warning)]">
          {team.status.replace(/_/g, " ")}
        </p>
      )}

      <dl className="space-y-2 text-sm">
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-[var(--text-3)]">Captain</dt>
          <dd>{team.captain ?? "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-[var(--text-3)]">Vice</dt>
          <dd>{team.viceCaptain ?? "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-[var(--text-3)]">Chip</dt>
          <dd>{team.chip ?? "none"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-24 shrink-0 text-[var(--text-3)]">Transfers</dt>
          <dd>
            {/* "No transfers" is a decision, not an absence of one. */}
            {transfers.length === 0 ? (
              <span className="text-[var(--text-3)]">none (roll)</span>
            ) : (
              <ul className="space-y-1">
                {transfers.map((move, index) => (
                  <li key={index}>
                    {move.out} → {move.in}
                    {move.note ? (
                      <span className="ml-2 text-xs text-[var(--text-3)]">
                        {move.note}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export default function DecisionsPage() {
  const [view, setView] = useState<DecisionView | null>(null);
  // The current gameweek comes from live state, never from the decision itself
  // — comparing the artifact to itself could not detect that the agent failed
  // to run. Through the shared hook rather than a raw fetch: this page used
  // `state?.event?.id` on an unnarrowed body, which is the same unchecked read
  // that let `HealthData` drift, and it issued a second request for a response
  // the nav had already fetched.
  const { artifact: live } = useHeuristics();
  const currentGameweek = proven(live)?.event.id ?? null;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const decision = await loadDecision();
      if (cancelled) return;
      setView(classifyDecision(decision, currentGameweek));
    }

    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentGameweek]);

  if (!view) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <p className="text-[var(--text-3)]">Loading decision…</p>
      </main>
    );
  }

  const banner = BANNER[view.freshness];
  const muted = view.freshness === "expired" || view.freshness === "stale";

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="mb-2 text-2xl font-semibold">Agent decision</h1>
      <p className="mb-6 text-sm text-[var(--text-3)]">
        A recommendation. Nothing is submitted on your behalf — the agent has no
        write access to FPL by design.
      </p>

      <div className={`mb-6 rounded-none border px-4 py-3 ${banner.className}`}>
        <p className="font-medium">{banner.label}</p>
        <p className="mt-1 text-sm opacity-90">{view.reason}</p>
        {view.freshness === "ready" && view.msToDeadline !== null && (
          <p className="mt-1 text-sm opacity-90">
            Time remaining: {formatRemaining(view.msToDeadline)}
          </p>
        )}
      </div>

      {view.decision ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {view.decision.teams.map((team) => (
              <TeamCard key={team.label} team={team} muted={muted} />
            ))}
          </div>

          {view.decision.notices && view.decision.notices.length > 0 && (
            <section className="mt-6 rounded-none border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="mb-2 text-sm font-semibold text-[var(--text-2)]">Notes</h2>
              <ul className="list-inside list-disc space-y-1 text-sm text-[var(--text-3)]">
                {view.decision.notices.map((notice, index) => (
                  <li key={index}>{notice}</li>
                ))}
              </ul>
            </section>
          )}

          <p className="mt-6 text-xs text-[var(--text-3)]">
            Generated {istDateTime(view.decision.generatedAt)} · deadline{" "}
            {istDateTime(view.decision.deadline)}
            {currentGameweek !== null ? ` · current GW${currentGameweek}` : ""}
          </p>
        </>
      ) : (
        <section className="rounded-none border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-3)]">
          <p>
            The agent has not published a decision. The optimiser that produces
            one is not built yet — projections are being generated and sealed
            first, so that when decisions start they can be measured from the
            beginning rather than assessed in hindsight.
          </p>
        </section>
      )}
    </main>
  );
}
