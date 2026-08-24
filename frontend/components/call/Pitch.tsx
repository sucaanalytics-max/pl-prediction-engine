"use client";

/**
 * The eleven, on a pitch, and the four who are not.
 *
 * Click a tile to bench a player or bring him back; every total on the screen
 * recomputes. That interaction is the reason this screen replaced a table: the
 * question a manager has before a deadline is not "what does the optimiser
 * think", it is "what happens if I do it my way instead", and a static list
 * cannot answer the second one.
 *
 * ## What a tile says, and in what order
 *
 * The ring is P(≥10) as a whole percent — the haul chance, which is the single
 * most decision-relevant number on a captaincy call and is otherwise buried in a
 * quantile. It is outlined rather than filled so it does not compete with the xP
 * beside it, and it brightens only past {@link HAUL_MARK}, because a ring that
 * always looks lit says nothing.
 *
 * The bar under the figures is the INTERQUARTILE range on a fixed 0–16 axis, with
 * the q10–q90 ends written beneath it. Fixed axis, so two tiles are comparable —
 * `lib/call/board.ts` explains why a per-player axis defeats the purpose.
 *
 * ## What it does not say
 *
 * Nothing here is a claim about a future gameweek. The fixture chip is this
 * week's opponent and FPL's rating of it; the xP is this week's projection. The
 * rail's horizon table is where later weeks live, and it shows per-player
 * projections rather than a lineup, because only this gameweek has been solved.
 */

import type { SquadRow } from "@/lib/margin/squad";
import { DISPLAY, FLOODLIT, MONO, SANS, difficultyTint } from "@/lib/margin/tokens";
import { EYEBROW } from "@/lib/margin/type";
import { byLine, intervalBar } from "@/lib/call/board";

const S = FLOODLIT;

/**
 * The haul chance at which the ring lights up.
 *
 * 15%: roughly one week in seven, which is the point at which a haul stops being
 * a tail you tolerate and becomes a reason to hold someone. Marked rather than
 * ranked, because a continuous colour on fifteen rings would be a second heat
 * scale competing with the horizon table's.
 */
export const HAUL_MARK = 0.15;

export type PitchMode = "xp" | "ownership";

function Ring({ haul }: { haul: number | null }) {
  const hot = haul !== null && haul >= HAUL_MARK;
  return (
    <span
      aria-hidden="true"
      style={{
        width: 20, height: 20, flexShrink: 0, borderRadius: "50%",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: MONO, fontSize: 9.5,
        border: `1.5px solid ${hot ? S.brand : "rgba(233,238,245,.22)"}`,
        color: hot ? S.brand : S.ink3,
      }}
    >
      {/* A dash, not a zero. An unpublished haul chance is not a zero chance. */}
      {haul === null ? "–" : Math.round(haul * 100)}
    </span>
  );
}

