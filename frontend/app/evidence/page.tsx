"use client";

/**
 * Evidence — why each availability number is what it is.
 *
 * The competitor study's single largest finding, across eight products:
 *
 * > *Nobody presents injury/availability evidence — only conclusions. FFS gives
 * > you "Carvalho 25%" with no source, no quote, no timestamp on the claim. No
 * > product shows you: here is the press-conference quote, here is who reported
 * > it, here is when, here is why 25%. The entire category asks you to trust a
 * > number.*
 *
 * So the losing claims here are **the content, not an expandable footnote**. A
 * player whose 25% survived three conflicting reports is a different decision from
 * one whose 25% is unopposed, and this is the only place that distinction is
 * visible.
 *
 * Replaces the previous /evidence, which read live FPL flags through
 * `FplLiveContext` and could show only the conclusion.
 */

import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { NEWS_FEED, type NewsFeed } from "@/lib/data/news-feed";
import { ProvenanceStrip, Section, WhenProven } from "@/components/data/Artifact";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import XScanButton from "@/components/XScanButton";
import type {
  EvidenceClaim, EvidenceEntry, EvidencePlayer, EvidenceView,
} from "@/lib/data/narrow";

/** The resolver's rule names, in words a reader can act on. */
const RULE_PROSE: Record<string, string> = {
  asymmetric_override:
    "R4 — a lower-tier source may push availability down, never up",
  tier_precedence: "R3 — a more authoritative source wins",
  recency_within_source: "R2 — the same source said something newer",
  staleness: "R1 — the older claim passed the staleness horizon",
  permanence_beats_gradation: "R6 — a confirmed exit outranks a percentage",
  only_claim: "the only claim on file",
  unresolvable: "R7 — equally authoritative and equally fresh; escalated",
};

const TIER_LABEL: Record<number, string> = {
  1: "official",
  2: "press conference",
  3: "aggregator",
};

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return `${value}%`;
  if (typeof value === "object") {
    const kind = (value as Record<string, unknown>).kind;
    return typeof kind === "string" ? kind : JSON.stringify(value);
  }
  return String(value);
}

const VERDICT_STYLE: Record<string, { colour: string; mark: string }> = {
  // Colourblind-safe: the glyph carries the meaning, colour only reinforces it.
  won: { colour: "var(--success, #22c55e)", mark: "✓" },
  lost: { colour: "var(--text-4)", mark: "✗" },
  dropped: { colour: "var(--warning, #f59e0b)", mark: "!" },
};

function ClaimRow({ claim }: { claim: EvidenceClaim }) {
  const style = VERDICT_STYLE[claim.verdict] ?? VERDICT_STYLE.lost;
  const faded = claim.verdict !== "won";
  return (
    <li
      className="flex gap-2 text-xs py-1.5"
      style={{ opacity: faded ? 0.72 : 1 }}
      data-verdict={claim.verdict}
    >
      <span
        aria-hidden="true"
        className="font-mono font-bold"
        style={{ color: style.colour }}
      >
        {style.mark}
      </span>
      <span className="sr-only">{claim.verdict}</span>
      <div className="min-w-0">
        <p style={{ color: "var(--text-2)" }}>
          <strong style={{ color: "var(--text-1)" }}>
            {describeValue(claim.value)}
          </strong>
          {" — "}
          {claim.source}
          <span style={{ color: "var(--text-4)" }}>
            {" "}(tier {claim.source_tier}
            {TIER_LABEL[claim.source_tier] ? `, ${TIER_LABEL[claim.source_tier]}` : ""})
          </span>
        </p>
        {claim.quote ? (
          <p className="italic mt-0.5" style={{ color: "var(--text-3)" }}>
            “{claim.quote}”
          </p>
        ) : null}
        <p className="font-mono text-[10px] mt-0.5" style={{ color: "var(--text-4)" }}>
          {/* claimed_at, not observed_at. Conflating them is what lets a stale
              article outrank a fresh club update. */}
          {claim.claimed_at ? `said ${claim.claimed_at}` : "no publication time"}
          {claim.beaten_by ? ` · beaten by ${claim.beaten_by}` : ""}
          {claim.url ? (
            <>
              {" · "}
              <a
                href={claim.url}
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: "var(--accent)" }}
              >
                source
              </a>
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}

function Entry({ entry }: { entry: EvidenceEntry }) {
  return (
    <div className="glass-inset p-3 space-y-1">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <p className="text-xs font-semibold" style={{ color: "var(--text-1)" }}>
          {entry.claim_type.replace(/_/g, " ")}
          {": "}
          <span className="font-mono">{describeValue(entry.resolved_value)}</span>
        </p>
        <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
          {entry.rule ? RULE_PROSE[entry.rule] ?? entry.rule : "no rule recorded"}
        </p>
      </div>

      {entry.escalation ? (
        <p
          className="text-xs"
          style={{ color: "var(--warning, #f59e0b)" }}
          data-testid="escalation"
        >
          Needs a human: {entry.escalation}
        </p>
      ) : null}

      {/* The losers are listed, not hidden behind a disclosure. That is the
          feature: an unopposed number and a contested one must not look alike. */}
      <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
        {entry.claims.map((claim) => (
          <ClaimRow key={`${claim.claim_id}-${claim.verdict}`} claim={claim} />
        ))}
      </ul>

      <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
        {entry.n_conflicts === 0
          ? "Unopposed — no other source has said anything about this."
          : `Survived ${entry.n_conflicts} conflicting claim${entry.n_conflicts === 1 ? "" : "s"}.`}
      </p>
    </div>
  );
}

function PlayerCard({ player }: { player: EvidencePlayer }) {
  return (
    <article className="card p-4 space-y-3" data-testid="evidence-player">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
          {player.player_name}
          {player.club ? (
            <span className="font-normal" style={{ color: "var(--text-3)" }}>
              {" "}· {player.club}
            </span>
          ) : null}
        </h3>
        {player.needs_attention ? (
          <span className="badge-amber text-[9px]">NEEDS A HUMAN</span>
        ) : null}
      </div>
      {player.entries.map((entry) => (
        <Entry key={entry.claim_type} entry={entry} />
      ))}
    </article>
  );
}

function EvidenceBody({ view }: { view: EvidenceView }) {
  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        {/* The honest denominator. Without it a short list is ambiguous between
            "little to report" and "the export broke". */}
        Showing {view.shown} player{view.shown === 1 ? "" : "s"} whose availability
        is in question, of {view.resolved} with claims on file.
        {view.escalations > 0
          ? ` ${view.escalations} need a human.`
          : " Everyone else has an uncontested, fully-available reading."}
      </p>
      {view.players.map((player) => (
        <PlayerCard key={player.element_id} player={player} />
      ))}
    </div>
  );
}

