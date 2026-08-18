"use client";

/**
 * The decision queue, and the change feed under it.
 *
 * ## The queue is read-only, and there is nothing to click
 *
 * §4: *"It is read-only. There are no approve / reject / defer controls anywhere on
 * this screen."* Acting on a proposal happens on the team's own screen. So the
 * queue is a list of claims with a tense and a provenance strip, and the only
 * interactive element on the whole board is the team switcher, which is
 * navigation.
 *
 * ## Tense: solid for fact, dashed for calendar
 *
 * The mark beside the index and the rule under the time are both drawn solid when
 * the thing has happened and dashed when it is merely scheduled, so a reader can
 * tell a fact from a diary entry without reading a word. It is the one grammar
 * this board repeats everywhere, including the matrix's future sub-lines.
 *
 * ## What is in it today, and why it is short
 *
 * Two rows, both sourced. The deadline is scheduled — `agent_status.json` carries
 * it — and Wazza's calibration caveat is standing: the field model has not held its
 * band, so the weekly objective borrows the season one. There is no proposal row
 * because neither bot has published a proposal, and the queue does not invent one
 * to have something to show. A quiet week is a short queue.
 *
 * ## The feed lists only what happened
 *
 * Never a non-event. "No new proposal" and "no median has moved" are not entries;
 * a quiet week shows fewer rows. When the delta feed carries nothing at all, one
 * quiet line names the poller's cadence — the sentence `/now` already uses — rather
 * than asserting that nothing changed, which the feed cannot know.
 */

import type { ReactNode } from "react";
import type { DeltaFeed } from "@/lib/data/narrow";
import type { Read } from "@/lib/control-room/read";
import { REQUIRED_CALIBRATED_GAMEWEEKS } from "@/lib/control-room/model";
import { ProvenanceMarks, type Anchor } from "@/components/margin/Provenance";
import { Answer, Body, Figure, Label, S, SectionLabel, Sub } from "@/components/control-room/parts";

export interface QueueRow {
  readonly id: string;
  /** Which team the claim is about. */
  readonly team: string;
  readonly claim: string;
  readonly reason: ReactNode;
  /** The right column's time. */
  readonly when: string;
  /** False when it has happened, true when it is merely on the calendar. */
  readonly scheduled: boolean;
  readonly anchor: Anchor;
  readonly freshness: string | null;
  readonly stale: boolean;
}

/** The 7×7 tense mark: solid ink if it happened, a dashed outline if it has not. */
function TenseMark({ scheduled }: { scheduled: boolean }) {
  return (
    <span
      aria-hidden
      title={scheduled ? "scheduled — this has not happened yet" : "this happened"}
      style={{
        display: "block", width: 7, height: 7, position: "relative", top: -2,
        ...(scheduled
          ? { border: `1px dashed ${S.rule}` }
          : { background: S.ink }),
      }}
    />
  );
}

