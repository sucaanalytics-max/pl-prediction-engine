"use client";

/**
 * Review — were you right, and was a call wrong or merely unlucky.
 *
 * ## Why this is its own screen and not a strip on /evidence
 *
 * `/evidence` answers "how much of this is guessed", which is a question about the
 * model. This answers a question about the manager, and the two have different
 * subjects, different cadences and different consequences. A strip would also put a
 * post-hoc judgement on a page read *before* a deadline, which is exactly the wrong
 * moment: nothing here helps you pick a team this week, and mixing it in invites
 * the reader to relitigate last week while the clock runs.
 *
 * It is deliberately the last item in the masthead. This is a planner, and the
 * order of the top bar is the order of the week: pick the team, look at the
 * horizon, check the evidence, and only afterwards read what the last one cost.
 *
 * ## No deadline clock here
 *
 * One per screen is the house rule, and this screen is about gameweeks that have
 * already settled. A countdown would imply the page had something to say about the
 * next one.
 */

import { ErrorBoundary } from "@/components/ErrorBoundary";
import DecisionReview from "@/components/review/DecisionReview";

export default function ReviewPage() {
  return (
    <ErrorBoundary pageName="Review">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Review
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Your own calls, scored only against what the engine said before the
            deadline
          </p>
        </header>

        <DecisionReview />

        <p
          className="text-[11px] leading-relaxed max-w-2xl"
          style={{ color: "var(--text-4)" }}
        >
          Every judgement on this page is made against{" "}
          <span className="font-mono">predictions/fpl/ledger/</span>, the record
          written before each deadline and never edited afterwards. That is the only
          reason a verdict here means anything: a forecast produced after the fact
          could justify any decision. Where the sealed forecast could not separate two
          players — measured against the simulation&rsquo;s own standard error — the
          call is reported as too close to call rather than as a mistake.
        </p>
      </div>
    </ErrorBoundary>
  );
}