function FixtureChip({ row }: { row: SquadRow }) {
  const difficulty = row.player.difficulty ?? null;
  const [background, colour] = difficultyTint(difficulty);
  const label = row.player.fixture ?? row.player.fixtures?.[0]?.label ?? null;
  if (label === null) return null;
  return (
    <span
      title={difficulty === null
        ? `${label} — FPL published no difficulty for this fixture`
        : `${label} — FPL rates this fixture ${difficulty} of 5 for ${row.player.team}`}
      style={{
        // A club code is a word, not a figure, so it takes the body face — and
        // DM Mono ships no 600 to set it in anyway.
        fontFamily: SANS, fontSize: 9, fontWeight: 600, padding: "2px 5px",
        letterSpacing: ".02em", background, color: colour, whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function Tile({
  row, benched, isCaptain, mode, onToggle,
}: {
  readonly row: SquadRow;
  readonly benched: boolean;
  readonly isCaptain: boolean;
  readonly mode: PitchMode;
  readonly onToggle: () => void;
}) {
  const projection = row.projection;
  const bar = intervalBar(projection);
  const haul = projection?.pGe10 ?? null;
  const hot = haul !== null && haul >= HAUL_MARK;
  const ownership = row.player.ownership ?? null;

  const figure = mode === "xp"
    ? projection?.xp ?? null
    : ownership;

  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={benched ? "bench-tile" : "pitch-tile"}
      data-player={row.player.name}
      aria-label={`${benched ? "Start" : "Bench"} ${row.player.name}`}
      style={{
        width: benched ? 158 : 150,
        padding: "8px 9px 7px",
        textAlign: "left",
        background: benched ? "rgba(233,238,245,.03)" : S.bar,
        border: `1px solid ${isCaptain ? S.brand : S.hair}`,
        opacity: benched ? 0.72 : 1,
        cursor: "pointer",
        fontFamily: SANS,
        color: S.ink,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        <Ring haul={haul} />
        <span style={{
          fontWeight: 600, fontSize: 12, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis", flexGrow: 1,
        }}>
          {row.player.name}
        </span>
        {isCaptain ? (
          <span
            data-testid="captain-marker"
            title="Captain. His points are doubled; the armband tile shows both figures."
            style={{
              fontFamily: DISPLAY, fontSize: 10, color: S.shell,
              background: S.brand, padding: "0 4px", lineHeight: "14px",
            }}
          >
            C
          </span>
        ) : null}
      </span>

      <span style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
        <span style={{ fontFamily: DISPLAY, fontSize: 19, lineHeight: 1 }}>
          {figure === null
            ? "—"
            : mode === "xp" ? figure.toFixed(1) : `${figure.toFixed(0)}%`}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: S.ink3 }}>
          {projection?.eMinutes === null || projection?.eMinutes === undefined
            ? ""
            : `${projection.eMinutes.toFixed(0)}m`}
        </span>
        <span style={{ flexGrow: 1 }} />
        <FixtureChip row={row} />
      </span>

      {/* The interval, or nothing. A bar drawn without published quartiles would
          be a spread we do not have.

          `role="img"` with a spoken label, because this mark is the only thing on
          the screen that shows a projection as a SPREAD rather than a point, and
          it is worthless to a screen reader as a bare div. The label names the
          measured quantiles rather than a derived width: "±3.2" would be a
          symmetric interval, and these are not symmetric — the whole reason the
          bar is drawn off-centre. */}
      <span style={{
        display: "block", height: 3, marginTop: 6,
        background: bar === null ? "transparent" : "rgba(233,238,245,.09)",
      }}>
        {bar === null ? null : (
          <span
            role="img"
            aria-label={
              `${row.player.name}: median ${projection?.q50 ?? "unpublished"}, `
              + `middle half ${projection?.q25} to ${projection?.q75}, `
              + `q10 ${projection?.q10} to q90 ${projection?.q90}`
            }
            style={{
              display: "block", height: 3, marginLeft: `${bar.left}%`,
              width: `${bar.width}%`,
              background: hot ? S.brand : "rgba(233,238,245,.34)",
            }}
          />
        )}
      </span>

      <span style={{
        display: "flex", justifyContent: "space-between", marginTop: 4,
        fontFamily: MONO, fontSize: 9, color: S.ink3,
      }}>
        <span>
          {projection?.q10 === null || projection?.q10 === undefined
            || projection?.q90 === null || projection?.q90 === undefined
            ? "no interval"
            : `${projection.q10}–${projection.q90}`}
        </span>
        <span>{ownership === null ? "" : `${ownership.toFixed(0)}% own`}</span>
      </span>
    </button>
  );
}

export function Pitch({
  starters, bench, captainId, mode, onMode, onToggle,
}: {
  readonly starters: readonly SquadRow[];
  readonly bench: readonly SquadRow[];
  readonly captainId: number | null;
  readonly mode: PitchMode;
  readonly onMode: (mode: PitchMode) => void;
  readonly onToggle: (row: SquadRow) => void;
}) {
  const isCaptain = (row: SquadRow) =>
    captainId !== null && row.player.elementId === captainId;

  return (
    <section style={{ fontFamily: SANS, color: S.ink }}>
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
        padding: "10px 14px", background: S.bar,
        borderBottom: `1px solid ${S.hair}`,
      }}>
        <span style={{ ...EYEBROW, color: S.ink3 }}>The eleven</span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
          click a shirt to bench · totals recompute
        </span>
        <span style={{ flexGrow: 1 }} />
        <span style={{ display: "flex", border: `1px solid ${S.rule}` }}>
          {([["xp", "xP"], ["ownership", "ownership"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onMode(key)}
              aria-pressed={mode === key}
              style={{
                padding: "4px 9px", fontSize: 10.5,
                fontWeight: mode === key ? 600 : 400,
                background: mode === key ? "rgba(233,238,245,.10)" : "transparent",
                color: mode === key ? S.ink : S.ink3,
                borderRight: `1px solid ${S.rule}`, border: 0, cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      <div style={{
        background: S.pitch,
        padding: "22px 14px 16px",
        // A halfway line and faint bands, so the tiles read as a team rather than
        // a list. Decoration, and the only decoration on this screen.
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,.022) 0 1px, transparent 1px 100%)",
        backgroundSize: "100% 84px",
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
          {byLine(starters).map(([line, rows]) => (
            rows.length === 0 ? null : (
              <div
                key={line}
                data-testid="pitch-line"
                data-line={line}
                style={{ display: "flex", justifyContent: "center", gap: 11, flexWrap: "wrap" }}
              >
                {rows.map((row) => (
                  <Tile
                    key={row.player.elementId ?? row.player.name}
                    row={row}
                    benched={false}
                    isCaptain={isCaptain(row)}
                    mode={mode}
                    onToggle={() => onToggle(row)}
                  />
                ))}
              </div>
            )
          ))}
        </div>
      </div>

      <div style={{
        padding: "11px 14px", background: S.inset,
        borderTop: `1px solid ${S.rule}`,
      }}>
        <div style={{ ...EYEBROW, color: S.ink3, marginBottom: 9 }}>
          {/* NOT "autosub order", which the design called it. The order here is
              descending projection — the four the optimiser left out, best first.
              FPL's real autosub depends on who blanks and which formations stay
              legal after they do, and nothing here computes that. Naming it
              "autosub order" would claim a substitution sequence we have not
              solved. */}
          Bench · the four left out, best first
        </div>
        {bench.length === 0 ? (
          <p style={{ fontFamily: MONO, fontSize: 10, color: S.ink3, margin: 0 }}>
            Nobody is benched. Every player you own is in this eleven, which happens
            only when the squad is short of fifteen.
          </p>
        ) : (
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            {bench.map((row) => (
              <Tile
                key={row.player.elementId ?? row.player.name}
                row={row}
                benched
                isCaptain={false}
                mode={mode}
                onToggle={() => onToggle(row)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
