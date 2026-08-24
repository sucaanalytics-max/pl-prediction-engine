"use client";

/**
 * The four figures a manager checks first, across the top of the call.
 *
 * Best XI, armband, money, transfer. Each is one number with one line of
 * qualification under it, and the qualifications are the reason the tiles are
 * worth the space: a bare "47.10" is ambiguous between two counting rules that
 * differ by a captain's worth of points, and this app has already shipped two
 * screens that disagreed by exactly that.
 *
 * ## Every total here states its counting rule
 *
 * The rule arrives as a prop from the component that did the arithmetic, because
 * a component that only formats a number cannot honestly assert how it was
 * counted. Three screens once each phrased their own caveat in their own words,
 * one of them saying nothing at all while printing a 24px figure, and the shared
 * constant plus this hand-off is what stops them drifting apart again. The armband
 * tile is the one place a doubled number appears, and it shows both halves so the
 * doubling is visible rather than assumed.
 *
 * ## The transfer tile is usually empty, and says why
 *
 * Nothing on this screen recommends a transfer. `xp_public` covers one gameweek,
 * so the gain from a swap is computable for this week only, and a sale priced on
 * one week of projection is the most confident wrong number this app could print.
 * The tile states that rather than leaving a reader to wonder whether the absence
 * means "no move needed".
 */

import { DISPLAY, FLOODLIT, MONO, SANS } from "@/lib/margin/tokens";
import { EYEBROW } from "@/lib/margin/type";

const S = FLOODLIT;

function Tile({
  label, children, note, testId,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly note: React.ReactNode;
  readonly testId?: string;
}) {
  return (
    <div data-testid={testId} style={{ background: S.bar, padding: "14px 16px" }}>
      <div style={{ ...EYEBROW, color: S.ink3, marginBottom: 7 }}>{label}</div>
      {children}
      <div style={{
        fontFamily: MONO, fontSize: 10.5, color: S.ink2, marginTop: 7, lineHeight: 1.4,
      }}>
        {note}
      </div>
    </div>
  );
}

function Big({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: DISPLAY, fontSize: 36, lineHeight: 0.9 }}>
      {children}
    </span>
  );
}

export interface TilesProps {
  /** The total of the eleven on screen. Null when nothing is projected. */
  readonly total: number | null;
  /** The total of the eleven FPL currently has starting, or null if unknown. */
  readonly asPicked: number | null;
  readonly shape: string;
  readonly captainName: string | null;
  readonly captainXp: number | null;
  readonly captainHaul: number | null;
  readonly squadValue: number | null;
  readonly bank: number | null;
  readonly freeTransfers: number | null;
  /**
   * How the Best XI total was counted, in the words of whoever counted it.
   *
   * Passed in rather than imported here, and that is the point: this component
   * formats a number it did not compute, so it is in no position to assert how the
   * captain was treated. `CallBoard` calls `projectedTotal` and therefore knows,
   * and `lib/margin/counting-rule.test.ts` scans for exactly that pairing — the
   * rule must sit with the arithmetic, not with the typography.
   */
  readonly countingRule: string;
}

export function Tiles(props: TilesProps) {
  const {
    total, asPicked, shape, captainName, captainXp, captainHaul,
    squadValue, bank, freeTransfers, countingRule,
  } = props;

  const delta = total !== null && asPicked !== null ? total - asPicked : null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
      gap: 1,
      background: S.rule,
      borderBottom: `1px solid ${S.rule}`,
      fontFamily: SANS,
      color: S.ink,
    }}>
      <Tile
        label="Best XI"
        testId="tile-xi"
        note={
          asPicked === null
            // Not "from 0.00 as picked". Before a lineup is known, nobody has
            // said who starts, and a delta against a total of fifteen players
            // would flatter the optimiser by 40%.
            ? <>no lineup on file to improve on · {shape} · XI total, {countingRule}</>
            : <>from {asPicked.toFixed(2)} as picked · {shape} · XI total, {countingRule}</>
        }
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 11 }}>
          <Big>{total === null ? "—" : total.toFixed(2)}</Big>
          {delta === null ? null : (
            <span
              data-testid="tile-xi-delta"
              style={{
                fontFamily: MONO, fontSize: 13, padding: "2px 7px",
                background: delta >= 0 ? "rgba(120,220,140,.14)" : "rgba(255,90,70,.16)",
                color: delta >= 0 ? S.agree : S.conflict,
              }}
            >
              {delta >= 0 ? "+" : ""}{delta.toFixed(2)}
            </span>
          )}
        </div>
      </Tile>

      <Tile
        label="Armband"
        testId="tile-armband"
        note={
          captainXp === null
            ? "no projection for the captain, so no doubled figure"
            : <>
                {captainXp.toFixed(2)} → <span style={{ color: S.brand }}>
                  {(captainXp * 2).toFixed(2)}
                </span> doubled
                {captainHaul === null
                  ? null
                  : <> · haul odds {Math.round(captainHaul * 100)}%</>}
              </>
        }
      >
        <span style={{ fontFamily: DISPLAY, fontSize: 22, lineHeight: 1.1 }}>
          {captainName ?? "None"}
        </span>
      </Tile>

      <Tile
        label="Squad"
        testId="tile-squad"
        note={
          <>
            {bank === null ? "bank unknown" : `£${bank.toFixed(1)} in the bank`}
            {" · "}
            {freeTransfers === null
              ? "free transfers unknown"
              : `${freeTransfers} free transfer${freeTransfers === 1 ? "" : "s"}`}
          </>
        }
      >
        <Big>{squadValue === null ? "—" : `£${squadValue.toFixed(1)}`}</Big>
      </Tile>

      <Tile
        label="Transfer"
        testId="tile-transfer"
        note="No transfer is suggested: one published week cannot price a sale."
      >
        <span style={{ fontFamily: DISPLAY, fontSize: 22, lineHeight: 1.1, color: S.ink2 }}>
          None
        </span>
      </Tile>
    </div>
  );
}
