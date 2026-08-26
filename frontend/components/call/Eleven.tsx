"use client";

/**
 * The eleven as a sortable table — the default view of the call screen.
 *
 * ## Why a table beat the pitch
 *
 * A design council of seven lenses reviewed four candidate directions for this
 * screen. Five of them independently put a dense sortable table first, for five
 * unrelated reasons: it is the only layout that puts every figure on POSITION,
 * the strongest perceptual channel for comparison; it survives being operated at
 * speed; it matches the spreadsheet a real manager already keeps; it is calm
 * where a big number is loud; and it reuses the grammar `HeatGrid` already proves
 * at 609 rows, so the app keeps one visual vocabulary instead of one per screen.
 *
 * The pitch is still here, one toggle away. It answers a real question — what
 * shape am I playing — in a way no table does. It is simply not the question
 * asked most often, and it cannot be sorted, which is the operation this screen
 * exists for.
 *
 * ## What the table refused to give up
 *
 * Every one of the four candidate directions quietly deleted the per-player
 * interval bar and left a bare point estimate. That is the deletion that looks
 * like tidying and is not: a mean without its spread cannot answer the question
 * fantasy football actually turns on, which is not "how many points" but "how
 * wide is the range, and is this captain's tail worth the downside". The bar is
 * on every row here, on a fixed 0–16 axis so two rows compare — and on the bench
 * rows too, because a bench player's spread is exactly what decides whether he is
 * worth starting.
 *
 * ## The fixture rating is a number now
 *
 * It used to live only in a `title` attribute, which means it did not exist on a
 * phone, for a keyboard, or for a screen reader — leaving the chip's COLOUR as
 * the only carrier of a five-band quantity, and colour is the channel that
 * collapses under red-green colour blindness. The digit is in the chip.
 */

import { useMemo, useState } from "react";

import type { SquadPlayer } from "@/lib/data/heuristics";
import type { SquadRow } from "@/lib/margin/squad";
import { DISPLAY, FLOODLIT, MONO, SANS, difficultyTint } from "@/lib/margin/tokens";
import { kitFor, kitStripe } from "@/lib/margin/kits";
import { EYEBROW } from "@/lib/margin/type";
import { INTERVAL_AXIS, intervalBar } from "@/lib/call/board";
import { HAUL_MARK } from "@/components/call/Pitch";

const S = FLOODLIT;

/** The line order a squad is read in. Also the default sort. */
const LINE_ORDER: Record<string, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

export type SortKey = "line" | "xp" | "minutes" | "fdr" | "ownership" | "haul";

interface Column {
  readonly key: SortKey;
  readonly label: string;
  readonly title: string;
  /** Ascending for a cost, descending for a return. */
  readonly ascending?: boolean;
}

/**
 * The sortable columns.
 *
 * `line` is a sort, not a metric — the council asked for position grouping as a
 * mode rather than a separate screen, because comparing a defender to other
 * defenders is usually the FPL-relevant comparison and comparing him to a
 * striker is usually not.
 */
const COLUMNS: readonly Column[] = [
  // Ascending, or "keepers first" reads as forwards first — GKP is 0 in
  // LINE_ORDER and the default direction is descending, which inverted a squad.
  { key: "line", label: "Pos", title: "Group by position, keepers first", ascending: true },
  { key: "xp", label: "xP", title: "Projected points this gameweek" },
  { key: "haul", label: "P10", title: "Chance of ten or more points" },
  { key: "minutes", label: "Mins", title: "Expected minutes" },
  { key: "fdr", label: "Fix", title: "This week's fixture and FPL's 1–5 rating", ascending: true },
  { key: "ownership", label: "Own", title: "Percent of managers who own him" },
];

const valueOf = (row: SquadRow, key: SortKey): number | null => {
  switch (key) {
    case "line": return LINE_ORDER[row.player.position.toUpperCase()] ?? 9;
    case "xp": return row.projection?.xp ?? null;
    case "haul": return row.projection?.pGe10 ?? null;
    case "minutes": return row.projection?.eMinutes ?? null;
    case "fdr": return row.player.difficulty ?? null;
    case "ownership": return row.player.ownership ?? null;
  }
};

