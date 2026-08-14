"use client";

/**
 * Matches — what the model thinks of each fixture, and where the league stands.
 *
 * Two artifacts, two independent sections (Rule 2). Both have a degenerate state
 * that the committed data is currently in, and both are handled by the descriptor
 * rather than by a check written here:
 *
 * * **`matches`** is `empty` when every fixture predicts `home`. Before team
 *   strengths are fitted the flat prior leaves home advantage as the only
 *   surviving signal, so ten identical calls is the fingerprint of a model with no
 *   information — not a forecast that the home side wins everywhere.
 * * **`table`** is `empty` when no match has been played. Every counter is zero
 *   AND every `position` is zero in the committed file, so the old
 *   `if (pos <= 4)` gate put all twenty clubs in the Champions League places.
 *   `deriveZone` takes the whole table so that question cannot be asked.
 */

import { REGISTRY } from "@/lib/data/narrow";
import { useArtifact } from "@/lib/data/useArtifact";
import FixtureMatrix from "@/components/FixtureMatrix";
import { ProvenanceStrip, Section, WhenProven } from "@/components/data/Artifact";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { deriveZone } from "@/lib/standings";
import type { MatchesFile, Standing } from "@/lib/data/narrow";

const ZONE_COLOUR: Record<string, string> = {
  champions: "#22c55e",
  europa: "#38bdf8",
  conference: "#a78bfa",
  relegation: "#f87171",
};

