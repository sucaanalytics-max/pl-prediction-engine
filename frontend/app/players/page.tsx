"use client";

/**
 * Players — who, and how sure are we.
 *
 * ## The per-90 trap
 *
 * `xg_per_90` is computed upstream as `xg / max(minutes / 90, 0.1)`. That floor
 * means a player with **zero minutes** reads as `xg * 10` — a fabricated rate,
 * rendered in the same column and the same typeface as measured ones. The
 * narrower therefore carries `ratesAreMeaningful` per row, and this screen
 * suppresses the per-90 columns rather than showing a number it cannot stand
 * behind.
 *
 * ## Nulls stay null
 *
 * `fouls_committed` and `fouls_per_90` are **null on all 564 rows** of the
 * committed artifact while `PlayerStat` types both as `number`. Coercing them to
 * zero would report "committed no fouls" for a stat the provider never supplied —
 * 564 rows of confident zero being a far more convincing lie than 564 blanks.
 */

import { useMemo, useState } from "react";
import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import { ProvenanceStrip, Section, WhenProven } from "@/components/data/Artifact";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MIN_MINUTES_FOR_RATES, type PlayerRow } from "@/lib/data/narrow";

const PAGE_SIZE = 50;

/** A measured value, or an honest blank. Never a coerced zero. */
function Stat({ value, digits = 0 }: { value: number | null; digits?: number }) {
  return value === null ? (
    <span style={{ color: "var(--text-4)" }} title="not supplied by the provider">
      —
    </span>
  ) : (
    <>{value.toFixed(digits)}</>
  );
}

function PlayersTable({ rows }: { rows: readonly PlayerRow[] }) {
  const [sortByRate, setSortByRate] = useState(false);

  const shown = useMemo(() => {
    const sorted = [...rows].sort((a, b) =>
      sortByRate
        // Rows whose rates are meaningless sort last rather than topping the
        // table on a denominator artefact.
        ? Number(b.ratesAreMeaningful) - Number(a.ratesAreMeaningful)
          || b.xg / Math.max(b.minutes / 90, 1) - a.xg / Math.max(a.minutes / 90, 1)
        : b.minutes - a.minutes,
    );
    return sorted.slice(0, PAGE_SIZE);
  }, [rows, sortByRate]);

  const suppressed = rows.filter((r) => !r.ratesAreMeaningful).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs" style={{ color: "var(--text-3)" }}>
          Showing {shown.length} of {rows.length}
          {suppressed > 0
            ? ` · per-90 rates hidden for ${suppressed} player${suppressed === 1 ? "" : "s"} under ${MIN_MINUTES_FOR_RATES} minutes`
            : ""}
        </p>
        <button
          type="button"
          className="text-xs underline"
          style={{ color: "var(--accent)" }}
          onClick={() => setSortByRate((v) => !v)}
        >
          Sort by {sortByRate ? "minutes" : "xG per 90"}
        </button>
      </div>

      <div className="glass-panel rounded-2xl overflow-x-auto">
        <table className="data-table" aria-label="Player season statistics">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Team</th>
              <th scope="col" className="text-center">Mins</th>
              <th scope="col" className="text-center">G</th>
              <th scope="col" className="text-center">A</th>
              <th scope="col" className="text-center">xG</th>
              <th scope="col" className="text-center hidden sm:table-cell">xA</th>
              <th scope="col" className="text-center hidden md:table-cell">xG/90</th>
              <th scope="col" className="text-center hidden lg:table-cell">Fouls</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={`${row.name}-${row.team}`} data-testid="player">
                <td className="text-sm">{row.name}</td>
                <td className="text-sm" style={{ color: "var(--text-3)" }}>
                  {row.team}
                </td>
                <td className="text-center font-mono text-sm">{row.minutes}</td>
                <td className="text-center font-mono text-sm">{row.goals}</td>
                <td className="text-center font-mono text-sm">{row.assists}</td>
                <td className="text-center font-mono text-sm">{row.xg.toFixed(2)}</td>
                <td className="text-center font-mono text-sm hidden sm:table-cell">
                  {row.xa.toFixed(2)}
                </td>
                <td
                  className="text-center font-mono text-sm hidden md:table-cell"
                  data-rates={row.ratesAreMeaningful ? "shown" : "suppressed"}
                >
                  {/* Suppressed below the minutes floor: the denominator clamp
                      turns a 0-minute player's xG into xG x 10. */}
                  {row.ratesAreMeaningful ? (
                    (row.xg / (row.minutes / 90)).toFixed(2)
                  ) : (
                    <span
                      style={{ color: "var(--text-4)" }}
                      title={`under ${MIN_MINUTES_FOR_RATES} minutes — a per-90 rate here is an artefact of the denominator floor`}
                    >
                      —
                    </span>
                  )}
                </td>
                <td className="text-center font-mono text-sm hidden lg:table-cell">
                  <Stat value={row.fouls_committed} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PlayersPage() {
  const { artifact } = useArtifact<readonly PlayerRow[]>(REGISTRY.playerStats);

  return (
    <ErrorBoundary pageName="Players">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-jakarta)" }}
          >
            Players
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Season actuals. A dash means the provider supplied nothing, not zero.
          </p>
        </header>

        <Section title="Season statistics" aside={<ProvenanceStrip of={artifact} />}>
          <WhenProven
            of={artifact}
            what="No player has played a minute yet, so there are no season statistics to show."
            then={(rows) => <PlayersTable rows={rows} />}
          />
        </Section>
      </div>
    </ErrorBoundary>
  );
}
