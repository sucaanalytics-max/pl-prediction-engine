/**
 * The squad section: one team's fifteen, or an honest account of why there are none.
 *
 * Only my own squad exists as an artifact. The two bots' squads live inside decision
 * files that have never been written, so focusing Ronny or Wazza here shows the same
 * `∅` and the same filename the Ledger's cells show — not my squad relabelled, which
 * would be the most misleading thing this page could do.
 */
import { SquadBoard } from "@/components/squad/SquadBoard";
import { Body, S, SectionLabel, Sub } from "@/components/control-room/parts";
import { Nil } from "@/components/margin/Marks";
import { ProvenanceMarks } from "@/components/margin/Provenance";
import { squadBoardPlayers } from "@/lib/control-room/squad";
import { TAIL_THRESHOLD, teamOf, type TeamKey } from "@/lib/control-room/model";
import type { SquadPlayer } from "@/lib/data/heuristics";
import type { Projection } from "@/lib/data/projections";

export function Squad({
  team, squad, projections, gameweek, squadAge, squadSource, botPath, initialising,
}: {
  team: TeamKey;
  squad: readonly SquadPlayer[] | null;
  projections: readonly Projection[] | null;
  gameweek: number | null;
  squadAge: string | null;
  squadSource: string | null;
  /** The decision artifact a bot's squad would come from, named even when absent. */
  botPath: string | null;
  initialising: boolean;
}) {
  const focused = teamOf(team);
  const board = squadBoardPlayers(squad, projections, gameweek);

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
        <div data-testid="squad-absent">
          <Nil surface={S} size={15} />
          <Body style={{ marginTop: 6 }}>
            {initialising
              ? `Reading ${botPath ?? "the decision artifact"}.`
              : `${focused.name} has proposed no squad, so there is nothing to lay out. `
                + `A bot squad is whatever its decision file sealed; this one has never `
                + `been written.`}
          </Body>
          <div style={{ marginTop: 4 }}>
            <Sub>{`${botPath ?? "no decision path"} · never written`}</Sub>
          </div>
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
          {squadSource !== null && (
            <div style={{ marginTop: 6 }}>
              <Sub>{squadSource}</Sub>
            </div>
          )}
        </>
      )}
    </section>
  );
}