function Fixtures({ file }: { file: MatchesFile }) {
  return (
    <div className="glass-panel rounded-none overflow-x-auto">
      <table className="data-table" aria-label="Fixtures and model calls">
        <thead>
          <tr>
            <th scope="col">Fixture</th>
            <th scope="col" className="text-center">Call</th>
            <th scope="col" className="text-center">Confidence</th>
            <th scope="col" className="hidden sm:table-cell">Referee</th>
          </tr>
        </thead>
        <tbody>
          {file.matches.map((match) => (
            <tr key={match.match_id} data-testid="fixture">
              <td className="text-sm">
                {match.home_team} v {match.away_team}
              </td>
              <td className="text-center text-sm">{match.model_prediction}</td>
              <td className="text-center font-mono text-sm">
                {match.confidence_pct.toFixed(0)}%
              </td>
              <td className="text-sm hidden sm:table-cell" style={{ color: "var(--text-3)" }}>
                {/* Null on some fixtures and a string on others. The
                    referee-conditioned card model degrades gracefully by design,
                    so absence is expected rather than a fault. */}
                {match.referee ?? "not appointed"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One result in the form guide.
 *
 * The letter carries the meaning and the colour reinforces it, so the guide is
 * still readable without colour vision — the same reason `edgePrefix()` exists
 * elsewhere in this app.
 */
function FormDot({ result }: { result: string }) {
  const colour: Record<string, string> = {
    W: "#22c55e", D: "#94a3b8", L: "#f87171",
  };
  const label: Record<string, string> = {
    W: "Win", D: "Draw", L: "Loss",
  };
  return (
    <span
      className="inline-flex w-4 h-4 rounded-none text-[8px] font-bold items-center justify-center text-[var(--bg)] flex-shrink-0"
      style={{ background: colour[result] ?? "#334155" }}
      title={label[result] ?? result}
    >
      {result}
    </span>
  );
}

function LeagueTable({ rows }: { rows: readonly Standing[] }) {
  return (
    <div className="glass-panel rounded-none overflow-x-auto">
      <table className="data-table" aria-label="Premier League standings">
        <thead>
          <tr>
            <th scope="col" className="w-8 text-center">#</th>
            <th scope="col">Club</th>
            <th scope="col" className="text-center">P</th>
            <th scope="col" className="text-center hidden sm:table-cell">W</th>
            <th scope="col" className="text-center hidden sm:table-cell">D</th>
            <th scope="col" className="text-center hidden sm:table-cell">L</th>
            <th scope="col" className="text-center hidden lg:table-cell">GF</th>
            <th scope="col" className="text-center hidden lg:table-cell">GA</th>
            <th scope="col" className="text-center">GD</th>
            <th scope="col" className="text-center font-bold">Pts</th>
            <th scope="col" className="hidden md:table-cell">Form</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((club) => {
            // Takes the whole table, so "highlight a zone before a ball is
            // kicked" is not expressible.
            const zone = deriveZone(club, rows);
            const colour = zone ? ZONE_COLOUR[zone] : undefined;
            return (
              <tr
                key={club.team}
                data-zone={zone ?? "none"}
                style={colour ? { borderLeft: `3px solid ${colour}` } : undefined}
              >
                <td className="text-center font-mono text-xs" style={{ color: colour }}>
                  {club.position}
                </td>
                <td className="text-sm">{club.team}</td>
                <td className="text-center font-mono text-sm">{club.played}</td>
                <td className="text-center font-mono text-sm hidden sm:table-cell"
                    style={{ color: "var(--success)" }}>{club.won}</td>
                <td className="text-center font-mono text-sm hidden sm:table-cell">{club.drawn}</td>
                <td className="text-center font-mono text-sm hidden sm:table-cell"
                    style={{ color: "var(--error)" }}>{club.lost}</td>
                <td className="text-center font-mono text-sm hidden lg:table-cell">{club.gf}</td>
                <td className="text-center font-mono text-sm hidden lg:table-cell">{club.ga}</td>
                <td className="text-center font-mono text-sm">{club.gd}</td>
                <td className="text-center font-mono text-sm font-bold">{club.points}</td>
                <td className="hidden md:table-cell">
                  {/* Empty pre-season rather than a row of placeholder dots: an
                      invented form guide is the same lie as an invented zone. */}
                  <div className="flex gap-1" data-testid="form">
                    {club.form.map((result, i) => (
                      <FormDot key={`${club.team}-${i}`} result={result} />
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function MatchesPage() {
  const { artifact: matches } = useArtifact<MatchesFile>(REGISTRY.matches);
  const { artifact: table } = useArtifact<readonly Standing[]>(REGISTRY.table);

  return (
    <ErrorBoundary pageName="Matches">
      <div className="space-y-8">
        <header>
          <h1
            className="text-3xl font-extrabold tracking-tight"
            style={{ color: "var(--text-1)", fontFamily: "var(--font-display)" }}
          >
            Matches
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            This gameweek&apos;s fixtures, and where the league stands
          </p>
        </header>

        
        {/* The fixture grid leads.
            It is the view Solio and FPL Review both put first, and the question a
            manager asks when drafting: who has the kindest opening run. FPL's
            difficulty was on every request already, exposed only inside individual
            players, so the league-wide picture existed nowhere. */}
        <Section
          title="Fixture difficulty"
          subtitle="Every club's next eight, kindest run first"
        >
          <FixtureMatrix />
        </Section>
<Section title="Fixtures" aside={<ProvenanceStrip of={matches} />}>
          <WhenProven
            of={matches}
            what="Every fixture is currently predicted 'home', which is what a model with no fitted team strengths produces — not a forecast that the home side wins everywhere."
            then={(file) => <Fixtures file={file} />}
          />
        </Section>

        <Section
          title="League table"
          subtitle="Qualification zones appear once matches have been played."
          aside={<ProvenanceStrip of={table} />}
        >
          <WhenProven
            of={table}
            what="No matches have been played. Positions are provisional and no qualification or relegation zones are shown."
            // Shown anyway: 20 rows of clubs are still worth seeing pre-season.
            // `deriveZone` is what keeps them from being highlighted.
            showEmpty
            then={(rows) => <LeagueTable rows={rows} />}
          />
        </Section>
      </div>
    </ErrorBoundary>
  );
}
