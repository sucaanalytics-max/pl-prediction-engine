"use client";

/**
 * The call — what your XI is, who is captain, and what happens if you change it.
 *
 * ## What this replaces, and why the page got shorter
 *
 * Four stacked sections: `GameweekCall` (the captain and a total), `SquadBoard`
 * (the fifteen as cards), `ScoreView` (a planner table plus a fixture run) and
 * `PlanGridSection` (the solved plan). The first three each answered a piece of
 * one question — *is this the right eleven* — and answered it three times in
 * three shapes, so a reader had to hold a card grid, a table and a headline total
 * in their head and check the three agreed. They did agree; the arithmetic was
 * shared. What none of them could do was let you disagree with it.
 *
 * {@link CallBoard} is those three folded into one surface where the eleven is
 * editable and every figure recomputes off the eleven on screen. That is the
 * whole redesign: a manager's question before a deadline is not "what does the
 * optimiser think", it is "what happens if I do it my way", and no arrangement of
 * static panels answers the second one.
 *
 * `PlanGridSection` stays, below, because it is the only surface here that reads
 * the DECISION artifact — the weeks the agent actually solved, with its own
 * starts and sales. The board above reads projections and solves one week. Those
 * are different warranties, so they keep their own sections.
 *
 * ## The four components this page replaced, and then deleted
 *
 * `GameweekCall`, `SquadBoard`, `ScoreView` and — reached only through
 * `ScoreView` — `Planner`, about 2,800 lines with their suites. They came off
 * this page first and were deleted in a separate change, because `/` was their
 * only mount and this repo has already stranded a 612-line page by deleting the
 * components that linked to it: rescue precedes deletion, and the gap between the
 * two is where you find out whether anything else needed them.
 *
 * One capability went with `Planner` and is not replaced here: a scratchpad where
 * the reader picked transfer moves and saw the points cost of a hit. `CallBoard`
 * deliberately does not do that — one published week cannot price a sale — so if
 * that is wanted back it wants its own screen rather than a corner of this one.
 *
 * ## Absence
 *
 * Answers first, caveats adjacent and quiet. Each section states its own absence
 * in one line rather than in a bordered panel — the rule from
 * `docs/superpowers/specs/2026-08-11-usable-surface-design.md`: absence never
 * occupies more space than substance.
 *
 * ## The gameweek
 *
 * One resolver, {@link useCurrentGameweek}, and no `?? 1`. The number becomes a
 * fetch path (`fpl/xp_public_gw{NN}.json`), so a wrong last resort does not
 * mislabel a figure — it reads a different file.
 */

import Link from "next/link";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Section } from "@/components/data/Artifact";
import { CallBoard } from "@/components/call/CallBoard";
import { DeadlineClock } from "@/components/DeadlineClock";
import { PlanGridSection } from "@/components/PlanGridSection";
import { useCurrentGameweek } from "@/lib/data/gameweek";

export default function CallPage() {
  const gameweek = useCurrentGameweek();

  return (
    <ErrorBoundary pageName="The call">
      <div className="space-y-8">
        <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div>
            <h1
              className="text-3xl font-extrabold tracking-tight"
              style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
            >
              Your call
            </h1>
            {/* No gameweek literal in the chrome. The board names the week once,
                beside the artifact it read it from, and a hardcoded "GW1" here
                would be wrong for 37 weeks of 38. */}
            <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
              Your eleven, your captain, and what changes if you disagree
            </p>
          </div>
          {/* The deadline the sentence above refers to, and the app's ONLY clock.
              It sits here rather than in the masthead because it constrains this
              page's decision, and it is mounted once because two clocks over one
              deadline is a defect this repo has already shipped — see
              `components/DeadlineClock.tsx`. */}
          <DeadlineClock />
        </header>

        <div data-testid="call-board">
          {gameweek === null ? (
            // One line, not a panel: a guessed gameweek would read another week's
            // file rather than mislabel this one.
            <p
              data-weight="line"
              className="text-xs"
              style={{ color: "var(--text-4)" }}
            >
              Neither the agent&apos;s status nor FPL&apos;s own state could be
              read, so the gameweek is unknown and the call cannot be pointed at a
              projection. Guessing one would read a different gameweek&apos;s file.
            </p>
          ) : (
            <CallBoard gameweek={gameweek} />
          )}
        </div>

        {/* ── The seam ────────────────────────────────────────────────────
            Where the decision leaves this app and gets re-typed into another one.

            A design review of this screen ran seven independent lenses over it
            and every one of them judged it as a closed system: does the call, on
            its own, communicate correctly. None asked what happens AFTER it is
            read — and this is a planner, not a tracker, so the binding action
            happens somewhere else entirely. The eleven is set on FPL's own site,
            by the same hands, under the same clock, from memory.

            That is the failure mode that actually matches how this is used: read
            "start Kadıoğlu, bench Palestra" correctly here, then set the wrong
            one there thirty seconds later, with nothing on either side able to
            notice before the deadline locks it.

            Two links, in the order the work happens: go and do it, then record
            what you actually did. `_read_entry` in `run_agent.py` reads a
            committed capture BEFORE asking FPL live, so the second link is the
            head of the only write path this app has. */}
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 text-xs">
          <a
            href="https://fantasy.premierleague.com/my-team"
            target="_blank"
            rel="noreferrer"
            className="underline"
            style={{ color: "var(--brand)" }}
          >
            Set this on FPL
          </a>
          <Link href="/capture" className="underline" style={{ color: "var(--brand)" }}>
            Capture what you actually submitted
          </Link>
          <span style={{ color: "var(--text-4)" }}>
            Nothing here can see what you set. The capture is how the two are
            reconciled, and it is what the agent reads first.
          </span>
        </div>

        <Section
          title="Week by week"
          subtitle="The solved plan across the horizon — who starts, who benches, who wears the armband"
        >
          {gameweek === null ? (
            <p className="text-xs" style={{ color: "var(--text-4)" }}>
              The gameweek could not be resolved, so the plan cannot be pointed at
              a decision.
            </p>
          ) : (
            <PlanGridSection gameweek={gameweek} />
          )}
        </Section>
      </div>
    </ErrorBoundary>
  );
}
