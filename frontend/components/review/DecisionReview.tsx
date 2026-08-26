"use client";

/**
 * Your decisions, scored against the forecast that predated the deadline.
 *
 * ## What the copy has to get right
 *
 * Three verdicts arrive from the producer and only one is a reproach. Rendering
 * them as a severity ramp — bad, worse, worst — would turn the middle one into a
 * mild accusation, and the middle one exists precisely to say *the engine could not
 * tell these two players apart*. So `indistinguishable` reads as "too close to
 * call" in the same weight as the rest of the row, never in a warning colour.
 *
 * `defensible` is not praise either. A distribution means the better call loses
 * often, so "right call" is a statement about the decision and deliberately says
 * nothing about the result.
 *
 * ## Why a rescued error is still shown as a lesson
 *
 * An automatic substitution can cover a bad start entirely, and the producer still
 * marks it a lesson because the decision was the same. The row therefore shows a
 * cost of nothing and a lesson at once, which looks contradictory until you read
 * it — so the copy says "cost nothing this time", and the word doing the work is
 * `time`.
 *
 * ## Withholding
 *
 * The aggregate block renders the producer's own `aggregateReason` verbatim rather
 * than a phrase invented here. One settled gameweek cannot support a rate, and a
 * number with a caveat beside it is read as the number.
 */

import { useArtifact } from "@/lib/data/useArtifact";
import { Section, StateCard, ProvenanceStrip } from "@/components/data/Artifact";
import { proven } from "@/lib/data/artifact";
import { FLOODLIT } from "@/lib/margin/tokens";
import {
  DECISION_REVIEW,
  nameOf,
  type BenchCall,
  type DecisionReview as Review,
  type GameweekReview,
  type Verdict,
} from "@/lib/data/decision-review";

/** The mark for a quantity nobody published. Never a zero. */
const WITHHELD = "∅";

/** The app's own semantic three. A verdict is a judgement, so it takes them. */
const S = FLOODLIT;

const VERDICT_COPY: Record<Verdict, { label: string; tone: string; gloss: string }> = {
  foreseeable: {
    label: "could have known",
    tone: S.conflict,
    gloss: "the sealed forecast ranked the player you left out higher",
  },
  defensible: {
    label: "right call",
    tone: S.agree,
    gloss: "the forecast preferred the player you started; results vary",
  },
  indistinguishable: {
    label: "too close to call",
    tone: "var(--text-3)",
    gloss: "the two projections sat inside the simulation's own error",
  },
};

const KIND_COPY: Record<BenchCall["kind"], string> = {
  rescued: "auto-subbed on",
  cost: "left out",
  correct: "correctly benched",
  no_claim: "did not play",
};

function VerdictChip({
  verdict,
  kind,
}: {
  verdict: Verdict | null;
  kind: BenchCall["kind"];
}) {
  if (verdict === null) {
    // Two different silences, and labelling them the same was a real bug caught
    // in the browser: a benched player who never came on has no comparison to be
    // judged against, which is not the same as the sealed universe having omitted
    // him. Saying "not covered" about a player the forecast covered perfectly well
    // blames the data for a question nobody asked.
    const noComparison = kind === "no_claim" || kind === "correct";
    return (
      <span
        className="text-[11px] font-mono"
        style={{ color: "var(--text-3)" }}
        title={
          noComparison
            ? "He did not come on, so benching him cannot be judged either way."
            : "The sealed universe did not cover both players, so there is nothing to judge against."
        }
      >
        {WITHHELD} {noComparison ? "nothing to judge" : "not covered"}
      </span>
    );
  }
  const copy = VERDICT_COPY[verdict];
  return (
    <span
      className="text-[11px] font-mono px-1.5 py-0.5"
      style={{ color: copy.tone, background: "rgba(233,238,245,.06)" }}
      title={copy.gloss}
    >
      {copy.label}
    </span>
  );
}

function BenchRow({ call, review }: { call: BenchCall; review: Review }) {
  const who = nameOf(review, call.benchElement) ?? `#${call.benchElement}`;
  const against = nameOf(review, call.starterElement);

  return (
    <li
      className="flex items-baseline justify-between gap-3 flex-wrap py-1.5"
      style={{ borderTop: "1px solid rgba(233,238,245,.07)" }}
      data-testid="bench-call"
    >
      <span className="text-xs" style={{ color: "var(--text-2)" }}>
        <strong style={{ color: "var(--text-1)" }}>{who}</strong>{" "}
        <span style={{ color: "var(--text-3)" }}>{KIND_COPY[call.kind]}</span>
        {against ? (
          <span style={{ color: "var(--text-3)" }}> for {against}</span>
        ) : null}
      </span>
      <span className="flex items-baseline gap-2">
        {call.kind === "cost" ? (
          <span className="text-xs font-mono" style={{ color: "var(--text-2)" }}>
            &minus;{call.pointsForgone}
          </span>
        ) : call.kind === "rescued" && call.isLesson ? (
          <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
            cost nothing this time
          </span>
        ) : null}
        <VerdictChip verdict={call.verdict} kind={call.kind} />
      </span>
    </li>
  );
}

