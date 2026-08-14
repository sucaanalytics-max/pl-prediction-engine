"use client";

import { useEffect, useMemo, useState } from "react";
import {
  attentionCount,
  groupByGameweek,
  orderForReading,
  parseFeed,
  type AgentMessage,
  type MessageFeed,
  type MessageSeverity,
} from "@/lib/fpl-messages";
import { istDateTime } from "@/lib/formats";

/**
 * The agent's inbox — everything it has to say.
 *
 * This replaced email entirely, which changes what the page owes the reader. It
 * is not a dashboard to browse; it is the only place the agent can tell you
 * something, so the design priority is that nothing important can be scrolled
 * past.
 *
 * Three consequences, all deliberate:
 *
 *   - Critical messages pin to the top regardless of age. A gameweek that was
 *     never sealed is permanently unmeasurable, and burying that under three
 *     weeks of routine status notes would be the page failing at its one job.
 *   - Warnings are rendered at full weight, not as muted footnotes. They are
 *     the part most likely to change what someone does.
 *   - A message that could not be parsed is shown AS a broken message. A feed
 *     that quietly shrinks is indistinguishable from a quiet agent, and those
 *     need opposite responses.
 */

const SEVERITY: Record<
  MessageSeverity,
  { label: string; badge: string; card: string }
> = {
  critical: {
    label: "Critical",
    badge: "border-[var(--error-border)] bg-[var(--error-muted)] text-[var(--error)]",
    card: "border-[var(--error-border)] bg-[var(--error-muted)]",
  },
  warning: {
    label: "Caveat",
    badge: "border-[var(--warning-border)] bg-[var(--warning)]/15 text-[var(--warning)]",
    card: "border-[var(--warning-border)] bg-[var(--warning)]/5",
  },
  info: {
    label: "Update",
    badge: "border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)]",
    card: "border-[var(--border)] bg-[var(--surface)]",
  },
};

const KIND_LABEL: Record<string, string> = {
  decision: "Decision",
  warning: "Caveat",
  status: "Status",
  result: "Result",
};

function formatWhen(iso: string): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return istDateTime(iso);
}

function SquadDetail({ detail }: { detail: Record<string, unknown> }) {
  const decision = detail.decision as Record<string, unknown> | undefined;
  const plan = decision?.plan as Record<string, unknown> | undefined;
  if (!plan) return null;

  const transfersIn = (plan.transfers_in as unknown[]) ?? [];
  const transfersOut = (plan.transfers_out as unknown[]) ?? [];
  const hits = typeof plan.hits === "number" ? plan.hits : 0;
  const points =
    typeof decision?.mean_points === "number" ? decision.mean_points : null;

  return (
    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
      <div>
        <dt className="text-[var(--text-3)]">Transfers</dt>
        <dd className="text-[var(--text-2)]">
          {transfersIn.length === 0 ? "none (roll)" : transfersIn.length}
        </dd>
      </div>
      <div>
        <dt className="text-[var(--text-3)]">Hits</dt>
        <dd className={hits > 0 ? "text-[var(--warning)]" : "text-[var(--text-2)]"}>
          {hits > 0 ? `${hits} (−${hits * 4} pts)` : "none"}
        </dd>
      </div>
      {points !== null && (
        <div>
          <dt className="text-[var(--text-3)]">Projected</dt>
          <dd className="text-[var(--text-2)]">{points.toFixed(1)} pts</dd>
        </div>
      )}
      <div>
        <dt className="text-[var(--text-3)]">Out</dt>
        <dd className="text-[var(--text-2)]">{transfersOut.length || "—"}</dd>
      </div>
    </dl>
  );
}