export function Queue({ rows }: { rows: readonly QueueRow[] }) {
  return (
    <section className="mt-[30px] pt-[9px]" style={{ borderTop: `2px solid ${S.ink}` }}>
      <div className="flex items-baseline justify-between gap-4">
        <SectionLabel>Wants an answer from you</SectionLabel>
        <span className="inline-flex items-center gap-4">
          <span className="inline-flex items-center gap-[6px]">
            <span
              aria-hidden
              style={{ display: "block", width: 16, borderTop: `2px solid ${S.ink}` }}
            />
            <Sub>happened</Sub>
          </span>
          <span className="inline-flex items-center gap-[6px]">
            <span
              aria-hidden
              style={{ display: "block", width: 16, borderTop: `2px dashed ${S.rule}` }}
            />
            <Sub>scheduled</Sub>
          </span>
        </span>
      </div>

      {rows.map((row, i) => (
        <div
          key={row.id}
          data-testid={`queue-row-${row.id}`}
          className="grid items-baseline gap-[18px] py-[15px] grid-cols-[34px_104px_minmax(0,1fr)_148px]"
          style={{ borderBottom: `1px solid ${S.hair}` }}
        >
          <span className="flex items-baseline gap-[7px]">
            <TenseMark scheduled={row.scheduled} />
            {/* ink4 at 2.06:1, and one of that token's only two sanctioned uses:
                the index is an ordinal, not information. */}
            <Figure size={15} tone={S.ink4} style={{ fontWeight: 400 }}>
              {String(i + 1).padStart(2, "0")}
            </Figure>
          </span>
          <Label size={9.5} style={{ letterSpacing: ".12em" }}>{row.team}</Label>
          <div>
            <Answer size={22} style={{ lineHeight: 1.25 }}>{row.claim}</Answer>
            <Body size={12.5} style={{ marginTop: 6, maxWidth: 640 }}>
              {row.reason}
            </Body>
          </div>
          <div className="text-right">
            <Figure
              size={11}
              style={{
                display: "inline-block",
                fontWeight: 400,
                paddingBottom: 3,
                borderBottom: row.scheduled
                  ? `1px dashed ${S.rule}`
                  : `1px solid ${S.ink}`,
              }}
            >
              {row.when}
            </Figure>
            <div style={{ marginTop: 5 }}>
              <ProvenanceMarks
                anchor={row.anchor}
                freshness={row.freshness === null
                  ? null
                  : { label: row.freshness, stale: row.stale }}
                surface={S}
              />
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * The standing caveat's sentence, built from the counter rather than written out.
 *
 * It appears twice on the board — here and in the matrix's calibration cell — and
 * the number in it is read, so the two cannot drift apart.
 */
export function calibrationClaim(weeks: number | null): string {
  return weeks === null
    ? "The calibration counter is not published, so how many gameweeks the field "
      + "model has held its band is unknown. Until six are confirmed it runs "
      + "EV-optimal — Ronny's objective, with its own ownership read on top. A "
      + "caveat stated with confidence, not a fault."
    : `${weeks} of ${REQUIRED_CALIBRATED_GAMEWEEKS} gameweeks scored. Until the `
      + `sixth seals it runs EV-optimal — Ronny's objective, with its own ownership `
      + `read on top. A caveat stated with confidence, not a fault.`;
}

export function ChangeFeed({ feed }: { feed: Read<DeltaFeed> }) {
  const records = feed.value?.records ?? [];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Since you last looked</SectionLabel>
        {feed.age === null ? null : <Sub>{feed.age}</Sub>}
      </div>

      {records.length === 0 ? (
        // One line, in body type, no border and no panel. It states the poller's
        // cadence — a fact — rather than "nothing changed", which a feed of
        // recorded events is not in a position to claim.
        <Body size={13} style={{ marginTop: 10, maxWidth: 640 }}>
          {feed.initialising
            ? "Reading the change feed."
            : "Nothing has been recorded here. The news poller writes a row every "
              + "time an availability claim moves a projection, and it runs every "
              + "fifteen minutes during a press-conference or deadline window."}
        </Body>
      ) : (
        records.slice(0, 6).map((record) => (
          <div
            key={record.delta_id + record.kind}
            className="grid items-baseline gap-[14px] py-[10px] grid-cols-[minmax(0,1fr)_104px]"
            style={{ borderBottom: `1px solid ${S.hair}` }}
          >
            <div>
              <Body size={13} tone={S.ink}>
                {record.kind === "resolution_change"
                  ? `${record.player_name ?? "A player"} — ${record.claim_type ?? "claim"} changed`
                  : `${record.entry_label ?? "An entry"} — ${
                    record.flipped ? "the recommended move changed" : "the plan was re-scored"
                  }`}
              </Body>
              <Body size={11.5} tone={S.ink3} style={{ marginTop: 3 }}>
                {record.why_material
                  ?? (record.root_move_before === null
                    ? record.trigger?.source ?? ""
                    : `${record.root_move_before} → ${record.root_move_after ?? "?"}`)}
              </Body>
            </div>
            <div className="text-right">
              <Figure size={11} tone={S.ink2} style={{ fontWeight: 400 }}>
                {record.observed_at === null ? "—" : record.observed_at.slice(11, 16)}
              </Figure>
              <div style={{ marginTop: 2 }}>
                <ProvenanceMarks
                  anchor={record.trigger === null ? "model" : "external"}
                  surface={S}
                />
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
