/**
 * The squad section: one team's fifteen, or an honest account of why there are none.
 *
 * Only my own squad exists as an artifact. The two bots' squads live inside decision
 * files that have never been written, so focusing Ronny or Wazza here shows the same
 * `∅` and the same filename the Ledger's cells show — not my squad relabelled, which
 * would be the most misleading thing this page could do.
 */
import { SquadBoard } from "@/components/squad/SquadBoard";
import {
  Body, NotPublished, S, SectionLabel, Sub,
} from "@/components/control-room/parts";
import { Nil } from "@/components/margin/Marks";
import { ProvenanceMarks } from "@/components/margin/Provenance";
import { squadBoardPlayers } from "@/lib/control-room/squad";
import { TAIL_THRESHOLD, teamOf, type TeamKey } from "@/lib/control-room/model";
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";

export function Squad({
  team, squad, projections, gameweek, squadAge, squadSource, notices, botPath,
  initialising,
}: {
  team: TeamKey;
  squad: readonly SquadPlayer[] | null;
  projections: readonly Projection[] | null;
  gameweek: number | null;
  squadAge: string | null;
  squadSource: string | null;
  /**
   * The route's own sentences about where this squad came from.
   *
   * Rendered here because this is where the squad is: when FPL answers without returning
   * a fifteen-player squad the app falls back to the captured draft, and the sentence
   * saying so has to sit beside the fifteen it is about.
   */
  notices: readonly string[];
  /** The decision artifact a bot's squad would come from, named even when absent. */
  botPath: string | null;
  initialising: boolean;
}) {
  const focused = teamOf(team);
  /**
   * Gated on the WEEK, not on whether the fetch succeeded.
   *
   * The projections descriptor falls back to week 1's path so that a hook is never
   * called conditionally. That makes a readable artifact no evidence at all that it
   * is THIS week's: with the week unresolved, pairing those numbers with my fifteen
   * would put a stranger's projection beside my squad and sum it into a band total.
   *
   * The squad itself is week-independent, so the rows and the formation still lay
   * out. Only the numbers refuse.
   */
  const board = squadBoardPlayers(
    squad, gameweek === null ? null : projections, gameweek,
  );

  return (
    <section
      data-testid="squad-section"
      className="mt-[26px] pt-[9px]"
      style={{ borderTop: `1px solid ${S.rule}` }}
    >
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "baseline",
        paddingBottom: 6,
      }}>
        <SectionLabel>{`${focused.name} · squad`}</SectionLabel>
        {board.players.length > 0 && (
          <ProvenanceMarks
            surface={S}
            // The squad is a capture of what the FPL UI displayed, not a model
            // output: an external reading, which is the fourth anchor.
            anchor="external"
            freshness={squadAge === null ? null : { label: squadAge, stale: false }}
          />
        )}
      </div>

      {focused.kind === "bot" ? (
        // The same three lines the matrix draws for an unwritten file, from one place.
        <div data-testid="squad-absent">
          <NotPublished
            initialising={initialising}
            path={botPath ?? "the decision artifact"}
            what={`${focused.name} has proposed no squad, so there is nothing to lay out. `
              + `A bot squad is whatever its decision file sealed; this one has never `
              + `been written.`}
          />
        </div>
      ) : board.players.length === 0 ? (
        <div data-testid="squad-absent">
          <Nil surface={S} size={15} />
          <Body style={{ marginTop: 6 }}>
            {initialising
              ? "Reading the squad."
              : "No squad was read, so there are no rows. The board shows what the "
                + "capture holds; it does not assemble a plausible fifteen."}
          </Body>
        </div>
      ) : (
        <>
          <SquadBoard
            players={board.players}
            surface={S}
            thresholdLabel={`P(GW ≥ ${TAIL_THRESHOLD})`}
          />
          {board.unplaced.length > 0 && (
            <div style={{ marginTop: 6 }} data-testid="squad-unplaced">
              <Sub>
                {`not banded, position unstated: ${board.unplaced.join(", ")}`}
              </Sub>
            </div>
          )}
          {/*
            * The count, so silence is readable.
            *
            * A row marks a flagged player, but no marks at all is ambiguous between
            * "checked, none flagged" and "never checked" — the same absence-versus-zero
            * confusion the Nil glyph exists to prevent. One line resolves it, and it
            * costs nothing when the answer is none. Counted from the fifteen, never
            * typed.
            */}
          <div style={{ marginTop: 6 }} data-testid="availability-read">
            <Sub>
              {(() => {
                const stated = board.players.filter(
                  (p) => p.chanceOfPlaying !== undefined || p.news !== undefined,
                );
                if (stated.length === 0) {
                  return "availability was not stated for this squad";
                }
                const out = stated.filter((p) => p.chanceOfPlaying === 0).length;
                const doubt = stated.filter(
                  (p) => typeof p.chanceOfPlaying === "number" && p.chanceOfPlaying > 0
                    && p.chanceOfPlaying < 100,
                ).length;
                const noted = stated.filter(
                  (p) => (p.news ?? "") !== "" && p.chanceOfPlaying === null,
                ).length;
                const flagged = out + doubt + noted;
                return `availability read with the squad · ${flagged} of ${stated.length} `
                  + `flagged${doubt > 0 ? `, ${doubt} carrying a doubt` : ""}`;
              })()}
            </Sub>
          </div>

          {squadSource !== null && (
            <div style={{ marginTop: 6 }}>
              <Sub>{squadSource}</Sub>
            </div>
          )}
          {notices.length > 0 && (
            <div style={{ marginTop: 4 }} data-testid="squad-notices">
              {notices.map((notice) => (
                <div key={notice}><Sub>{notice}</Sub></div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
