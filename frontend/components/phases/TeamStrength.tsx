"use client";

/**
 * Attack and defence as a second provider measured them.
 *
 * ## Why it lives on /phases and not on a route of its own
 *
 * This page already answers "who in the LEAGUE has the kindest run", and its own
 * docstring gives the reason that decides where this belongs: *"Projections are
 * simulated; a fixture list is published. Keeping the two apart means neither
 * borrows the other's authority."*
 *
 * A measured rate is a **third** warrant, distinct from both — so it sits beside
 * the fixture matrix, labelled with its provider, answering the same buying
 * question from an independent angle. A new route would also have been a red
 * build: `test/nav-coverage.test.tsx` holds the surface to an allow-list of eight
 * because three separate specs prescribed cutting routes and none was executed.
 *
 * ## The withheld rank is the feature
 *
 * Every club has played two matches and the producer withholds a rank below
 * three, so today every rank is null. This section therefore leads with *why*
 * rather than rendering a table with an empty column. The measurement behind
 * that threshold: across the six columns of a widely-read GW3 zonal-weakness
 * thread, only 16% of the 720 team pairs were separable at 95% from two matches.
 *
 * Both figures are shown once ranks exist — the club's own rate and the rate
 * shrunk toward the league mean — because the gap between them IS the sample
 * size, expressed in the units the reader already understands.
 */

import { useArtifact } from "@/lib/data/useArtifact";
import { proven } from "@/lib/data/artifact";
import { REGISTRY } from "@/lib/data/narrow";
import { StateCard } from "@/components/data/Artifact";
import { FLOODLIT, MONO, SANS } from "@/lib/margin/tokens";

const S = FLOODLIT;

/** One decimal, or an em dash — never a substituted zero. */
function num(value: number | null, digits = 2): string {
  return value === null ? "—" : value.toFixed(digits);
}

export function TeamStrength() {
  const { artifact } = useArtifact(REGISTRY.teamMetrics);
  const view = proven(artifact);

  // Absence never outweighs substance: one line, not a panel.
  if (!view) {
    return <StateCard of={artifact} weight="line" what="attack and defence, measured" />;
  }

  if (view.teams.length === 0) {
    return (
      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        No club has been measured yet this season.
      </p>
    );
  }

  const ranked = view.teams.filter((t) => t.attackRank !== null);
  const showRanks = ranked.length > 0;
  const rows = showRanks
    ? [...ranked].sort((a, b) => (a.attackRank ?? 99) - (b.attackRank ?? 99))
    : [...view.teams].sort(
        (a, b) => (b.npxgForShrunk ?? -1) - (a.npxgForShrunk ?? -1),
      );

  return (
    <div className="space-y-3">
      {!showRanks && (
        <p className="text-xs" style={{ color: S.noise, fontFamily: SANS }}>
          <strong>Not yet measurable.</strong> Every club has played{" "}
          {view.teams[0]?.matches ?? 0} matches and a rank needs{" "}
          {view.minMatchesForRank ?? 3} — three matches — so none is shown. Two
          games cannot separate twenty teams: on a comparable six-column table,
          only 16% of the 720 club pairs were distinguishable at 95%. The rates
          below are real; the ordering would not be.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full" style={{ fontFamily: MONO, fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-3)" }}>
              {showRanks && <th className="text-left pr-3 pb-1">#</th>}
              <th className="text-left pr-3 pb-1" style={{ fontFamily: SANS }}>Club</th>
              <th className="text-right pr-3 pb-1">M</th>
              <th className="text-right pr-3 pb-1">npxG&nbsp;for</th>
              <th className="text-right pr-3 pb-1">shrunk</th>
              <th className="text-right pr-3 pb-1">npxG&nbsp;ag.</th>
              <th className="text-right pr-3 pb-1">shrunk</th>
              <th className="text-right pr-3 pb-1">goals&nbsp;for</th>
              <th className="text-right pr-3 pb-1">goals&nbsp;ag.</th>
              <th className="text-right pr-3 pb-1">deep&nbsp;for</th>
              <th className="text-right pr-3 pb-1">deep&nbsp;ag.</th>
              <th className="text-right pb-1">PPDA</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.team}
                data-testid="team-strength-row"
                style={{ borderTop: `1px solid ${S.hair}` }}
              >
                {showRanks && (
                  <td data-testid="rank-cell" className="pr-3 py-1">
                    {t.attackRank}
                  </td>
                )}
                <td className="pr-3 py-1" style={{ fontFamily: SANS, color: S.ink }}>
                  {t.team}
                </td>
                <td className="text-right pr-3 py-1">{t.matches}</td>
                <td className="text-right pr-3 py-1">{num(t.npxgForPerMatch)}</td>
                <td className="text-right pr-3 py-1" style={{ color: S.brand }}>
                  {num(t.npxgForShrunk)}
                </td>
                <td className="text-right pr-3 py-1">{num(t.npxgAgainstPerMatch)}</td>
                <td className="text-right pr-3 py-1" style={{ color: S.brand }}>
                  {num(t.npxgAgainstShrunk)}
                </td>
                <td className="text-right pr-3 py-1">{num(t.goalsForPerMatch, 1)}</td>
                <td className="text-right pr-3 py-1">{num(t.goalsAgainstPerMatch, 1)}</td>
                <td className="text-right pr-3 py-1">{num(t.deepForPerMatch, 1)}</td>
                <td className="text-right pr-3 py-1">{num(t.deepAgainstPerMatch, 1)}</td>
                <td className="text-right py-1">{num(t.ppda, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px]" style={{ color: "var(--text-3)", fontFamily: SANS }}>
        Measured by Understat — a second, independently fitted xG model, not ours.
        It feeds no projection and no stake; the disagreement with our own numbers
        is the information. <strong>npxG</strong> excludes penalties.{" "}
        <strong>shrunk</strong> pulls a club&apos;s rate toward the league mean by
        its evidence, so a short sample reads as ordinary rather than extreme.{" "}
        <strong>goals</strong> are actual, so the gap against npxG is finishing and
        luck rather than chance quality. <strong>deep</strong> is completed passes
        near goal per match;{" "}
        <strong>PPDA</strong> is passes allowed per defensive action, where lower
        means more pressing.
      </p>
    </div>
  );
}
