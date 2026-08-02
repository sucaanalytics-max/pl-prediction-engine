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
    badge: "border-red-500/50 bg-red-500/15 text-red-300",
    card: "border-red-500/40 bg-red-500/5",
  },
  warning: {
    label: "Caveat",
    badge: "border-amber-500/50 bg-amber-500/15 text-amber-300",
    card: "border-amber-500/30 bg-amber-500/5",
  },
  info: {
    label: "Update",
    badge: "border-slate-600/60 bg-slate-700/30 text-slate-300",
    card: "border-slate-700/60 bg-slate-900/40",
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
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
        <dt className="text-slate-500">Transfers</dt>
        <dd className="text-slate-200">
          {transfersIn.length === 0 ? "none (roll)" : transfersIn.length}
        </dd>
      </div>
      <div>
        <dt className="text-slate-500">Hits</dt>
        <dd className={hits > 0 ? "text-amber-300" : "text-slate-200"}>
          {hits > 0 ? `${hits} (−${hits * 4} pts)` : "none"}
        </dd>
      </div>
      {points !== null && (
        <div>
          <dt className="text-slate-500">Projected</dt>
          <dd className="text-slate-200">{points.toFixed(1)} pts</dd>
        </div>
      )}
      <div>
        <dt className="text-slate-500">Out</dt>
        <dd className="text-slate-200">{transfersOut.length || "—"}</dd>
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
      <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
        What this engine is measured to be worth
      </summary>
      <ul className="mt-2 space-y-2">
        {claims.map(([name, claim]) => (
          <li key={name} className="flex gap-2">
            <span
              className={
                claim.verdict === "established"
                  ? "text-emerald-400"
                  : "text-amber-400"
              }
            >
              {claim.verdict === "established" ? "established" : "not established"}
            </span>
            <span className="text-slate-400">
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
    <article className={`rounded-lg border p-4 ${tone.card}`}>
      <header className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded border px-2 py-0.5 text-xs font-medium ${tone.badge}`}
        >
          {tone.label}
        </span>
        <span className="text-xs uppercase tracking-wide text-slate-500">
          {KIND_LABEL[message.kind] ?? message.kind}
        </span>
        {message.createdAt && (
          <span className="ml-auto text-xs text-slate-500">
            {formatWhen(message.createdAt)}
          </span>
        )}
      </header>

      <h3 className="mt-2 font-medium text-slate-100">{message.title}</h3>
      <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-300">
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
        <p className="mt-1 text-sm text-slate-400">
          Everything the agent has to say. This is its only channel — there is no
          email — so nothing here is a duplicate of a message sent elsewhere.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          <p className="font-medium">The feed could not be loaded.</p>
          <p className="mt-1 text-red-200/80">
            {error}. This does not mean the agent had nothing to say — it means
            this page cannot currently tell you what it said.
          </p>
        </div>
      )}

      {!error && !feed && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}

      {feed && feed.messages.length === 0 && (
        <div className="rounded-lg border border-slate-700/60 bg-slate-900/40 p-4">
          <p className="text-sm text-slate-300">Nothing published yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            This is different from &ldquo;no changes recommended&rdquo;. The agent
            has not published anything at all, which before the season starts is
            expected.
          </p>
        </div>
      )}

      {feed && feed.messages.length > 0 && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-400">
            <span>{feed.messages.length} message(s)</span>
            {needsAttention > 0 && (
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                {needsAttention} need attention
              </span>
            )}
            {feed.malformedCount > 0 && (
              <span className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-300">
                {feed.malformedCount} unreadable
              </span>
            )}
          </div>

          <div className="space-y-6">
            {grouped.map((group) => (
              <section key={group.gameweek}>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
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

      <footer className="mt-8 border-t border-slate-800 pt-4 text-xs text-slate-500">
        Nothing here has been submitted to FPL on your behalf. The agent has no
        write access by design — every recommendation needs you to act on it.
      </footer>
    </main>
  );
}
