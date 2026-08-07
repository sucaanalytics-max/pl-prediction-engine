"use client";

/**
 * "What changed since you last looked, and does it change what you do?"
 *
 * The competitor study's largest finding across eight products: *the projection
 * layer and the news layer are completely disconnected. Nobody closes the loop.*
 * FPL Review has the best model and no news feed; Fantasy Football Scout has the
 * best news and weak projections. This component is the join, rendered.
 *
 * ## Three things no competitor shows
 *
 * 1. **The rule that produced the change.** `asymmetric_override` is R4 — a tier-2
 *    source may push availability DOWN but never up. Naming it is what makes the
 *    number auditable rather than something to be trusted.
 * 2. **The quote, the source and when it was SAID.** `claimed_at`, not the time we
 *    read it. Every other product shows "Carvalho 25%" with no provenance at all.
 * 3. **Impact not yet assessed**, as a first-class state. The poller emits a
 *    change within fifteen minutes; the agent computes the root-move impact later
 *    because the MILP needs scipy and the poller does not install it. Hiding the
 *    news until it is complete would throw away the latency that is the point.
 */

import type { DeltaFeed, DeltaRecord } from "@/lib/data/narrow";

/** Human wording for the resolver's rule names. */
const RULE_PROSE: Record<string, string> = {
  asymmetric_override:
    "a press source lowered this; under R4 it may push availability down but never up",
  tier_precedence: "a more authoritative source disagreed",
  recency_within_source: "the same source said something newer",
  staleness: "the previous claim aged out",
  permanence_beats_gradation: "a confirmed exit outranks a percentage",
  only_claim: "the only claim on file",
};

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "number") return `${value}%`;
  if (typeof value === "object") {
    const kind = (value as Record<string, unknown>).kind;
    return typeof kind === "string" ? kind : JSON.stringify(value);
  }
  return String(value);
}

/** Availability going down is the case that costs points if missed. */
function direction(before: unknown, after: unknown): "worse" | "better" | "flat" {
  if (typeof before !== "number" || typeof after !== "number") return "flat";
  if (after < before) return "worse";
  if (after > before) return "better";
  return "flat";
}

function DeltaRow({
  change, impact,
}: {
  change: DeltaRecord;
  impact: DeltaRecord | undefined;
}) {
  const way = direction(change.before, change.after);
  const colour =
    way === "worse" ? "var(--danger, #f87171)"
      : way === "better" ? "var(--success, #22c55e)"
        : "var(--text-2)";

  return (
    <article className="card p-4 space-y-2" data-testid="delta">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
          {change.player_name ?? `Player ${change.element_id ?? "?"}`}
          {change.club ? (
            <span className="font-normal" style={{ color: "var(--text-3)" }}>
              {" "}· {change.club}
            </span>
          ) : null}
        </h3>
        <span className="text-sm font-mono font-bold" style={{ color: colour }}>
          {describeValue(change.before)} → {describeValue(change.after)}
        </span>
      </div>

      {/* The evidence. Quote first, because it is the thing a human judges. */}
      {change.trigger ? (
        <blockquote
          className="text-xs border-l-2 pl-3"
          style={{ borderColor: "var(--border)", color: "var(--text-2)" }}
        >
          {change.trigger.quote ? `“${change.trigger.quote}”` : null}
          <footer className="mt-1" style={{ color: "var(--text-4)" }}>
            {change.trigger.source}
            {" · tier "}{change.trigger.source_tier}
            {change.trigger.claimed_at ? ` · said ${change.trigger.claimed_at}` : null}
            {change.trigger.url ? (
              <>
                {" · "}
                <a
                  href={change.trigger.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: "var(--accent)" }}
                >
                  source
                </a>
              </>
            ) : null}
          </footer>
        </blockquote>
      ) : null}

      {/* Why this cleared the threshold, and which rule decided the value. */}
      <p className="text-[11px]" style={{ color: "var(--text-4)" }}>
        {change.why_material}
        {change.rule_applied ? (
          <>
            {" · "}
            <span title={change.rule_applied}>
              {RULE_PROSE[change.rule_applied] ?? change.rule_applied}
            </span>
          </>
        ) : null}
      </p>

      {impact ? <ImpactLine impact={impact} /> : <AwaitingImpact />}
    </article>
  );
}

function ImpactLine({ impact }: { impact: DeltaRecord }) {
  const moved = impact.xp_moved.filter(
    (row) => row.before !== null && row.after !== null,
  );
  return (
    <div
      className="glass-inset p-3 space-y-1"
      data-testid="impact"
      data-flipped={impact.flipped ? "true" : "false"}
    >
      <p className="text-xs font-semibold" style={{ color: "var(--text-1)" }}>
        {impact.flipped
          ? "This changes the recommended move"
          : "The recommended move is unchanged"}
      </p>
      {impact.flipped ? (
        <p className="text-xs font-mono" style={{ color: "var(--text-2)" }}>
          {impact.root_move_before ?? "unknown"} → {impact.root_move_after ?? "unknown"}
        </p>
      ) : null}
      {moved.length > 0 ? (
        <p className="text-xs font-mono" style={{ color: "var(--text-3)" }}>
          {moved.map((row) => (
            <span key={row.element_id}>
              xP {row.before!.toFixed(2)} → {row.after!.toFixed(2)}
            </span>
          ))}
        </p>
      ) : null}
      {impact.ev_cost_of_inaction !== null ? (
        <p className="text-xs" style={{ color: "var(--text-2)" }}>
          {/* Defined as EV(new best move) − EV(old recommendation re-scored under
              the new information). Not the raw gap between two plans, which would
              count ordinary model drift as urgency. */}
          Ignoring this costs{" "}
          <strong style={{ color: "var(--text-1)" }}>
            {impact.ev_cost_of_inaction.toFixed(2)}
          </strong>{" "}
          expected points
        </p>
      ) : null}
    </div>
  );
}

function AwaitingImpact() {
  return (
    <p
      className="text-[11px] italic"
      style={{ color: "var(--text-4)" }}
      data-testid="awaiting-impact"
    >
      {/* A real state, not a spinner. The poller runs every 15 minutes and the
          agent every 3 hours, so this gap is expected and finite. */}
      Impact on your squad not yet assessed — the agent computes it on its next run.
    </p>
  );
}

export function DeltaFeedView({ feed }: { feed: DeltaFeed }) {
  const changes = feed.records.filter((r) => r.kind === "resolution_change");
  const impacts = new Map(
    feed.records
      .filter((r) => r.kind === "decision_impact")
      .map((r) => [r.delta_id, r]),
  );

  // Newest first. A feed a human scans top-down should lead with what just
  // happened, not with what happened first.
  const ordered = [...changes].sort((a, b) =>
    String(b.observed_at ?? "").localeCompare(String(a.observed_at ?? "")),
  );

  return (
    <div className="space-y-3">
      {ordered.map((change) => (
        <DeltaRow
          key={`${change.delta_id}-${change.observed_at}`}
          change={change}
          impact={impacts.get(change.delta_id)}
        />
      ))}
    </div>
  );
}
