"use client";

/**
 * Now — what changed, and does it change what you do.
 *
 * The lead screen, and a deliberate contrast with the homepage it replaces. That
 * one fetched five artifacts through a shared context with a single `loading` and
 * a single `error`, so any one failure blanked all five sections — and four of its
 * sections were fed by `lib/fpl-portal.ts`, 205 lines of hand-typed fake data.
 *
 * Here every section owns its state (Rule 2). One absent artifact costs exactly
 * one card, which is asserted in the tests rather than left to intent.
 */

import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import {
  ProvenanceStrip, Section, WhenProven,
} from "@/components/data/Artifact";
import SquadBoard from "@/components/SquadBoard";
import { DeltaFeedView } from "@/components/data/DeltaFeed";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { DeltaFeed, Health, MatchesFile } from "@/lib/data/narrow";
import type { MessageFeed } from "@/lib/fpl-messages";

function Deltas() {
  const { artifact } = useArtifact<DeltaFeed>(REGISTRY.deltas);
  return (
    <Section
      title="What changed"
      subtitle="Availability the model is using, and what moved it"
      aside={<ProvenanceStrip of={artifact} />}
    >
      <WhenProven
        of={artifact}
        what="No availability has changed recently. The news poller runs every 15 minutes during a press-conference or deadline window."
        // A quiet feed is the normal state outside a news window, not news itself.
        weight="line"
        then={(feed) => <DeltaFeedView feed={feed} />}
      />
    </Section>
  );
}

function AgentMessages() {
  const { artifact } = useArtifact<MessageFeed>(REGISTRY.messages);
  return (
    <Section
      title="From the agent"
      subtitle="Escalations and things it could not decide alone"
      aside={<ProvenanceStrip of={artifact} />}
    >
      <WhenProven
        of={artifact}
        what="The agent has nothing to report. It publishes only when it has something to say."
        // Says so itself: it publishes only when it has something to say, so its
        // silence should not be the largest element on the page.
        weight="line"
        then={(feed) => (
          <ul className="space-y-2">
            {feed.messages.slice(0, 8).map((message) => (
              <li key={message.id} className="card p-3">
                <p
                  className="text-sm font-semibold"
                  style={{ color: "var(--text-1)" }}
                >
                  {message.title}
                </p>
                <p className="text-xs mt-1" style={{ color: "var(--text-2)" }}>
                  {message.body}
                </p>
                <p className="text-[10px] mt-1" style={{ color: "var(--text-4)" }}>
                  GW{message.gameweek} · {message.severity} · {message.createdAt}
                </p>
              </li>
            ))}
          </ul>
        )}
      />
    </Section>
  );
}

function NextFixtures() {
  const { artifact } = useArtifact<MatchesFile>(REGISTRY.matches);
  return (
    <Section
      title="This gameweek"
      aside={<ProvenanceStrip of={artifact} />}
    >
      <WhenProven
        of={artifact}
        what="No fixtures are published for the current gameweek."
        then={(file) => (
          <div className="glass-panel rounded-2xl overflow-x-auto">
            <table className="data-table" aria-label="This gameweek's fixtures">
              <thead>
                <tr>
                  <th scope="col">Fixture</th>
                  <th scope="col" className="text-center">Call</th>
                  <th scope="col" className="text-center">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {file.matches.map((match) => (
                  <tr key={match.match_id}>
                    <td className="text-sm">
                      {match.home_team} v {match.away_team}
                    </td>
                    <td className="text-center text-sm">{match.model_prediction}</td>
                    <td className="text-center font-mono text-sm">
                      {match.confidence_pct.toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      />
    </Section>
  );
}

function ModelStatus() {
  const { artifact } = useArtifact<Health>(REGISTRY.health);
  return (
    <Section title="Model status" aside={<ProvenanceStrip of={artifact} />}>
      <WhenProven
        of={artifact}
        what="Nothing has been scored against realised results yet, so calibration is unknown — not good, and not bad."
        weight="inset"
        then={(health) => (
          <div className="glass-inset p-3">
            <p className="text-sm" style={{ color: "var(--text-2)" }}>
              {Object.keys(health.model_metrics).length} metric(s) measured ·
              status {health.status}
            </p>
          </div>
        )}
      />
    </Section>
  );
}

export default function NowPage() {
  return (
    <ErrorBoundary pageName="Now">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
          >
            Now
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            What changed since you last looked
          </p>
        </header>

        {/* Four independent sections. Rule 2: one absent artifact must not blank
            the page, which is asserted in now.test.tsx rather than intended.

            Ordered content-first. `Deltas` and `AgentMessages` were the top two and
            are both absent for most of a gameweek cycle — the poller files only
            inside a news window and the agent speaks only near a deadline — so the
            page opened with two large empty panels and put the only populated
            section, the fixture calls, third. They are one line each now and sit
            below the content. */}
        {/* The squad leads. Every product in this category opens with your fifteen
            and an answer; this app opened with empty panels, and the squad was on
            no screen at all — /api/fpl/state returned all fifteen the whole time
            and the narrower dropped them. */}
        <Section
          title="Your squad"
          subtitle="The fifteen, and the one move worth making"
        >
          <SquadBoard />
        </Section>

        <NextFixtures />
        <Deltas />
        <AgentMessages />
        <ModelStatus />
      </div>
    </ErrorBoundary>
  );
}