function Week({ week, review }: { week: GameweekReview; review: Review }) {
  const selection = week.selection;
  const captain = week.captain;
  const higher = selection?.benchRatedHigher ?? [];
  const worst = nameOf(review, selection?.worstStarter ?? null);

  return (
    <div className="glass-panel rounded-none p-4 space-y-3" data-testid="review-week">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3
          className="text-sm font-bold"
          style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
        >
          Gameweek {week.gameweek}
        </h3>
        <span className="text-[11px] font-mono" style={{ color: "var(--text-3)" }}>
          {week.points === null ? WITHHELD : `${week.points} pts`}
          {week.hitCost ? ` · ${week.hitCost} on hits` : ""}
          {week.secondsBeforeDeadline !== null
            ? ` · sealed ${(week.secondsBeforeDeadline / 3600).toFixed(1)}h before the deadline`
            : ""}
        </span>
      </div>

      {selection && higher.length > 0 && worst ? (
        <p className="text-xs" style={{ color: "var(--text-2)" }}>
          You started <strong style={{ color: "var(--text-1)" }}>{worst}</strong>, and{" "}
          {higher.length} of your {week.submittedBench.length} bench players were rated
          above him before the deadline
          {selection.gap !== null ? (
            <>
              {" "}
              &mdash; the best of them by{" "}
              <span className="font-mono">{selection.gap.toFixed(2)}</span> expected
              points
            </>
          ) : null}
          .
        </p>
      ) : selection && selection.worstStarter !== null ? (
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          Every player you started was rated above every player you benched. That is a
          result, not an absence.
        </p>
      ) : null}

      <ul>
        {week.bench.map((call) => (
          <BenchRow key={call.benchElement} call={call} review={review} />
        ))}
      </ul>

      {captain ? (
        <p
          className="text-xs pt-2"
          style={{ color: "var(--text-3)", borderTop: "1px solid rgba(233,238,245,.07)" }}
        >
          {captain.agreed === null ? (
            <>
              Captained{" "}
              <strong style={{ color: "var(--text-1)" }}>
                {nameOf(review, captain.chosen) ?? `#${captain.chosen}`}
              </strong>
              . The sealed forecast covered none of your eleven, so there is nothing to
              compare it against.
            </>
          ) : captain.agreed ? (
            <>
              Captained{" "}
              <strong style={{ color: "var(--text-1)" }}>
                {nameOf(review, captain.chosen) ?? `#${captain.chosen}`}
              </strong>
              , which was the engine&rsquo;s own pick of your eleven.
            </>
          ) : (
            <>
              Captained{" "}
              <strong style={{ color: "var(--text-1)" }}>
                {nameOf(review, captain.chosen) ?? `#${captain.chosen}`}
              </strong>
              ; the engine preferred{" "}
              <strong style={{ color: "var(--text-1)" }}>
                {nameOf(review, captain.sealedBest) ?? `#${captain.sealedBest}`}
              </strong>
              {captain.pointsDelta !== null ? (
                <>
                  , worth{" "}
                  <span className="font-mono">
                    {captain.pointsDelta > 0 ? "+" : ""}
                    {captain.pointsDelta}
                  </span>{" "}
                  with the armband doubled
                </>
              ) : null}
              .
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

export default function DecisionReview() {
  const { artifact } = useArtifact(DECISION_REVIEW);
  const review = proven(artifact);

  if (!review) {
    return (
      <StateCard
        of={artifact}
        weight="line"
        what="your own decisions, scored against the sealed forecast"
      />
    );
  }

  const weeks = [...review.gameweeks].sort((a, b) => b.gameweek - a.gameweek);

  return (
    <Section
      title="Your record"
      subtitle="Not whether the model was right — whether you were, judged only against what was knowable before the deadline"
      aside={<ProvenanceStrip of={artifact} />}
    >
      {review.aggregate ? (
        <div className="glass-panel rounded-none p-4 grid gap-4 sm:grid-cols-4">
          <Figure
            label="Gameweeks"
            value={String(review.aggregate.gameweeks)}
          />
          <Figure
            label="Left on the bench"
            value={String(review.aggregate.pointsForgoneOnBench)}
          />
          <Figure
            label="Avoidable calls"
            value={String(review.aggregate.foreseeableBenchErrors)}
          />
          <Figure
            label="Captain agreement"
            value={
              review.aggregate.captainAgreementRate === null
                ? WITHHELD
                : `${Math.round(review.aggregate.captainAgreementRate * 100)}%`
            }
          />
        </div>
      ) : (
        <div
          className="p-3 text-xs"
          style={{
            color: "var(--text-3)",
            background: "var(--surface2)",
            borderLeft: "2px solid var(--text-3)",
          }}
        >
          <span className="font-mono" style={{ color: "var(--text-3)" }}>
            {WITHHELD}
          </span>{" "}
          {review.aggregateReason ??
            "No rate is reported yet, and the producer gave no reason."}
        </div>
      )}

      {weeks.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          No gameweek has settled, so there is nothing to review. This fills in as the
          season goes.
        </p>
      ) : (
        <div className="space-y-3">
          {weeks.map((week) => (
            <Week key={week.gameweek} week={week} review={review} />
          ))}
        </div>
      )}
    </Section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="text-[11px] font-semibold uppercase"
        style={{ color: "var(--text-3)", letterSpacing: ".15em" }}
      >
        {label}
      </div>
      <div
        className="font-mono text-xl mt-1"
        style={{ color: "var(--text-1)" }}
      >
        {value}
      </div>
    </div>
  );
}
