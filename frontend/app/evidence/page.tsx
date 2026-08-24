"use client";

/**
 * Evidence — what moved since I last looked, and how much of this is guessed.
 *
 * ## What this absorbs
 *
 * `/inbox`, `/accuracy` and `/health`, plus `/margin?view=news`. `WatchView`
 * already carries the decay ledger and the perfect-model calibration ceiling from
 * accuracy.json, which is what makes `/accuracy` and `/health` redundant rather
 * than the reverse. `NewsView` performs the squad join the pipeline could not, and
 * its copy is the model for how a claim should carry its source.
 *
 * The page's own `CapturedHeadlines` is gone: it read the identical NEWS_FEED
 * artifact that NewsView reads better.
 *
 * The `/inbox` half of that claim was, for a while, only a claim: the route was
 * deleted and its feed was not re-mounted anywhere, so `fpl/messages.json` — the
 * ONLY channel the agent has, `_deliver`'s own word — had no reader. It is the
 * last section, because it is a record of what was said rather than a reading of
 * what is true, and `AgentIdleNotice` sits with it: when the agent has not run,
 * one line saying so is the whole explanation for every absence on this page.
 */

import AgentMessages from "@/components/AgentMessages";
import { AgentIdleNotice } from "@/components/AgentIdleNotice";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { NewsView } from "@/components/margin/NewsView";
import { WatchView } from "@/components/margin/WatchView";
import { Section } from "@/components/data/Artifact";
import MinutesConflicts from "@/components/MinutesConflicts";
import { useCurrentGameweek } from "@/lib/data/gameweek";

export default function EvidencePage() {
  const gameweek = useCurrentGameweek();

  return (
    <ErrorBoundary pageName="Evidence">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Evidence
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            What moved since you last looked, and how much of this is guessed
          </p>
        </header>

        {/* The claims lead: they are what changed. */}
        <Section
          title="Availability"
          subtitle="What the model believes about who plays, and who said so"
        >
          <NewsView />
        </Section>

        {/* Where our own numbers and our own evidence disagree. */}
        <Section
          title="Projections the evidence argues with"
          subtitle="Reported, never applied — read the quote and decide"
        >
          <MinutesConflicts />
        </Section>

        {/* Then whether to trust any of it. */}
        <Section
          title="Do I believe it"
          subtitle="What has decayed, and how close the model is to the best any forecaster could do"
        >
          {gameweek === null ? (
            <p className="text-xs" style={{ color: "var(--text-4)" }}>
              The gameweek could not be resolved, so the decay ledger cannot be
              pointed at a projection.
            </p>
          ) : (
            <WatchView gameweek={gameweek} />
          )}
        </Section>

        {/* Last: what the agent said, rather than what is true. */}
        <Section
          title="What the agent said"
          subtitle="Its only channel — decisions, caveats and anything it could not do, newest first"
        >
          <div className="space-y-3">
            <AgentIdleNotice />
            <AgentMessages />
          </div>
        </Section>
      </div>
    </ErrorBoundary>
  );
}
