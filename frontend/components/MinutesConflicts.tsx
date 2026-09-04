"use client";

import { useArtifact } from "@/lib/data/useArtifact";
import { proven } from "@/lib/data/artifact";
import { minutesConflictsDescriptor } from "@/lib/data/minutes-conflicts";
import { useCurrentGameweek } from "@/lib/data/gameweek";
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

/**
 * The gameweek is resolved here rather than defaulted.
 *
 * The first version took `gameweek = 1`, which read as a safe default and was
 * not one: `/evidence` mounts this with no prop, so from GW2 it would have gone
 * on fetching gw01 — the exact defect the descriptor factory was introduced to
 * fix, surviving in the one caller that had no gameweek to pass.
 *
 * It resolves through {@link useCurrentGameweek}, the one shared resolver, rather
 * than re-deriving the week here. The local version read `agent_status.json` and
 * then fell back to 1, which differed from the shared resolver twice over: it
 * never consulted FPL's own `event.id`, and it substituted week 1 where the shared
 * resolver returns null. Two resolvers that disagree do not mislabel a figure —
 * the number becomes a fetch path, so they read different files.
 *
 * Costs nothing extra: `agent_status.json` and `/api/fpl/state` are both
 * coalesced, so this consumer shares whatever request is already in the air.
 *
 * The prop stays as an override for callers that already know. The `?? 1` stays at
 * this call site, where it is visible, because a descriptor is required and week
 * 1's path is the one that exists — not because 1 is a sensible default for a week.
 */
/**
 * How stale a claim feed may be before saying so.
 *
 * Seven days, because the scan is designed to run twice daily and
 * `X_SCAN_MAX_AGE_DAYS` is 3 — so a newest claim a week old means the scan has
 * missed roughly a dozen runs, not that the news was quiet.
 */
const STALE_AFTER_DAYS = 7;

/** Whole days since an ISO stamp, or null if it is absent or unparseable. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.floor((Date.now() - at) / 86_400_000);
}

/**
 * The line that stops a dead feed reading as a clean bill of health.
 *
 * Renders nothing when the feed is current, because a healthy feed needs no
 * commentary and a permanent banner is a banner nobody reads.
 */
function FeedStaleness({
  newestClaimAt, rows,
}: {
  newestClaimAt: string | null;
  rows: number | null;
}) {
  const age = daysSince(newestClaimAt);

  // Null means the producer never reported, which is not evidence of an empty
  // feed — an artifact predating the field would otherwise be accused of one.
  if (rows === null) return null;

  if (rows === 0 || newestClaimAt === null) {
    return (
      <p
        data-testid="feed-staleness"
        className="text-xs"
        style={{ color: "var(--warning)" }}
      >
        <strong>No claims have been scanned.</strong> This section compares the
        minutes model against scanned evidence, and there is none on file — so
        silence here is a gap in the feed, not agreement about who plays.
      </p>
    );
  }

  if (age === null || age < STALE_AFTER_DAYS) return null;

  return (
    <p
      data-testid="feed-staleness"
      className="text-xs"
      style={{ color: "var(--warning)" }}
    >
      <strong>The evidence is stale.</strong> The newest scanned claim is from{" "}
      {newestClaimAt.slice(0, 10)} — {age} days old, across {rows}{" "}
      {rows === 1 ? "row" : "rows"}. A short list here means the scan has stopped,
      not that the minutes model is right.
    </p>
  );
}