function EvidenceDetail({ detail }: { detail: Record<string, unknown> }) {
  const evidence = detail.evidence as Record<string, unknown> | undefined;
  if (!evidence) return null;

  const claims = Object.entries(evidence).filter(
    ([, value]) =>
      value && typeof value === "object" && "verdict" in (value as object),
  ) as [string, { verdict: string; note?: string }][];
  if (claims.length === 0) return null;

  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer text-[var(--text-3)] hover:text-[var(--text-2)]">
        What this engine is measured to be worth
      </summary>
      <ul className="mt-2 space-y-2">
        {claims.map(([name, claim]) => (
          <li key={name} className="flex gap-2">
            <span
              className={
                claim.verdict === "established"
                  ? "text-[var(--success)]"
                  : "text-[var(--warning)]"
              }
            >
              {claim.verdict === "established" ? "established" : "not established"}
            </span>
            <span className="text-[var(--text-3)]">
              {name.replace(/_/g, " ")}
              {claim.note ? ` — ${claim.note}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function MessageCard({ message }: { message: AgentMessage }) {
  const tone = SEVERITY[message.severity];
  return (
    <article className={`rounded-none border p-4 ${tone.card}`}>
      <header className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded border px-2 py-0.5 text-xs font-medium ${tone.badge}`}
        >
          {tone.label}
        </span>
        <span className="text-xs uppercase tracking-wide text-[var(--text-3)]">
          {KIND_LABEL[message.kind] ?? message.kind}
        </span>
        {message.createdAt && (
          <span className="ml-auto text-xs text-[var(--text-3)]">
            {formatWhen(message.createdAt)}
          </span>
        )}
      </header>

      <h3 className="mt-2 font-medium text-slate-100">{message.title}</h3>
      <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-[var(--text-2)]">
        {message.body}
      </p>

      {message.detail && <SquadDetail detail={message.detail} />}
      {message.detail && <EvidenceDetail detail={message.detail} />}
    </article>
  );
}

export default function InboxPage() {
  const [feed, setFeed] = useState<MessageFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/predictions/fpl/messages.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`feed unavailable (${response.status})`);
        return response.json();
      })
      .then((raw) => {
        if (!cancelled) setFeed(parseFeed(raw));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ordered = useMemo(
    () => (feed ? orderForReading(feed.messages) : []),
    [feed],
  );
  const needsAttention = useMemo(() => attentionCount(ordered), [ordered]);
  const grouped = useMemo(() => groupByGameweek(ordered), [ordered]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-100">Agent inbox</h1>
        <p className="mt-1 text-sm text-[var(--text-3)]">
          Everything the agent has to say. This is its only channel — there is no
          email — so nothing here is a duplicate of a message sent elsewhere.
        </p>
      </header>

      {error && (
        <div className="rounded-none border border-[var(--error-border)] bg-[var(--error-muted)] p-4 text-sm text-[var(--error)]">
          <p className="font-medium">The feed could not be loaded.</p>
          <p className="mt-1 text-red-200/80">
            {error}. This does not mean the agent had nothing to say — it means
            this page cannot currently tell you what it said.
          </p>
        </div>
      )}

      {!error && !feed && (
        <p className="text-sm text-[var(--text-3)]">Loading…</p>
      )}

      {feed && feed.messages.length === 0 && (
        <div className="rounded-none border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm text-[var(--text-2)]">Nothing published yet.</p>
          <p className="mt-1 text-sm text-[var(--text-3)]">
            This is different from &ldquo;no changes recommended&rdquo;. The agent
            has not published anything at all, which before the season starts is
            expected.
          </p>
        </div>
      )}

      {feed && feed.messages.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-[var(--text-3)]">
            <span>{feed.messages.length} message(s)</span>
            {needsAttention > 0 && (
              <span className="rounded border border-[var(--warning-border)] bg-[var(--warning)]/10 px-2 py-0.5 text-[var(--warning)]">
                {needsAttention} need attention
              </span>
            )}
            {feed.malformedCount > 0 && (
              <span className="rounded border border-[var(--error-border)] bg-[var(--error-muted)] px-2 py-0.5 text-[var(--error)]">
                {feed.malformedCount} unreadable
              </span>
            )}
          </div>

          <div className="space-y-6">
            {grouped.map((group) => (
              <section key={group.gameweek}>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-3)]">
                  {group.gameweek > 0
                    ? `Gameweek ${group.gameweek}`
                    : "General"}
                </h2>
                <div className="space-y-3">
                  {group.messages.map((message) => (
                    <MessageCard key={message.id} message={message} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      <footer className="mt-8 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-3)]">
        Nothing here has been submitted to FPL on your behalf. The agent has no
        write access by design — every recommendation needs you to act on it.
      </footer>
    </main>
  );
}