/**
 * Sorted, with nulls always last.
 *
 * A player with no published figure is not the worst player; he is a player the
 * file says nothing about, and sinking him to the bottom of a descending list
 * says the first thing. Ties inside a position break on projection so the order
 * is stable and meaningful rather than incidental.
 */
function sortRows(rows: readonly SquadRow[], key: SortKey): SquadRow[] {
  const ascending = COLUMNS.find((c) => c.key === key)?.ascending ?? false;
  return rows.slice().sort((a, b) => {
    const [x, y] = [valueOf(a, key), valueOf(b, key)];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (x !== y) return ascending ? x - y : y - x;
    return (b.projection?.xp ?? -Infinity) - (a.projection?.xp ?? -Infinity);
  });
}

function Figure({ value, places = 1, dim }: {
  readonly value: number | null;
  readonly places?: number;
  readonly dim?: boolean;
}) {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 11.5,
      color: value === null ? S.ink3 : dim ? S.ink3 : S.ink2,
    }}>
      {/* A dash, never a zero: unpublished and nought are different claims. */}
      {value === null ? "—" : value.toFixed(places)}
    </span>
  );
}

function FixtureCell({ row }: { readonly row: SquadRow }) {
  const difficulty = row.player.difficulty ?? null;
  const [background, colour] = difficultyTint(difficulty);
  const label = row.player.fixture ?? row.player.fixtures?.[0]?.label ?? null;
  if (label === null) {
    return <span style={{ fontFamily: MONO, fontSize: 11, color: S.ink3 }}>—</span>;
  }
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 5px", background, color: colour, whiteSpace: "nowrap",
    }}>
      <span style={{ fontFamily: SANS, fontSize: 9.5, fontWeight: 600, letterSpacing: ".02em" }}>
        {label}
      </span>
      {/* The rating, visible. It lived in a tooltip, which is no place for a
          five-band quantity on a screen used on a phone. */}
      <span style={{ fontFamily: MONO, fontSize: 9.5, opacity: 0.85 }}>
        {difficulty === null ? "·" : difficulty}
      </span>
    </span>
  );
}