export default function MinutesConflicts({ gameweek }: { gameweek?: number } = {}) {
  // Called unconditionally: `gameweek ?? useCurrentGameweek()` short-circuits, which
  // skips the hook whenever the prop is supplied and breaks hook order.
  const shared = useCurrentGameweek();
  const resolved = gameweek ?? shared ?? 1;
  const { artifact } = useArtifact(minutesConflictsDescriptor(resolved));
  const view = proven(artifact);

  // Absence never outweighs substance: one line, not a panel.
  if (!view) {
    return (
      <StateCard of={artifact} weight="line"
                 what="projections the evidence disagrees with" />
    );
  }

  if (view.conflicts.length === 0) {
    const age = daysSince(view.evidenceFeed.newestClaimAt);
    const feedUsable =
      view.evidenceFeed.rows === null
      || (view.evidenceFeed.rows > 0
          && view.evidenceFeed.newestClaimAt !== null
          && age !== null
          && age < STALE_AFTER_DAYS);

    // "That is a result, not an absence" is only true when there was evidence to
    // contradict. With a dead feed it is the opposite of true, and it is the most
    // reassuring sentence on the page.
    return feedUsable ? (
      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        Checked every player the scan mentioned — no projection contradicts the
        evidence. That is a result, not an absence.
      </p>
    ) : (
      <FeedStaleness
        newestClaimAt={view.evidenceFeed.newestClaimAt}
        rows={view.evidenceFeed.rows}
      />
    );
  }

  return (
    <div className="space-y-4">
      <FeedStaleness
        newestClaimAt={view.evidenceFeed.newestClaimAt}
        rows={view.evidenceFeed.rows}
      />
      <div className="space-y-1">
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          {view.conflicts.length} projection
          {view.conflicts.length === 1 ? "" : "s"} our own scanned evidence argues
          with. Reported, never applied — read the quote and decide.
        </p>
        <p className="text-[11px]" style={{ color: "var(--text-3)" }}>
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
              className="glass-panel rounded-none p-4 space-y-2"
              data-testid="minutes-conflict"
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <p className="text-sm" style={{ color: "var(--text-1)" }}>
                  <strong>{c.player}</strong>
                  <span style={{ color: "var(--text-3)" }}>
                    {c.club ? ` · ${c.club}` : ""}
                  </span>
                </p>
                <p className="text-[11px] font-mono" style={{ color: "var(--text-3)" }}>
                  {copy?.label ?? c.kind}
                </p>
              </div>

              {/* The model's own numbers, so the gap is readable without maths.
                  `evidenceFixtures` is the one that changes what a reader should DO:
                  "0 fixtures" says the estimate is last season mean-reverted forward
                  and one quote can settle it, which is the module's opening case.
                  "31 fixtures" says the model has watched him and the quote has to
                  beat real evidence. Null when the artifact predates the field — the
                  line simply omits it rather than printing a zero it cannot stand
                  behind. */}
              <p className="text-xs font-mono" style={{ color: "var(--text-3)" }}>
                {c.eMinutes.toFixed(0)} expected minutes · {c.xp.toFixed(2)} xP
                {c.evidenceFixtures === null ? null : (
                  <span
                    title={
                      c.evidenceFixtures === 0
                        ? "No fixtures of his own behind that estimate — it is prior-driven"
                        : `${c.evidenceFixtures} of his own fixtures behind that estimate`
                    }
                  >
                    {" · "}
                    {c.evidenceFixtures === 0
                      ? "prior only"
                      : `${c.evidenceFixtures} fixtures of evidence`}
                  </span>
                )}
              </p>

              {/* Verbatim. This is the content. */}
              <blockquote
                className="text-xs border-l-2 pl-3"
                style={{ color: "var(--text-2)", borderColor: "var(--border-strong)" }}
              >
                {c.quote}
              </blockquote>

              <p className="text-[11px] font-mono" style={{ color: "var(--text-3)" }}>
                {c.source}
                {c.claimedAt ? ` · ${c.claimedAt}` : ""}
                {" · "}
                <a href={c.url} target="_blank" rel="noopener noreferrer"
                   className="underline" style={{ color: "var(--brand)" }}>
                  read the post
                </a>
              </p>
              {copy ? (
                <p className="text-[11px]" style={{ color: "var(--text-3)" }}>
                  {copy.gist}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {view.ambiguousSurnames.size > 0 ? (
        <p className="text-[11px]" style={{ color: "var(--text-3)" }}>
          Refused rather than guessed: {[...view.ambiguousSurnames.keys()].join(", ")}
          {" "}— shared surnames that could be more than one player. 441 of 663
          surname keys are ambiguous, so a guess here would make every other line
          untrustworthy.
        </p>
      ) : null}

      <p className="text-[11px]" style={{ color: "var(--text-3)" }}>
        A player NOT listed here has not been verified — it means nobody in the
        scanned feeds wrote about them. Absence of a flag is absence of evidence,
        not agreement.
      </p>
    </div>
  );
}
