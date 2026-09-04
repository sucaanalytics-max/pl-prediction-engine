/**
 * Projections the evidence disagrees with.
 *
 * ## Why this is a screen and not a footnote
 *
 * On GW1 2026-27 our own projection gave Gvardiol 14.3 expected minutes and 0.78
 * xP — the model saying "will not play" — while `x_inbox.csv` held a timestamped,
 * attributed post reading "Gvardiol played full 90 - Gvardiol started LB". Both
 * facts were in the repository and nothing put them on the same page. A user
 * reading only the projection benches a nailed-on starter, and on the real squad
 * that was a ~3-point swing from one sentence.
 *
 * The distinction this surface must preserve is between three states that all look
 * the same on a projections table:
 *
 *   * **contradicted** — a player here, with a quote against the number,
 *   * **corroborated** — nothing to show, because the two agree,
 *   * **unexamined** — nothing to show, because nobody wrote about them.
 *
 * The last two are NOT the same, and conflating them is how a low projection with
 * no evidence either way gets treated as a verified low projection. Absence of a
 * flag is absence of evidence.
 *
 * ## It reports; it never corrects
 *
 * No number here overrides a projection, and the artifact says so in its own
 * `note` field. Turning "played full 90 in a friendly" into an expected-minutes
 * figure needs a fitted model of how pre-season minutes predict competitive ones.
 * So this renders the quote and its link, and the reader decides — the same bar
 * `/evidence` already holds for availability claims.
 */

import { malformed, narrowed, type NarrowResult } from "@/lib/data/artifact";
import {
  countOr0, isRecord, optNumber, optString, Problems, reqArray, reqRecord, reqString,
} from "@/lib/data/check";
import { DAY, type Descriptor } from "@/lib/data/registry";

/** Which way round the disagreement runs. */
export type ConflictKind = "fringe-but-discussed" | "nailed-but-doubted";

export interface MinutesConflict {
  readonly elementId: number;
  readonly player: string;
  readonly club: string;
  readonly kind: ConflictKind;
  /** What the model expects. Never derived from the quote. */
  readonly eMinutes: number;
  readonly xp: number;
  /** Distance from the threshold, which is how the producer ranked these. */
  readonly gap: number;
  /**
   * Fixtures of the player's OWN history behind the minutes estimate.
   *
   * 0 means prior-driven. `null` means the producing artifact predates the field —
   * NOT zero, because zero is a real answer and "unknown" must not be able to
   * masquerade as the most suspicious possible one.
   *
   * This is the difference between the two sentences a fringe row can be saying:
   * "the model has thirty fixtures saying he is fringe" is evidence against
   * evidence, and "the model has never seen him play" is evidence against an
   * assumption. Only the second is likely to be settled by reading the quote,
   * which is why the producer now ranks those first.
   */
  readonly evidenceFixtures: number | null;
  readonly source: string;
  readonly url: string;
  readonly claimedAt: string | null;
  /** Verbatim. A paraphrase would not be evidence. */
  readonly quote: string;
}

export interface MinutesConflicts {
  readonly generatedAt: string | null;
  readonly fringeMinutes: number;
  readonly nailedMinutes: number;
  readonly note: string | null;
  readonly conflicts: readonly MinutesConflict[];
  /**
   * Surnames the producer refused to resolve, and the ids each could have been.
   *
   * Surfaced rather than dropped because 441 of 663 surname keys are ambiguous —
   * six Wilsons. A reader seeing "wilson: 3 possibilities" can resolve it; a
   * matcher that guessed would make every other line untrustworthy.
   */
  readonly ambiguousSurnames: ReadonlyMap<string, readonly number[]>;
  /**
   * How fresh the claim feed behind all of this is.
   *
   * Read from the producer rather than derived from `conflicts`, because with an
   * empty conflict list there are no dates here at all — and that is exactly the
   * case that reads most wrongly. On 2026-09-04 the feed had been dead for 19
   * days (the launchd scan was not loaded, and X now refuses a logged-out
   * browser outright) while this section rendered fifteen August claims with no
   * indication of their age.
   */
  readonly evidenceFeed: {
    readonly newestClaimAt: string | null;
    /**
     * Inbox rows the producer considered, or **null when it did not say**.
     *
     * Absent and zero are different facts and call for opposite copy: an
     * artifact written before this field existed cannot support "nothing was
     * scanned", while `0` from a current producer is exactly that claim. The
     * producer always emits the key precisely so this stays distinguishable.
     */
    readonly rows: number | null;
  };
}

