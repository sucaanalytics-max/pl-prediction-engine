"use client";

import { useArtifact } from "@/lib/data/useArtifact";
import { proven } from "@/lib/data/artifact";
import { MINUTES_CONFLICTS } from "@/lib/data/minutes-conflicts";
import { StateCard } from "@/components/data/Artifact";

/**
 * Projections our own evidence argues with.
 *
 * ## What this is for
 *
 * The case it was built from: our GW1 projection gave Gvardiol 14.3 expected
 * minutes and 0.78 xP, while a timestamped post in `x_inbox.csv` said he "played
 * full 90 - started LB". Both were in the repository; nothing put them on one page.
 * Reading only the projection benches a nailed-on starter, which on the real squad
 * was a ~3-point swing from one sentence.
 *
 * ## Why the quote is the content, not a tooltip
 *
 * A conflict list without its evidence is a second opinion — "trust this number
 * less" with nothing to check. The sentence and its link are what let a reader
 * resolve it in seconds, so they are rendered in full rather than hidden behind a
 * hover, and the model's number sits beside them so the disagreement is legible
 * without arithmetic.
 *
 * ## What it refuses to say
 *
 * Nothing here corrects a projection, and the copy says so. Turning "played full
 * 90 in a friendly" into an expected-minutes figure needs a fitted model of how
 * pre-season minutes predict competitive ones. It also does not claim an unflagged
 * player is verified: absence of a flag means nobody wrote about them, which is a
 * different fact from agreement, and the footer states that distinction because a
 * reader would otherwise reasonably assume the stronger one.
 */

const KIND_COPY: Record<string, { label: string; gist: string }> = {
  "fringe-but-discussed": {
    label: "model says fringe",
    gist: "the model expects little or no game time, yet a team-news writer is discussing them",
  },
  "nailed-but-doubted": {
    label: "model says nailed on",
    gist: "the model expects a full game, but the post carries injury or rotation language",
  },
};

export default function MinutesConflicts() {
  const { artifact } = useArtifact(MINUTES_CONFLICTS);
  const view = proven(artifact);

  // Absence never outweighs substance: one line, not a panel.
  if (!view) {
    return (
      <StateCard of={artifact} weight="line"
                 what="projections the evidence disagrees with" />
    );
  }

  if (view.conflicts.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-4)" }}>
        Checked every player the scan mentioned — no projection contradicts the
        evidence. That is a result, not an absence.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          {view.conflicts.length} projection
          {view.conflicts.length === 1 ? "" : "s"} our own scanned evidence argues
          with. Reported, never applied — read the quote and decide.
        </p>
        <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
          Flagged when the model expects under {view.fringeMinutes} minutes for a
          player somebody is writing about, or over {view.nailedMinutes} for one
          discussed with injury language.
        </p>
      </div>

      <ul className="space-y-3">
        {view.conflicts.map((c) => {
          const copy = KIND_COPY[c.kind];
          return (
            <li
              key={`${c.elementId}-${c.url}`}
              className="glass-panel rounded-xl p-4 space-y-2"
              data-testid="minutes-conflict"
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <p className="text-sm" style={{ color: "var(--text-1)" }}>
                  <strong>{c.player}</strong>
                  <span style={{ color: "var(--text-3)" }}>
                    {c.club ? ` · ${c.club}` : ""}
                  </span>
                </p>
                <p className="text-[10px] font-mono" style={{ color: "var(--text-4)" }}>
                  {copy?.label ?? c.kind}
                </p>
              </div>

              {/* The model's own numbers, so the gap is readable without maths. */}
              <p className="text-xs font-mono" style={{ color: "var(--text-3)" }}>
                {c.eMinutes.toFixed(0)} expected minutes · {c.xp.toFixed(2)} xP
              </p>

              {/* Verbatim. This is the content. */}
              <blockquote
                className="text-xs border-l-2 pl-3"
                style={{ color: "var(--text-2)", borderColor: "var(--border-strong)" }}
              >
                {c.quote}
              </blockquote>

              <p className="text-[10px] font-mono" style={{ color: "var(--text-4)" }}>
                {c.source}
                {c.claimedAt ? ` · ${c.claimedAt}` : ""}
                {" · "}
                <a href={c.url} target="_blank" rel="noopener noreferrer"
                   className="underline" style={{ color: "var(--accent)" }}>
                  read the post
                </a>
              </p>
              {copy ? (
                <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
                  {copy.gist}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {view.ambiguousSurnames.size > 0 ? (
        <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
          Refused rather than guessed: {[...view.ambiguousSurnames.keys()].join(", ")}
          {" "}— shared surnames that could be more than one player. 441 of 663
          surname keys are ambiguous, so a guess here would make every other line
          untrustworthy.
        </p>
      ) : null}

      <p className="text-[10px]" style={{ color: "var(--text-4)" }}>
        A player NOT listed here has not been verified — it means nobody in the
        scanned feeds wrote about them. Absence of a flag is absence of evidence,
        not agreement.
      </p>
    </div>
  );
}
