"use client";

/**
 * The call — what your XI is, and who is captain, before the deadline.
 *
 * ## What this replaces
 *
 * A `redirect("/margin")`. Before that, a `redirect("/now")`. The front door has
 * only ever pointed somewhere else, and the somewhere else kept moving: at the
 * time of writing the same question — *who do I captain* — had four doors
 * (`/now`, `/margin?view=plan`, `/decide`, `/decisions`) and they disagreed with
 * each other. Two of them read decision files this repo says nothing writes.
 *
 * So this page is one composition of three things that already existed, in the
 * order a manager needs them, and it authors no new number:
 *
 *  1. {@link GameweekCall} — the captain and the eleven, from
 *     `lib/margin/squad.ts` `joinProjections` (one join, on FPL's own
 *     `elementId`) and `lib/margin/planner.ts` `optimiseXi`/`projectedTotal`
 *     (one solver, exhaustive over the legal formations). One captain, one total,
 *     and the total carries `COUNTING_RULE` because two screens used to print
 *     48.20 and 54.9 for the same eleven with neither stating its counting rule.
 *     The clause is named rather than quoted here: a docstring holding its own
 *     copy of the wording is how the three surfaces drifted apart in the first
 *     place.
 *  2. {@link SquadBoard} — the fifteen, each carrying the model's own xP, and the
 *     squad line carrying `captured draft, not live`. Its heuristic "the-move"
 *     card is already gone; that cut is what leaves exactly one captain here.
 *  3. {@link ScoreView} — the planner grid with the distribution glyphs in the xP
 *     column, and the fixture run. Passed `captaincyPlan={false}`, because the
 *     heuristic's six-week armband list would put a second, a third and a sixth
 *     captain under the one this page opens with.
 *
 * ## Nothing was deleted to make room for it
 *
 * `/now`, `/margin`, `/decide` and the six other paths this is meant to absorb
 * all still work, unchanged, so the two surfaces can be compared before anything
 * is destroyed. This repo has already stranded a 612-line page by deleting the
 * only components that linked to it; rescue precedes deletion.
 *
 * ## Absence
 *
 * Answers first, caveats adjacent and quiet. The two sections that answer the
 * reader's question lead, and each states its own absence in one line rather than
 * in a bordered panel — the rule from
 * `docs/superpowers/specs/2026-08-11-usable-surface-design.md`: absence never
 * occupies more space than substance. That is not tidiness. Every improvement to
 * how articulately this app explained absence used to push the content that
 * answers the question further down the page.
 *
 * ## The gameweek
 *
 * One resolver, {@link useCurrentGameweek}, and no `?? 1`. The number becomes a
 * fetch path (`fpl/xp_public_gw{NN}.json`), so a wrong last resort does not
 * mislabel a figure — it reads a different file.
 */

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Section } from "@/components/data/Artifact";
import GameweekCall from "@/components/GameweekCall";
import SquadBoard from "@/components/SquadBoard";
import { PlanGridSection } from "@/components/PlanGridSection";
import { ScoreView } from "@/components/margin/ScoreView";
import { useCurrentGameweek } from "@/lib/data/gameweek";

export default function CallPage() {
  const gameweek = useCurrentGameweek();

  return (
    <ErrorBoundary pageName="The call">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Your call
          </h1>
          {/* No gameweek literal in the chrome. `GameweekCall` names the week
              once, beside the artifact it read it from, and a hardcoded "GW1"
              here would be wrong for 37 weeks of 38. */}
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            What your XI is, and who is captain, before the deadline
          </p>
        </header>

        {/* The model's call leads, and it is the only captain on this page. */}
        <Section
          title="Captain and XI"
          subtitle="Computed from the model's own projection for this gameweek"
        >
          <GameweekCall />
        </Section>

        <Section
          title="Your squad"
          subtitle="The fifteen, with the model's projection for each of them"
        >
          <SquadBoard />
        </Section>

        {/* The plan and the run, below the answer they support. */}
        <Section
          title="The plan"
          subtitle="Your eleven scored against the projection, and the fixture run behind it"
        >
          {gameweek === null ? (
            // One line, not a panel: the two sections above still answer the
            // question this page exists for.
            <p className="text-xs" style={{ color: "var(--text-4)" }}>
              Neither the agent&apos;s status nor FPL&apos;s own state could be
              read, so the gameweek is unknown and the plan cannot be pointed at a
              projection. Guessing one would read a different gameweek&apos;s file.
            </p>
          ) : (
            <ScoreView
              gameweek={gameweek}
              captaincyPlan={false}
              speaksForUnsolvedWeeks={false}
            />
          )}
        </Section>

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