const KINDS: readonly ConflictKind[] = ["fringe-but-discussed", "nailed-but-doubted"];

function narrowConflict(raw: unknown): MinutesConflict | null {
  const problems = new Problems();
  const row = reqRecord(raw, "conflict", problems);
  if (!row) return null;

  const player = reqString(row.player, "player", problems);
  const kind = optString(row.kind);
  const eMinutes = optNumber(row.e_minutes);
  const url = optString(row.url);

  // A row missing any of these cannot do its job: without a player there is
  // nothing to name, without minutes there is no disagreement to state, and
  // without a URL the reader cannot check the claim — which is the whole point.
  if (player === null || eMinutes === null || !url) return null;
  if (kind === null || !KINDS.includes(kind as ConflictKind)) return null;

  return {
    elementId: optNumber(row.element_id) ?? 0,
    player,
    club: optString(row.club) ?? "",
    kind: kind as ConflictKind,
    eMinutes,
    xp: optNumber(row.xp) ?? 0,
    gap: optNumber(row.gap) ?? 0,
    // The producer writes -1 for "this artifact cannot tell you". Mapped to null
    // here so the type carries the distinction instead of a sentinel a renderer
    // could print.
    evidenceFixtures: ((v) => (v === null || v < 0 ? null : v))(
      optNumber(row.evidence_fixtures) ?? null,
    ),
    source: optString(row.source) ?? "",
    url,
    claimedAt: optString(row.claimed_at),
    quote: optString(row.quote) ?? "",
  };
}

export function narrowMinutesConflicts(raw: unknown): NarrowResult<MinutesConflicts> {
  const problems = new Problems();
  const file = reqRecord(raw, "minutes_conflicts", problems);
  if (!file) return malformed(problems.all);

  const rows = reqArray(file.conflicts, "conflicts", problems);
  if (!rows) return malformed(problems.all);

  const thresholds = reqRecord(file.thresholds, "thresholds", problems);
  if (!thresholds) return malformed(problems.all);

  // The thresholds are required, not defaulted. A conflict list is
  // uninterpretable without the line that produced it — "14 minutes" is only a
  // disagreement relative to a stated bar, and inventing 45 here would let a
  // producer change its mind without the page noticing.
  const fringeMinutes = optNumber(thresholds.fringe_minutes);
  const nailedMinutes = optNumber(thresholds.nailed_minutes);
  if (fringeMinutes === null || nailedMinutes === null) return malformed(problems.all);

  const ambiguous = new Map<string, readonly number[]>();
  const rawAmbiguous = file.ambiguous_surnames;
  if (rawAmbiguous && typeof rawAmbiguous === "object") {
    for (const [surname, ids] of Object.entries(rawAmbiguous)) {
      if (Array.isArray(ids)) {
        ambiguous.set(surname, ids.filter((n): n is number => typeof n === "number"));
      }
    }
  }

  return narrowed({
    generatedAt: optString(file.generated_at),
    fringeMinutes,
    nailedMinutes,
    note: optString(file.note),
    conflicts: rows
      .map(narrowConflict)
      .filter((c): c is MinutesConflict => c !== null),
    ambiguousSurnames: ambiguous,
    evidenceFeed: {
      newestClaimAt: isRecord(file.evidence_feed)
        ? optString(file.evidence_feed.newest_claim_at)
        : null,
      rows: isRecord(file.evidence_feed) ? countOr0(file.evidence_feed.rows) : null,
    },
  });
}