function Interval({ row }: { readonly row: SquadRow }) {
  const bar = intervalBar(row.projection);
  const haul = row.projection?.pGe10 ?? null;
  const hot = haul !== null && haul >= HAUL_MARK;
  const p = row.projection;

  if (bar === null) {
    return (
      <span style={{ fontFamily: MONO, fontSize: 9.5, color: S.ink3 }}>
        no interval
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={
        `${row.player.name}: median ${p?.q50 ?? "unpublished"}, `
        + `middle half ${p?.q25} to ${p?.q75}, q10 ${p?.q10} to q90 ${p?.q90}`
      }
      title={`q10 ${p?.q10} · q25 ${p?.q25} · median ${p?.q50} · q75 ${p?.q75} · q90 ${p?.q90}`}
      style={{ display: "block", height: 4, background: "rgba(233,238,245,.09)" }}
    >
      <span style={{
        display: "block", height: 4, marginLeft: `${bar.left}%`, width: `${bar.width}%`,
        background: hot ? S.brand : "rgba(233,238,245,.34)",
      }} />
    </span>
  );
}

export interface ElevenProps {
  readonly starters: readonly SquadRow[];
  readonly bench: readonly SquadRow[];
  readonly captainId: number | null;
  /** Players to start who are currently benched on FPL. */
  readonly bringIn: readonly SquadPlayer[];
  /** Players FPL has starting who are not in this eleven. */
  readonly sitDown: readonly SquadPlayer[];
  readonly onToggle: (row: SquadRow) => void;
}

/** `196px` mirrors HeatGrid's player column, so the two screens line up. */
const TEMPLATE = "20px 34px minmax(0,1fr) 52px 40px 44px 116px 74px 46px";

export function Eleven(props: ElevenProps) {
  const { starters, bench, captainId, bringIn, sitDown, onToggle } = props;
  const [sort, setSort] = useState<SortKey>("line");

  const inSet = useMemo(() => new Set(bringIn), [bringIn]);
  const outSet = useMemo(() => new Set(sitDown), [sitDown]);

  const sorted = useMemo(() => sortRows(starters, sort), [starters, sort]);
  const benchSorted = useMemo(() => sortRows(bench, sort === "line" ? "xp" : sort),
    [bench, sort]);

  const header = (
    <div
      role="row"
      style={{
        display: "grid", gridTemplateColumns: TEMPLATE, alignItems: "center",
        background: S.bar, borderBottom: `1px solid ${S.rule}`, height: 30,
      }}
    >
      <span />
      {COLUMNS.map((column, index) => {
        const live = sort === column.key;
        // Name and interval sit between Pos and xP; they are not sortable, so
        // they are laid in as static cells rather than buttons.
        const cell = (
          <button
            key={column.key}
            type="button"
            onClick={() => setSort(column.key)}
            title={column.title}
            aria-pressed={live}
            style={{
              ...EYEBROW,
              color: live ? S.ink : S.ink3,
              background: live ? "rgba(233,238,245,.06)" : "none",
              border: 0, cursor: "pointer", height: 30, padding: "0 6px",
              textAlign: column.key === "line" ? "left" : "right",
            }}
          >
            {column.label}
          </button>
        );
        if (index === 0) {
          return (
            <span key="lead" style={{ display: "contents" }}>
              {cell}
              <span style={{ ...EYEBROW, color: S.ink3, padding: "0 6px" }}>Player</span>
            </span>
          );
        }
        // After `Mins`, not after `xP`. The interval bar is the SEVENTH grid slot
        // — the 116px one — because TEMPLATE lays a row out as
        // blank · pos · name · xp · p10 · mins · interval · fix · own. Emitting
        // this static label after COLUMNS[1] put it in the 40px P10 slot and
        // shifted `P10` and `Mins` one column right each, so the header read
        // `q25–q75` over the haul chance, `P10` over the minutes, and `Mins` over
        // the bar. Shipped, and worse than cosmetic: Raya rendered under `P10` as
        // "70", which is his expected minutes, against a real haul chance of 1%.
        // The sort keys were never wrong — only the labels moved — which is
        // exactly why every test stayed green.
        if (index === 3) {
          return (
            <span key="mins-and-interval" style={{ display: "contents" }}>
              {cell}
              <span style={{ ...EYEBROW, color: S.ink3, padding: "0 6px", textAlign: "center" }}>
                q25–q75
              </span>
            </span>
          );
        }
        return cell;
      })}
    </div>
  );

  const line = (row: SquadRow, benched: boolean) => {
    const isCaptain = captainId !== null && row.player.elementId === captainId;
    const coming = inSet.has(row.player);
    const going = outSet.has(row.player);
    const haul = row.projection?.pGe10 ?? null;
    const kit = kitFor(row.player.team);
    const clubRule = kit ? kitStripe(kit) : null;

    return (
      <button
        key={row.player.elementId ?? row.player.name}
        type="button"
        onClick={() => onToggle(row)}
        data-testid={benched ? "eleven-bench-row" : "eleven-row"}
        className="dense-row"
        data-player={row.player.name}
        data-swap={coming ? "in" : going ? "out" : undefined}
        aria-label={`${benched ? "Start" : "Bench"} ${row.player.name}`}
        style={{
          display: "grid", gridTemplateColumns: TEMPLATE, alignItems: "center",
          width: "100%", height: 34, padding: 0, textAlign: "left",
          background: coming
            ? "rgba(120,220,140,.07)"
            : going ? "rgba(255,90,70,.07)" : "transparent",
          // A 3px club rule at the leading edge. `kitStripe` rather than
          // `kitBackground` because a 3px-repeat stripe inside a 3px bar renders
          // as one arbitrary colour, so a striped club would read as a plain one
          // — and as a different plain one depending on rounding. Painted as a
          // background image rather than a border so a two-tone club keeps both
          // colours; a border cannot hold a gradient.
          backgroundImage: clubRule ?? undefined,
          backgroundSize: "3px 100%",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "left center",
          border: 0, borderBottom: `1px solid ${S.hair}`,
          cursor: "pointer", opacity: benched ? 0.72 : 1,
          fontFamily: SANS, color: S.ink,
        }}
      >
        {/* The swap mark. A shape and a letter, not a colour alone — the tint
            behind the row is reinforcement, never the sole carrier. */}
        <span style={{
          fontFamily: MONO, fontSize: 9, textAlign: "center",
          color: coming ? S.agree : going ? S.conflict : "transparent",
        }}>
          {coming ? "▲" : going ? "▼" : ""}
        </span>

        <span style={{
          fontFamily: MONO, fontSize: 9.5, color: S.ink3, padding: "0 6px",
          letterSpacing: ".04em",
        }}>
          {row.player.position.toUpperCase()}
        </span>

        <span style={{
          display: "flex", alignItems: "center", gap: 6, padding: "0 6px", minWidth: 0,
        }}>
          <span style={{
            fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis",
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

        <span style={{ textAlign: "right", padding: "0 6px" }}>
          <span style={{
            fontFamily: MONO, fontSize: 12.5, fontWeight: 500,
            color: row.projection?.xp == null ? S.ink3 : S.ink,
          }}>
            {row.projection?.xp == null ? "—" : row.projection.xp.toFixed(2)}
          </span>
        </span>

        <span style={{ textAlign: "right", padding: "0 6px" }}>
          <span style={{
            fontFamily: MONO, fontSize: 11,
            color: haul === null ? S.ink3 : haul >= HAUL_MARK ? S.brand : S.ink3,
          }}>
            {haul === null ? "—" : `${Math.round(haul * 100)}`}
          </span>
        </span>

        <span style={{ textAlign: "right", padding: "0 6px" }}>
          <Figure value={row.projection?.eMinutes ?? null} places={0} dim />
        </span>

        <span style={{ padding: "0 6px" }}>
          <Interval row={row} />
        </span>

        <span style={{ textAlign: "right", padding: "0 6px" }}>
          <FixtureCell row={row} />
        </span>

        <span style={{ textAlign: "right", padding: "0 6px" }}>
          <Figure value={row.player.ownership ?? null} places={0} dim />
        </span>
      </button>
    );
  };

  return (
    <section style={{ fontFamily: SANS, color: S.ink }}>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 720 }}>
          {header}
          {sorted.map((row) => line(row, false))}

          <div style={{
            display: "flex", alignItems: "baseline", gap: 10,
            padding: "9px 6px 7px", background: S.inset,
            borderTop: `1px solid ${S.rule}`, borderBottom: `1px solid ${S.hair}`,
          }}>
            <span style={{ ...EYEBROW, color: S.ink3 }}>Bench</span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: S.ink3 }}>
              {/* Not "autosub order": FPL's autosub depends on who blanks and
                  which formations stay legal after they do, and nothing here
                  solves that. */}
              the four left out, best first — not FPL&apos;s autosub order
            </span>
          </div>
          {benchSorted.map((row) => line(row, true))}
        </div>
      </div>

      <p style={{
        fontFamily: MONO, fontSize: 10, color: S.ink3,
        margin: 0, padding: "9px 6px 0", lineHeight: 1.6,
      }}>
        Click any row to move a player between the eleven and the bench; every total
        recomputes. The bar is the middle half of his simulated range on one fixed
        0–{INTERVAL_AXIS} axis, so two rows compare — a mean alone cannot tell you
        whether a captain&apos;s tail is worth his downside.
      </p>
    </section>
  );
}