/**
 * The captured headlines.
 *
 * Everything above is resolved availability: claims the parser turned into a
 * value, with the rule that beat each loser. This is the residue — items the
 * parser refused to convert, because RSS prose cannot meet the
 * zero-false-positive bar R4 demands when a tier-2 claim can push availability
 * DOWN.
 *
 * Worth reading anyway. "Gudmundsson + Mukiele injury latest" tells a manager
 * something no availability field will, and until this section existed those
 * items went into a store nothing read.
 */
function CapturedHeadlines() {
  const { artifact } = useArtifact<NewsFeed>(NEWS_FEED);

  return (
    <Section
      title="From the feeds"
      subtitle="What the sources published, before any of it becomes a number"
      aside={<ProvenanceStrip of={artifact} />}
    >
      {/* The X lane is the one source with no automatic cadence: it needs a real
          browser, so it runs on demand rather than on the poller's fifteen
          minutes. The control lives here because this is where its output lands. */}
      <div className="mb-4">
        <XScanButton />
      </div>

      <WhenProven
        of={artifact}
        what="The poller has captured nothing in its window. It reads six feeds every fifteen minutes."
        then={(feed) => (
          <div className="space-y-3">
            {/* Verbatim from the artifact rather than paraphrased here: the
                producer states its own standing, and a page that restates it
                can drift from what the file actually claims. */}
            {feed.basis ? (
              <p className="text-xs" style={{ color: "var(--warning, #f59e0b)" }}>
                {feed.basis}
              </p>
            ) : null}

            <ul className="space-y-2" data-testid="headlines">
              {feed.items.map((item) => (
                <li key={item.digest} className="glass-inset p-3 space-y-1"
                    data-squad={item.touchesSquad ? "yes" : "no"}>
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <span className="text-[10px] uppercase tracking-wider"
                          style={{ color: "var(--text-4)" }}>
                      {item.source}
                      {item.tier !== null ? ` · tier ${item.tier}` : ""}
                    </span>
                    {item.touchesSquad ? (
                      <span className="badge-amber text-[9px]">IN YOUR SQUAD</span>
                    ) : null}
                  </div>
                  <p className="text-sm" style={{ color: "var(--text-1)" }}>
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer"
                         style={{ color: "inherit", textDecoration: "underline" }}>
                        {item.headline}
                      </a>
                    ) : item.headline}
                  </p>
                  {item.players.length > 0 ? (
                    <p className="text-xs" style={{ color: "var(--text-3)" }}>
                      {item.players
                        .map((p) => `${p.name ?? p.elementId}${p.club ? ` (${p.club})` : ""}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>

            {feed.nArticles > feed.nShown ? (
              <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
                Showing {feed.nShown} of {feed.nArticles} captured in the last{" "}
                {feed.windowDays ?? "few"} days.
              </p>
            ) : null}
          </div>
        )}
      />
    </Section>
  );
}

export default function EvidencePage() {
  const { artifact } = useArtifact<EvidenceView>(REGISTRY.evidence);

  return (
    <ErrorBoundary pageName="Evidence">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
          >
            Evidence
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Why each availability number is what it is — and what it beat
          </p>
        </header>

        <Section
          title="Contested availability"
          subtitle="Most disputed first. Every claim that lost is named, with the rule that beat it."
          aside={<ProvenanceStrip of={artifact} />}
        >
          <WhenProven
            of={artifact}
            what="Nobody's availability is in question. Every player with claims on file reads as fully available, from an uncontested source."
            then={(view) => <EvidenceBody view={view} />}
          />
        </Section>
      </div>
    </ErrorBoundary>
  );
}
