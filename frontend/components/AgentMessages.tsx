"use client";

import { proven } from "@/lib/data/artifact";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { StateCard } from "@/components/data/Artifact";
import { istDateTime } from "@/lib/formats";
import type { AgentMessage, MessageFeed, MessageSeverity } from "@/lib/fpl-messages";

/**
 * Everything the agent has to say, on the page that absorbed its screen.
 *
 * ## Why this had to come back
 *
 * `_deliver`'s own docstring calls this app "the ONLY channel" the agent has —
 * there is no email — and `_announce` (`run_agent.py:828-835`) writes into
 * `fpl/messages.json` accordingly, including the `severity: "critical"`
 * "GW{n} was never sealed" announcement, which reports one of 38 permanently
 * unrecoverable observations a season. `/inbox` rendered that feed and was
 * deleted; `REGISTRY.messages` was left narrowed with zero consumers, so the
 * agent was writing to a channel nothing read. `/evidence` meanwhile stated in
 * its own docstring that it absorbs `/inbox`.
 *
 * ## Modest on purpose
 *
 * `/inbox` was 291 lines: severity-pinned ordering, per-gameweek grouping, and
 * two expandable detail renderers that reached into `detail.decision.plan` and
 * `detail.evidence`. None of that is rebuilt. What a reader needs from a page
 * whose question is "what moved since I last looked" is the messages, newest
 * first, each carrying the two things that place it — how loud it is, and which
 * gameweek it is about.
 *
 * Newest first, and not severity first. An old critical does sink below a new
 * routine note, which is the honest cost of a reverse-chronological feed: it is
 * a record of what the agent said, in the order it said it, and `_announce`
 * writes the missed-seal message on every run inside the report window rather
 * than once.
 *
 * A malformed record is rendered AS a malformed message rather than filtered
 * out — `parseFeed` already does that work, and the count is stated below the
 * list. A feed that quietly shrinks is indistinguishable from a quiet agent.
 */

const SEVERITY: Record<MessageSeverity, { label: string; colour: string }> = {
  critical: { label: "critical", colour: "var(--error)" },
  warning: { label: "caveat", colour: "var(--warning)" },
  info: { label: "update", colour: "var(--text-3)" },
};

/**
 * Newest first, with anything undateable last.
 *
 * `createdAt` is a string off the wire and `parseMessage` defaults it to `""`
 * rather than dropping the message, so an unparseable stamp has to sort
 * somewhere. Last, because a message with no time cannot claim to be the latest
 * news — and it is still shown, which is the point.
 */
function newestFirst(messages: readonly AgentMessage[]): AgentMessage[] {
  return [...messages].sort((a, b) => {
    const left = Date.parse(a.createdAt);
    const right = Date.parse(b.createdAt);
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
}

export default function AgentMessages() {
  const { artifact } = useArtifact<MessageFeed>(REGISTRY.messages);
  const feed = proven(artifact);

  // Absence never outweighs substance: one line, not a panel.
  if (!feed) {
    return (
      <StateCard of={artifact} weight="line"
                 what="what the agent has to tell you" />
    );
  }

  if (feed.messages.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        The agent has said nothing. That is its normal state rather than a gap —
        it publishes a message when it has one, and silence here means no
        decision, no caveat and no missed seal to report.
      </p>
    );
  }

  const ordered = newestFirst(feed.messages);

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {ordered.map((message) => {
          const tone = SEVERITY[message.severity];
          return (
            <li
              key={message.id}
              data-testid="agent-message"
              className="glass-panel rounded-none p-3 space-y-1"
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <p className="text-sm" style={{ color: "var(--text-1)" }}>
                  <span
                    className="text-[11px] uppercase tracking-wider font-mono"
                    style={{ color: tone.colour }}
                  >
                    {tone.label}
                  </span>
                  {" · "}
                  {/* Gameweek 0 is `parseMessage`'s stand-in for a record that
                      named no week, so it is not printed as "GW0". */}
                  {message.gameweek > 0 ? (
                    <span className="font-mono" style={{ color: "var(--text-3)" }}>
                      GW{message.gameweek}
                      {" · "}
                    </span>
                  ) : null}
                  <strong>{message.title}</strong>
                </p>
                {message.createdAt ? (
                  <p className="text-[11px] font-mono" style={{ color: "var(--text-3)" }}>
                    {istDateTime(message.createdAt)}
                  </p>
                ) : null}
              </div>
              {message.body ? (
                <p className="text-xs" style={{ color: "var(--text-2)" }}>
                  {message.body}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {feed.malformedCount > 0 ? (
        <p className="text-[11px]" style={{ color: "var(--text-3)" }}>
          {feed.malformedCount} record
          {feed.malformedCount === 1 ? "" : "s"} in the feed could not be read and
          are shown above as broken messages. They are counted rather than
          dropped: a feed that quietly shrinks looks like a quiet agent.
        </p>
      ) : null}
    </div>
  );
}