/**
 * The detector ran and found nothing to disagree with.
 *
 * A real and good state — every projection the scan touched was consistent — and
 * therefore declared rather than guessed, so the page can say "checked, no
 * disagreement" instead of rendering an absence.
 */
export function minutesConflictsAreEmpty(value: MinutesConflicts): boolean {
  return value.conflicts.length === 0;
}

/**
 * The conflicts touching a given set of players, widest disagreement first.
 *
 * KEPT DELIBERATELY, with no caller today. A dead-code sweep will find it again, so:
 * this is the join the control room's planned "your fifteen carry a disputed
 * projection" queue row is meant to call, and the surface-restructure review named it
 * specifically — "do not write a join, call the existing `conflictsForSquad`" — because
 * a second element-id filter would recreate the duplication that review cut. It is
 * keyed on `elementId` rather than a folded name, which is the whole point.
 *
 * Delete it only together with the plan that wants it.
 */
export function conflictsForSquad(
  value: MinutesConflicts,
  elementIds: readonly number[],
): readonly MinutesConflict[] {
  const wanted = new Set(elementIds);
  return value.conflicts.filter((c) => wanted.has(c.elementId));
}

/**
 * The conflicts for a gameweek.
 *
 * A factory, not a constant. The path was frozen at `gw01` while
 * `run_news.py:377` writes `minutes_conflicts_gw{gameweek:02d}.json` off the
 * live gameweek — so at the first deadline the poller would start writing gw02,
 * stop touching gw01, and all four consumers would keep fetching a file nobody
 * updates: current-looking conflicts for a day, then "out of date" for the rest
 * of the season.
 *
 * Never reachable before, because the artifact was never written at all — the
 * caller raised on every invocation and the broad `except` logged one line. It
 * became reachable the moment that was fixed, which is why a path frozen since
 * the file was created is only now a bug.
 */
export function minutesConflictsDescriptor(gameweek: number): Descriptor<MinutesConflicts> {
  const padded = String(gameweek).padStart(2, "0");
  return {
    ...MINUTES_CONFLICTS_SHAPE,
    // Scoped per gameweek, exactly as `projectionsDescriptor` and
    // `decisionDescriptor` scope theirs. `useArtifact` coalesces in-flight
    // fetches on `descriptor.key` alone — "identity, never its path" — so a
    // shared key across gameweeks serves one week's payload for another's.
    //
    // Observed in production: `MinutesConflicts` resolves its week as
    // `gameweek ?? shared ?? 1`, so a cold load starts a gw01 fetch under the
    // shared key; when the real week resolved to 3 the second call was handed
    // gw01's in-flight promise, and /evidence rendered GW1's conflicts under a
    // page header saying GW3.
    key: `minutesConflicts:${padded}`,
    path: `fpl/minutes_conflicts_gw${padded}.json`,
  };
}

/**
 * The gw01 descriptor, kept for the tests and tools that name it directly.
 *
 * Prefer `minutesConflictsDescriptor(gameweek)` in a component: this one is
 * correct only during the first gameweek.
 */
export const MINUTES_CONFLICTS: Descriptor<MinutesConflicts> = {
  key: "minutesConflicts",
  path: "fpl/minutes_conflicts_gw01.json",
  owner: "news",
  describes: "projections the scanned evidence disagrees with",
  // Rewritten on the 15-minute news tick, so a day-old copy means the poller has
  // stopped — the same budget its sibling artifacts use.
  freshnessBudgetMs: DAY,
  narrow: narrowMinutesConflicts,
  producedAtOf: (v) => v.generatedAt,
  isEmpty: minutesConflictsAreEmpty,
};

/** Everything but the path, which the factory supplies per gameweek. */
const MINUTES_CONFLICTS_SHAPE = MINUTES_CONFLICTS;
